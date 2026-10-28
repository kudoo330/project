import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {researchDownloadsApi} from '../src/research-downloads';

test('prepared private downloads round-trip across D1 parts; validation, replay, integrity and expiry',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'downloads-test'}}));
 try{
  const db=await mf.getD1Database('DB');
  for(const file of ['0001_initial.sql','0009_research_downloads.sql']){const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  const call=(path='',value?:any)=>{const url=new URL('https://research.test/api/research-downloads'+path);return researchDownloadsApi(new Request(url,value===undefined?{}:{method:'POST',body:JSON.stringify(value)}),{DB:db} as any,url,'admin:download-test');};
  const bytes=Buffer.alloc(700000,42);bytes.set([0x50,0x4b,3,4]);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const value={filename:'synthetic-market-test.zip',title:'Synthetic test, not actual quotes',sha256:hash,data_base64:bytes.toString('base64')};
  assert.equal((await call('',{...value,filename:'../unsafe.zip'})).status,400);
  assert.equal((await call('',{...value,sha256:'0'.repeat(64)})).status,400);
  assert.equal((await call('',{...value,data_base64:'!!!!'})).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_downloads').first<any>())!.n,0);
  const created=await call('',value);assert.equal(created.status,201);const file=(await created.json() as any).file;
  assert.equal(file.id,'download_'+hash);assert.equal(file.byte_length,bytes.length);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_download_parts').first<any>())!.n,4);
  assert.equal((await(await call('',value)).json() as any).replayed,true);
  assert.equal((await call('',{...value,title:'conflicting title'})).status,409);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit WHERE action='prepare_research_download'").first<any>())!.n,1);
  const download=await call('/'+file.id);assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/zip');assert.match(download.headers.get('content-disposition')!,/attachment/);assert.equal(download.headers.get('x-content-sha256'),hash);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await(await call()).json() as any).files.length,1);
  await db.prepare('UPDATE research_download_parts SET data_base64=? WHERE download_id=? AND part=0').bind(Buffer.alloc(192*1024).toString('base64'),file.id).run();
  assert.equal((await call('/'+file.id)).status,503,'never serve corrupted contents');
  await db.prepare("UPDATE research_downloads SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(file.id).run();
  assert.equal((await call('/'+file.id)).status,410);assert.equal((await(await call()).json() as any).files.length,0);
  assert.equal((await call('/download_'+'f'.repeat(64))).status,404);
 }finally{await mf.dispose();}
});

test('download preparation is atomic if the final audit write fails',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'downloads-rollback-test'}}));
 try{
  const db=await mf.getD1Database('DB');
  for(const file of ['0001_initial.sql','0009_research_downloads.sql']){const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  await db.prepare("CREATE TRIGGER fail_download_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  const bytes=Buffer.from([0x50,0x4b,3,4,1,2]),url=new URL('https://research.test/api/research-downloads');
  const body={filename:'fixture.zip',title:'Synthetic rollback fixture',sha256:createHash('sha256').update(bytes).digest('hex'),data_base64:bytes.toString('base64')};
  const r=await researchDownloadsApi(new Request(url,{method:'POST',body:JSON.stringify(body)}),{DB:db} as any,url,'admin:fixture');assert.equal(r.status,503);
  for(const table of ['research_downloads','research_download_parts','audit'])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<any>())!.n,0);
 }finally{await mf.dispose();}
});

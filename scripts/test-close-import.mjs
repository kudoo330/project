import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'close-import-')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
try{
 await build({entryPoints:['src/verified-close-import.ts'],outfile:join(dir,'import.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {importVerifiedCloses}=await import(pathToFileURL(join(dir,'import.mjs')).href),db=await mf.getD1Database('DB');
 await db.batch((await readFile('migrations/0001_initial.sql','utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 await db.prepare("INSERT INTO batches VALUES('test','admin','2026-10-16','test')").run();
 for(const id of ['a','b'])await db.prepare("INSERT INTO records(id,batch_id,strategy_id,symbol,buy_time,original_time,reference_price,reference_evidence,created_at,updated_at) VALUES(?,'test',?,'300111.SZ','2026-10-16T09:40:00','original',10,'original-reference','2026-10-16','2026-10-16')").bind(id,id==='a'?'898':'twenty-minute').run();
 const bar={date:'2026-10-16',open:10,close:10.5,high:11,low:9,volume:100};const quote={symbol:'300111.SZ',bars:[bar],secondary:[bar],primaryProvider:'新浪',secondaryProvider:'腾讯',evidence:{provider:'synthetic fixture'},fetchedAt:new Date().toISOString()};
 const result=await importVerifiedCloses(db,{quotes:[quote]},'test-admin');assert.equal(result.updated,2);assert.equal(result.conflicts,0);
 for(const row of (await db.prepare('SELECT * FROM records').all()).results){assert.equal(row.reference_price,10);assert.equal(row.reference_evidence,'original-reference');assert.equal(row.original_time,'original');assert.equal(row.revision,2);const data=JSON.parse(row.market_data);assert.equal(data.bars[0].close,10.5);assert.deepEqual(data.bars[0].crossCheck.sources,['新浪','腾讯']);}
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit').first()).n,2);
 await assert.rejects(()=>importVerifiedCloses(db,{quotes:[{...quote,secondary:[{...bar,close:10.6}]}]},'test-admin'));
 assert.equal((await db.prepare('SELECT revision FROM records LIMIT 1').first()).revision,2);
 const outside={...quote,bars:[{...bar,date:'2026-10-15'}],secondary:[{...bar,date:'2026-10-15'}]};await assert.rejects(()=>importVerifiedCloses(db,{quotes:[outside]},'test-admin'));
 console.log('PASS: verified close import updates cross-strategy samples, preserves P0/evidence/original time, audits changes, rejects conflicts and out-of-window prices');
}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}

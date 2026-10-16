// Isolated D1 integration test; synthetic data only, never contacts production.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'reviewed-import-'));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("isolated")}}',d1Databases:['DB']}));
try{
 await build({entryPoints:['src/reviewed-import.ts'],outfile:join(dir,'import.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {importReviewed}=await import(pathToFileURL(join(dir,'import.mjs')).href),db=await mf.getD1Database('DB');
 await db.batch((await readFile('migrations/0001_initial.sql','utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 const date=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,19);
 const rows=Array.from({length:223},(_,i)=>({strategy:'TEST-'+i%4,symbol:String(300000+i).padStart(6,'0')+'.SZ',name:'Synthetic fixture',buy_time:date,original_time:i===0?'original-12:59:56':date,reference_price:20+i/100,reference_evidence:{provider:'test fixture',cross_verified:false}}));
 const user={username:'test-admin',role:'admin'},body={request_id:'reviewed-integration-223',rows};
 assert.equal((await importReviewed(db,body,user)).count,223);
 const count=async()=>Number((await db.prepare('SELECT COUNT(*) AS n FROM records').first()).n);
 assert.equal(await count(),223);const first=await db.prepare('SELECT * FROM records WHERE symbol=?').bind(rows[0].symbol).first();assert.equal(first.reference_price,20);assert.equal(first.actual_price,null);assert.equal(first.original_time,'original-12:59:56');assert.equal(JSON.parse(first.reference_evidence).provider,'test fixture');
 assert.equal((await importReviewed(db,body,user)).replayed,true);assert.equal(await count(),223);
 assert.equal((await importReviewed(db,{...body,request_id:'duplicate-new-batch'},user)).status,409);assert.equal(await count(),223);
 assert.equal((await importReviewed(db,{...body,rows:[{...rows[0],reference_price:99}]},user)).status,409);
 // A database failure must roll back the batch marker and newly created strategy.
 await db.prepare("CREATE TRIGGER reject_fixture BEFORE INSERT ON records WHEN NEW.name='REJECT-FIXTURE' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END").run();
 await assert.rejects(()=>importReviewed(db,{request_id:'rollback-integration-223',rows:[{...rows[0],strategy:'ROLLBACK-STRATEGY',name:'REJECT-FIXTURE'}]},user));
 assert.equal(await db.prepare("SELECT id FROM batches WHERE id='rollback-integration-223'").first(),null);assert.equal(await db.prepare("SELECT id FROM strategies WHERE name='ROLLBACK-STRATEGY'").first(),null);assert.equal(await count(),223);
 console.log('PASS: 223-row atomic import; strategy creation; separate reference/actual prices; provenance; original time; idempotency; duplicate rejection; rollback');
}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}

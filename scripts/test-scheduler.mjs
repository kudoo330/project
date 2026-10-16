// Isolated real D1 emulator, deterministic provider fixtures; never contacts production.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'close-sync-test-'));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("isolated test")}}',d1Databases:['DB']}));
try{
  await build({entryPoints:['src/close-sync.ts'],outfile:join(dir,'runner.mjs'),bundle:true,platform:'node',format:'esm',loader:{'.sql':'text'},logLevel:'silent'});
  const {runCloseSync}=await import(pathToFileURL(join(dir,'runner.mjs')).href),db=await mf.getD1Database('DB'),env={DB:db};
  const sql=await readFile('migrations/0001_initial.sql','utf8');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  await db.prepare("INSERT INTO batches VALUES('test','admin','2026-10-15','test')").run();
  const bar=(date,close)=>({date,close,open:close,high:close,low:close,volume:100,crossCheck:{status:"matched",sources:["test source A","test source B"],checkedAt:"2026-10-16T08:05:00Z"}});
  const add=async(id,strategy,symbol)=>db.prepare(`INSERT INTO records(id,batch_id,strategy_id,symbol,buy_time,original_time,market_data,fetched_at,created_at,updated_at) VALUES(?,'test',?,?,'2026-10-15T09:47:00','2026-10-15T09:47:00',?,'2026-10-15T08:05:00Z','2026-10-15T08:00:00Z','2026-10-15T08:00:00Z')`).bind(id,strategy,symbol,JSON.stringify({bars:[bar('2026-10-15',3)]})).run();
  await add('a','twenty-minute','300111.SZ');await add('b','898','300111.SZ');
  let calls=0;const quote=(symbol,bars,time)=>({code:symbol.split('.')[0],name:'TEST FIXTURE',bars,fetchedAt:time,cached:false,provider:'deterministic test fixture',adjustment:'test only',validation:bars.map(b=>({date:b.date,status:'matched',primaryClose:b.close,secondaryClose:b.close})),corporateSource:{status:'available',factors:[{date:'1900-01-01',factor:1}],qfq:bars,fetchedAt:time}});
  let result=await runCloseSync(env,new Date('2026-10-16T08:05:00Z'),async(e,symbol,force)=>{calls++;assert.equal(force,true);return quote(symbol,[bar('2026-10-15',3),bar('2026-10-16',3.1)],'2026-10-16T08:05:00Z');});
  assert.equal(result.status,'success');assert.equal(calls,1);assert.equal(result.succeeded,1);
  for(const id of ['a','b']){const row=await db.prepare('SELECT * FROM records WHERE id=?').bind(id).first();assert.equal(JSON.parse(row.market_data).bars.at(-1).date,'2026-10-16');assert.equal(row.actual_price,null);}
  console.log('PASS: yesterday records updated without a browser; cross-strategy fetch deduplication; P0 unchanged');
  calls=0;await runCloseSync(env,new Date('2026-10-16T08:15:00Z'),async()=>{calls++;throw new Error('should not call');});assert.equal(calls,0);console.log('PASS: repeated cron does not refetch already complete closes');
  await add('c','898','688265.SH');
  result=await runCloseSync(env,new Date('2026-10-16T08:25:00Z'),async(e,symbol)=>quote(symbol,[bar('2026-10-15',3)],'2026-10-16T08:25:00Z'));
  assert.equal(result.status,'partial');assert.equal(result.failed,1);assert.equal(result.remaining,1);const partial=await db.prepare("SELECT * FROM records WHERE id='c'").first();assert.equal(JSON.parse(partial.market_data).bars.some(b=>b.date==='2026-10-16'),false);assert.match(partial.error,/缺少/);console.log('PASS: missing current close remains incomplete, no fake zero or carried-forward bar');
  const before=(await db.prepare('SELECT id,market_data FROM records ORDER BY id').all()).results;
  result=await runCloseSync(env,new Date('2026-10-19T08:05:00Z'),async()=>{throw new Error('fixture network failure');});assert.equal(result.status,'partial');assert.equal(result.failed,2);const after=(await db.prepare('SELECT id,market_data FROM records ORDER BY id').all()).results;assert.deepEqual(after,before);console.log('PASS: network failures retain prior quotes and timestamps');
  result=await runCloseSync(env,new Date('2026-10-19T08:15:00Z'),async(e,symbol)=>quote(symbol,['2026-10-15','2026-10-16','2026-10-19'].map(d=>bar(d,3)),'2026-10-19T08:15:00Z'));assert.equal(result.status,'success');assert.equal((await db.prepare('SELECT count(*) AS n FROM records WHERE error IS NOT NULL').first()).n,0);console.log('PASS: later cron backfills missed dates and clears per-record errors');
  await db.prepare("INSERT INTO close_sync_runs(id,trade_date,started_at,status) VALUES('blocking','2026-10-19','2026-10-19T08:20:00.000Z','running')").run();
  result=await runCloseSync(env,new Date('2026-10-19T08:25:00Z'));assert.equal(result.status,'overlap_skipped');console.log('PASS: overlapping scheduled runs are locked');
}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}

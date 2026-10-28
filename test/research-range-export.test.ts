import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {researchRangeExport} from '../src/research-range-export';

test('range CSV exports beyond the old 5000-row limit, exact inclusive minutes, sessions, daily data and blank prices',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'range-export-test'}}));
 try{
  const db=await mf.getD1Database('DB'),sql=await readFile(new URL('../migrations/0005_research_data.sql',import.meta.url),'utf8');await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const id='market_'+'e'.repeat(64);await db.prepare("INSERT INTO research_market_datasets(id,symbol,period,provider,adjustment,time_zone,currency,revision,created_at,updated_at) VALUES(?,'AMD.US','1m','=Synthetic export fixture','none','America/New_York','USD',2,'now','now')").bind(id).run();
  await db.prepare("INSERT INTO research_market_import_batches VALUES('fixture',?,'hash','{}','test','Synthetic only','','{}',2,'now')").bind(id).run();
  await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<6000)
   INSERT INTO research_market_bars(dataset_id,time_key,original_time,trading_date,session,open,high,low,close,volume,status,reason,original_values_json,source_note,revision,import_batch_id,updated_at)
   SELECT ?,strftime('%Y-%m-%dT%H:%M:00.000Z','2026-10-01T11:00:00Z','+'||i||' minutes'),strftime('%Y-%m-%dT%H:%M:00.000Z','2026-10-01T11:00:00Z','+'||i||' minutes'),substr(strftime('%Y-%m-%dT%H:%M:00.000Z','2026-10-01T11:00:00Z','+'||i||' minutes'),1,10),CASE WHEN i<2 THEN 'pre' ELSE 'regular' END,CASE WHEN i=2 THEN NULL ELSE 10 END,CASE WHEN i=2 THEN NULL ELSE 11 END,CASE WHEN i=2 THEN NULL ELSE 9 END,CASE WHEN i=2 THEN NULL ELSE 10 END,CASE WHEN i=2 THEN NULL ELSE 0 END,CASE WHEN i=2 THEN 'missing' ELSE 'available' END,CASE WHEN i=2 THEN 'fixture missing' ELSE '' END,'{}','Synthetic export bound test, not calendar data',1,'fixture','now' FROM seq`).bind(id).run();
  const call=(q:string)=>researchRangeExport({DB:db} as any,new URL('https://fixture.test/api/research-data/export-range?dataset_id='+id+'&'+q));
  const all=await call('start=2026-10-01&end=2026-10-10');assert.equal(all.status,200);assert.equal(all.headers.get('x-export-rows'),'6001');const text=await all.text();assert.equal(text.trim().split('\r\n').length,6002);assert.match(text,/'=Synthetic export fixture/,'CSV formula-safe provider');assert.match(text,/"missing","fixture missing"/);
  const pre=await call('start=2026-10-01&end=2026-10-10&sessions=pre');assert.equal(pre.headers.get('x-export-rows'),'2');
  const exact=await call('start=2026-10-01T11:01:00Z&end=2026-10-01T11:02:00Z');assert.equal(exact.headers.get('x-export-rows'),'2');const exactText=await exact.text();assert.match(exactText,/07:01/);assert.match(exactText,/07:02/);assert.doesNotMatch(exactText,/07:00/);
  assert.equal((await call('start=2026-10-02&end=2026-10-01')).status,400);assert.equal((await call('start=2026-10-01&end=2026-10-10&sessions=unknown')).status,400);
  await db.prepare("UPDATE research_market_datasets SET period='1d' WHERE id=?").bind(id).run();
  const daily=await call('start=2026-10-01&end=2026-10-01&sessions=regular');assert.equal(daily.status,200);assert.ok(Number(daily.headers.get('x-export-rows'))>0);
 }finally{await mf.dispose();}
});

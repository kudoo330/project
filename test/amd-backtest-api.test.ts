import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {researchDataApi} from '../src/research-data';
import {amdBacktestApi} from '../src/amd-backtest-api';
import {runBacktest} from '../src/amd-backtest';

test('backtest API persists immutable snapshots, exact replay, old source correction and transaction rollback',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'amd-backtest-test'}}));
 try{
  const db=await mf.getD1Database('DB');for(const name of ['0005_research_data.sql','0008_amd_backtests.sql']){const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  const call=async(path='',value?:any)=>{const url=new URL('https://local.test/api/research/backtests'+path);return amdBacktestApi(new Request(url,{method:value?'POST':'GET',...(value?{headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})}),{DB:db} as any,url,'test-admin');};
  const source=async(symbol='AMD.US')=>{const dataset={symbol,period:'1m',provider:'Synthetic isolated API fixture',adjustment:'none',time_zone:'America/New_York',currency:'USD'},rows=Array.from({length:70},(_,i)=>({time:new Date(Date.parse('2026-10-27T13:30:00Z')+i*60000).toISOString(),open:50,high:51,low:49,close:i===69?60:50,volume:10000}));rows[69].high=60;
   const request=async(path:string,body:any)=>{const url=new URL('https://local.test/api/research-data'+path);return researchDataApi(new Request(url,{method:'POST',body:JSON.stringify(body)}),{DB:db} as any,url,'test-admin');};
   const payload={dataset,rows,source_note:'Synthetic, not actual market quotes'},p:any=await(await request('/preview',payload)).json();assert.equal((await request('/import',{...payload,preview_token:p.preview_token,expected_revision:p.revision,request_id:crypto.randomUUID()})).status,201);return p.dataset_id;
  };
  const id=await source(),body={minute_dataset_id:id,initial_entry_local:'2026-10-27T09:30',end_local:'2026-10-27T10:39',initial_cash_usd:1000,strategies:['BH00'],sessions:['regular'],request_id:crypto.randomUUID()};
  const response=await call('',body);assert.equal(response.status,201,await response.clone().text());const first:any=await response.json();assert.equal(first.results.length,8);assert.equal(first.results[0].summary.finalAssets,1200);
  assert.equal((await(await call('',body)).json() as any).replayed,true);assert.equal((await call('',{...body,initial_cash_usd:2000})).status,409);
  const exported:any=await(await call('/'+body.request_id+'/export')).json(),input={minutes:exported.immutableInput.filter((p:any)=>p.kind==='minutes').flatMap((p:any)=>p.rows),daily:[],minuteSource:exported.minuteSource,dailySource:exported.dailySource};
  assert.deepEqual(runBacktest(input,exported.config,exported.snapshotId).results,exported.results);
  await db.prepare('UPDATE research_market_bars SET close=49 WHERE dataset_id=?').bind(id).run();await db.prepare('UPDATE research_market_datasets SET revision=2 WHERE id=?').bind(id).run();
  assert.deepEqual((await(await call('/'+body.request_id)).json() as any).results,first.results);
  const chart:any=await(await call('/'+body.request_id+'/chart?date=2026-10-27&timeframe=1m')).json();assert.equal(chart.immutable,true);assert.equal(chart.bars[0].close,50,'saved chart must not read corrected current source');
  const continuous:any=await(await call('/'+body.request_id+'/chart?start=2026-10-01&end=2026-10-27&timeframe=15m&continuous=1')).json();assert.equal(continuous.immutable,true);assert.equal(continuous.range.page_end,'2026-10-14');assert.equal(continuous.next_cursor,'2026-10-15');
  const final:any=await(await call('/'+body.request_id+'/chart?start=2026-10-01&end=2026-10-27&timeframe=15m&continuous=1&cursor=2026-10-15')).json();assert.equal(final.next_cursor,null);assert.equal(final.bar_rows.find((r:any[])=>r[final.bar_columns.indexOf('close')]===50)[final.bar_columns.indexOf('close')],50,'continuous snapshots remain immutable');
  assert.equal((await(await call('')).json() as any).runs.length,1);
  const amdl=await source('AMDL.US');assert.equal((await call('',{...body,minute_dataset_id:amdl,request_id:crypto.randomUUID()})).status,400);
  assert.equal((await call('',{...body,strategies:['D03'],request_id:crypto.randomUUID()})).status,400);
  await db.prepare("CREATE TRIGGER snapshot_failure BEFORE INSERT ON research_backtest_parts BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END").run();
  const badId=crypto.randomUUID();assert.equal((await call('',{...body,request_id:badId})).status,503);assert.equal(await db.prepare('SELECT id FROM research_backtest_runs WHERE id=?').bind(badId).first(),null);
 }finally{await mf.dispose();}
});

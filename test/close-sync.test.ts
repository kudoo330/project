import test from 'node:test';
import assert from 'node:assert/strict';
import {syncDay,closeTargets,planCloseSync,selectCloseBatch,eligibleCloseGroups,loadCloseBatch,closeSyncSchedule} from '../src/close-sync-plan';
import type {RecordRow} from '../src/types';
import dates from '../src/calendar.json';
const record=(id:string,buy='2026-10-15',symbol='300111.SZ',bars:any[]=[])=>({id,symbol,buy_time:buy+'T09:47:00',market_data:JSON.stringify({bars}),fetched_at:'2026-10-15T08:05:00Z',actual_price:null,checked_through:null}) as RecordRow;
test('close sync uses Shanghai 16:05, market holidays and finite calendar coverage',()=>{
  assert.equal(syncDay(new Date('2026-10-16T08:04:59Z')).active,false);assert.equal(syncDay(new Date('2026-10-16T08:05:00Z')).active,true);
  assert.equal(syncDay(new Date('2026-10-17T08:05:00Z')).active,false);assert.match(syncDay(new Date('2027-01-04T08:05:00Z')).reason,/覆盖/);
});
test('yesterday purchase requires today close even without P0 or company-action check',()=>{
  const r=record('a','2026-10-15','300111.SZ',[{date:'2026-10-15',close:3,crossCheck:{status:'matched'}}]);assert.deepEqual(closeTargets(r,'2026-10-16'),['2026-10-16']);
  const intraday={...r,fetched_at:'2026-10-16T07:59:00Z',market_data:JSON.stringify({bars:[{date:'2026-10-15',close:3,crossCheck:{status:'matched'}},{date:'2026-10-16',close:4,crossCheck:{status:'matched'}}]})};assert.deepEqual(closeTargets(intraday,'2026-10-16'),['2026-10-16']);
  assert.deepEqual(closeTargets({...intraday,fetched_at:'2026-10-16T08:05:00Z'},'2026-10-16'),[]);
});
test('D+10 is included, future dates excluded and complete windows stop fetching',()=>{
  const i=dates.indexOf('2026-10-15'),window=dates.slice(i,i+11),r=record('a');assert.equal(closeTargets(r,window[10]).length,11);assert.equal(closeTargets(r,window[11]??dates[i+11]).length,11);
  const full={...r,market_data:JSON.stringify({bars:window.map(date=>({date,close:10,crossCheck:{status:'matched'}}))}),fetched_at:window[10]+'T08:05:00Z'};assert.deepEqual(closeTargets(full,dates[i+11]),[]);
  assert.deepEqual(closeTargets(r,'2026-10-14'),[]);assert.deepEqual(closeTargets(record('bj','2026-10-15','920162.BJ'),'2026-10-16'),['2026-10-15','2026-10-16']);
});
test('deduplicate market requests across strategies, retain samples, rotate failures',()=>{
  const rows=[record('a'),record('b'),record('c','2026-10-15','688265.SH')],plans=planCloseSync(rows,'2026-10-16',new Map([['300111.SZ','2026-10-16T08:05:00Z']]));
  assert.equal(plans.length,2);assert.equal(plans[0].symbol,'688265.SH');assert.equal(plans[1].records.length,2);assert.equal(rows.length,3);
});
test('batches respect D1 free query budget, including many duplicate samples',()=>{
  const rows=Array.from({length:100},(_,i)=>record(String(i))),groups=planCloseSync(rows,'2026-10-16');const selected=selectCloseBatch(groups,'2026-10-16');assert.equal(selected[0].records.length,34);assert.equal(selected[0].hasMoreRecords,true);assert.ok(selected.reduce((n,g)=>n+g.records.length+2,0)<=36);
});

test('failed symbols cool down while new symbols take priority, including new trading days',()=>{
  const now=new Date('2026-10-19T08:10:00Z');
  const groups=planCloseSync([record('a','2026-10-16','300111.SZ'),record('b','2026-10-16','688265.SH'),record('c','2026-10-16','600000.SH')],'2026-10-19');
  const history=[{symbol:'300111.SZ',last_attempt:'2026-10-19T08:05:00Z',last_error:'network'}, {symbol:'600000.SH',last_attempt:'2026-10-19T07:50:00Z',last_error:'network'}];
  assert.deepEqual(eligibleCloseGroups(groups,history,now).map(g=>g.symbol),['688265.SH','600000.SH']);
  assert.equal(eligibleCloseGroups(groups,history,new Date('2026-10-19T08:15:00Z')).length,3);
  assert.equal(eligibleCloseGroups(groups,[{...history[0],last_attempt:'2026-10-16T15:55:00Z'}],now).length,3);
  assert.equal(syncDay(new Date('2026-10-19T15:56:00Z')).active,false);
});
test('quote workers run concurrently with a strict bound and isolate provider failures',async()=>{
  let active=0,peak=0;const completed:string[]=[];
  const results=await loadCloseBatch(Array.from({length:8},(_,i)=>({symbol:String(i)})),async symbol=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));active--;completed.push(symbol);
    if(symbol==='1')throw new Error('provider failed');return {symbol};
  });
  assert.equal(peak,closeSyncSchedule.concurrency);assert.equal(completed.length,8);
  assert.equal(results.get('1')?.error,'provider failed');assert.equal(results.get('7')?.quote?.symbol,'7');
  assert.equal(closeSyncSchedule.intervalMinutes,1);assert.ok(closeSyncSchedule.limitPerRun*6<=50);
});

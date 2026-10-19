import test from 'node:test';
import assert from 'node:assert/strict';
import {compareCloses,afterBuyWindow,collectionWindow,mergeCloseWindow,verifiedCloseDates} from '../src/close-validation';
import dates from '../src/calendar.json';
import type {Bar,RecordRow} from '../src/types';
import {closeTargets} from '../src/close-sync-plan';
const bar=(date:string,close:number)=>({date,close,open:close,high:close,low:close,volume:100});
test('only matching unadjusted closes enter verified bars; disagreement and missing source remain pending',()=>{
  const result=compareCloses([bar('2026-10-15',10),bar('2026-10-16',11),bar('2026-10-19',12)],[bar('2026-10-15',10),bar('2026-10-16',11.01)],'2026-10-19T08:05:00Z');
  assert.deepEqual(result.bars.map(b=>b.date),['2026-10-15']);assert.deepEqual(result.validation.map(v=>v.status),['matched','mismatch','secondary_missing']);assert.deepEqual(result.bars[0].crossCheck?.sources,['东方财富','腾讯']);
});
test('collection includes D0 separately plus ten after-buy closes and excludes D+11',()=>{
  const r={symbol:'300111.SZ',buy_time:'2026-10-15T09:47:00',market_data:null} as RecordRow,i=dates.indexOf('2026-10-15'),window=afterBuyWindow(r);
  assert.equal(window.length,10);assert.equal(window[0],dates[i+1]);assert.equal(window[9],dates[i+10]);
  const bars=dates.slice(i,i+12).map(d=>bar(d,3)),saved=mergeCloseWindow(r,compareCloses(bars,bars,'2026-11-02T08:05:00Z'));assert.deepEqual(saved.bars.map(b=>b.date),collectionWindow(r));assert.equal(saved.validation.length,11);
});
test('a failed cross-check does not erase prior prices or historical records',()=>{
  const old=bar('2026-10-16',3),r={symbol:'300111.SZ',buy_time:'2026-10-15T09:47:00',market_data:JSON.stringify({bars:[old]})} as RecordRow;
  const saved=mergeCloseWindow(r,compareCloses([bar('2026-10-16',4)],[bar('2026-10-16',5)],'2026-10-16T08:05:00Z'));assert.deepEqual(saved.bars,[old]);assert.equal(saved.validation[0].status,'mismatch');assert.deepEqual(JSON.parse(r.market_data!).bars,[old]);
  const previous={...r,fetched_at:'2026-10-16T08:05:00Z',market_data:JSON.stringify({...saved,bars:[{...old,crossCheck:{status:'matched'}}]})};assert.deepEqual(closeTargets(previous,'2026-10-16'),['2026-10-15','2026-10-16']);
});

test('missing secondary preserves prior verified close only while primary price agrees',()=>{
  const old={...bar('2026-10-16',19.57),crossCheck:{status:'matched' as const,sources:['新浪','腾讯'],checkedAt:'2026-10-16T09:00:00Z'}};
  const r={symbol:'920344.BJ',buy_time:'2026-10-16T09:38:00',market_data:JSON.stringify({bars:[old]})} as RecordRow;
  const saved=mergeCloseWindow(r,compareCloses([bar('2026-10-16',19.57)],[],'2026-10-19T09:00:00Z'));
  assert.equal(saved.validation[0].status,'matched');assert.ok(verifiedCloseDates(saved).has('2026-10-16'));assert.deepEqual(saved.bars[0].crossCheck,old.crossCheck);
  const changed=mergeCloseWindow(r,compareCloses([bar('2026-10-16',19.58)],[],'2026-10-19T09:00:00Z'));
  assert.equal(changed.validation[0].status,'secondary_missing');assert.equal(verifiedCloseDates(changed).size,0);
  const conflict=mergeCloseWindow(r,compareCloses([bar('2026-10-16',19.57)],[bar('2026-10-16',19.58)],'2026-10-19T09:00:00Z'));
  assert.equal(conflict.validation[0].status,'mismatch');assert.equal(verifiedCloseDates(conflict).size,0);
  const unresolved=mergeCloseWindow({...r,market_data:JSON.stringify(conflict)},compareCloses([bar('2026-10-16',19.57)],[],'2026-10-19T09:00:00Z'));
  assert.equal(unresolved.validation[0].status,'mismatch');assert.equal(verifiedCloseDates(unresolved).size,0);
});

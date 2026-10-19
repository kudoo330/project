import test from 'node:test';
import assert from 'node:assert/strict';
import {corporateAdjustment,type CorporateSource} from '../src/corporate-actions';
import {afterBuyWindow} from '../src/observation-window';
import {track} from '../src/tracking';
import type {RecordRow} from '../src/types';
const record={symbol:'300111.SZ',buy_time:'2026-10-15T09:47:00',actual_price:100,reference_price:null,market_data:null,checked_through:null} as RecordRow;
const window=afterBuyWindow(record),buy='2026-10-15',ex=window[1];
const bar=(date:string,close:number)=>({date,open:close,close,high:close,low:close,volume:100});
const factors=[{date:'1900-01-01',factor:1},{date:ex,factor:2}];
const source=(qfq=50):CorporateSource=>({status:'available',factors,qfq:[buy,...window].map(d=>bar(d,qfq)),fetchedAt:ex+'T08:05:00Z'});
test('split updates historical calculation prices and P0 together, never original prices',()=>{
  const bars=[bar(buy,100),bar(window[0],100),bar(ex,50)],r=corporateAdjustment(record,bars,source(),ex);
  assert.equal(r.status,'verified');assert.equal(r.baseMultiplier,.5);assert.equal(r.dateMultipliers[window[0]],.5);assert.equal(r.dateMultipliers[ex],1);assert.equal(record.actual_price,100);
  const t=track({...record,market_data:JSON.stringify({bars,adjustment:r})},new Date(ex+'T09:00:00Z'));
  assert.equal(t.rawBase,100);assert.equal(t.base,50);assert.equal(t.window[1].rawClose,100);assert.equal(t.window[1].close,50);assert.equal(t.window[2].value,0);
});
test('cash dividend uses the same anchored-factor rule without a false ex-day loss',()=>{
  const s=source(99);s.factors=[{date:'1900-01-01',factor:1},{date:ex,factor:100/99}];const a=corporateAdjustment(record,[bar(buy,100),bar(window[0],100),bar(ex,99)],s,ex);assert.equal(a.status,'verified');assert.ok(Math.abs(a.baseMultiplier-.99)<1e-10);
});
test('D+10 applies the last in-window action and freezes; later actions never rebase it',()=>{
  const end=window[9],bars=[bar(buy,100),...window.map(d=>bar(d,d<ex?100:50))],a=corporateAdjustment(record,bars,source(),end);assert.equal(a.frozen,true);assert.equal(a.anchor,end);
  const old={...record,market_data:JSON.stringify({adjustment:a})};const future=source();future.factors.push({date:'2026-12-01',factor:4});assert.deepEqual(corporateAdjustment(old,bars,future,'2026-12-02'),a);
  assert.equal(corporateAdjustment(record,bars,source(),'2026-12-02',end).status,'completed_unchanged');
});
test('already completed legacy samples are unchanged; unresolved snapshots are not retroactively changed',()=>{
  const a=corporateAdjustment(record,[],source(),'2026-12-01');assert.equal(a.status,'completed_unchanged');assert.equal(a.baseMultiplier,1);
  const old={...record,market_data:JSON.stringify({adjustment:{...a,status:'pending',frozen:false}})};assert.equal(corporateAdjustment(old,[],source(),'2026-12-01').status,'pending');
});
test('unavailable or conflicting adjustment evidence blocks instead of guessing',()=>{
  const bars=[bar(buy,100),bar(ex,50)];assert.equal(corporateAdjustment(record,bars,undefined,ex).status,'pending');const wrong=source();wrong.qfq[0].close=40;assert.equal(corporateAdjustment(record,bars,wrong,ex).status,'pending');
  assert.equal(corporateAdjustment(record,[bar(ex,50)],source(),ex).status,'pending');
});

test('Beijing shares the trading window, adjustment checks and frozen D+10 snapshot',()=>{
  const bj={...record,symbol:'920344.BJ'};
  assert.deepEqual(afterBuyWindow(bj),window);
  const bars=[bar(buy,100),...window.map(d=>bar(d,d<ex?100:50))];
  const a=corporateAdjustment(bj,bars,source(),window[9]);
  assert.equal(a.status,'verified');assert.equal(a.frozen,true);
  const t=track({...bj,market_data:JSON.stringify({bars,adjustment:a})},new Date(window[9]+'T09:00:00Z'));
  assert.equal(t.window[1].date,window[0]);assert.equal(t.window[10].date,window[9]);assert.equal(t.window[1].value,0);
  assert.deepEqual(corporateAdjustment({...bj,market_data:JSON.stringify({adjustment:a})},bars,undefined,'2026-12-01'),a);
  const missing=track({...bj,market_data:JSON.stringify({bars:bars.filter(b=>b.date!==window[0]),adjustment:a})},new Date(window[9]+'T09:00:00Z'));
  assert.equal(missing.window[1].date,window[0]);assert.equal(missing.window[1].value,null);assert.equal(missing.window[2].date,window[1]);
});

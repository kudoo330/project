import test from 'node:test';
import assert from 'node:assert/strict';
import {corporateAdjustment} from '../src/corporate-actions';
import {prepareConfirmedDividend} from '../src/confirmed-dividend';
import {mergeCloseWindow} from '../src/close-validation';
import {track} from '../src/tracking';
import type {RecordRow,Bar} from '../src/types';
const now=new Date('2026-10-23T09:00:00Z');
const bar=(date:string,close:number):Bar=>({date,open:close,close,high:close,low:close,volume:100,crossCheck:{status:'matched',sources:['新浪','腾讯'],checkedAt:now.toISOString()}});
function fixture(){
  const bars=[bar('2026-10-16',40),bar('2026-10-19',34),bar('2026-10-20',32),bar('2026-10-21',30),bar('2026-10-22',29.7),bar('2026-10-23',31)];
  const source={status:'available' as const,factors:[{date:'2026-01-01',factor:1},{date:'2026-10-22',factor:30/29.7}],qfq:bars.map(b=>({...b,close:b.date<'2026-10-22'?b.close-.3:b.close})),fetchedAt:now.toISOString()};
  const data={bars,validation:bars.map(b=>({date:b.date,status:'matched'})),adjustment_source:source};
  const record={id:'synthetic-cash',symbol:'300111.SZ',buy_time:'2026-10-16T10:00:00',actual_price:39,reference_price:null,revision:1,market_data:JSON.stringify(data)} as RecordRow;
  return {record,bars,source};
}
const input={revision:1,date:'2026-10-22',cash_per_10:3,reason:'LOCAL TEST: user confirmed cash-only distribution'};
test('confirmed cash reconciles additive and proportional vendors without rewriting raw evidence',()=>{
  const {record,bars,source}=fixture();
  assert.equal(corporateAdjustment(record,bars,source,'2026-10-23').status,'pending');
  const data=prepareConfirmedDividend(record,input,'admin',now);
  assert.equal(data.adjustment.verification,'admin-cash-dividend');
  assert.ok(Math.abs(data.adjustment.baseMultiplier-.99)<1e-10);
  assert.deepEqual(data.bars,bars);assert.deepEqual(data.adjustment_source,source);
  const updated={...record,market_data:JSON.stringify(data)};
  const tracking=track(updated,now);
  assert.equal(tracking.rawBase,39);assert.ok(Math.abs(tracking.base!-38.61)<1e-10);
  assert.ok(Math.abs(tracking.window[0].value!-(40/39-1)*100)<1e-8);
  assert.ok(Math.abs(tracking.window[5].value!-(31/38.61-1)*100)<1e-8);
  const refreshed=mergeCloseWindow(updated,{bars,validation:data.validation,corporateSource:source,fetchedAt:now.toISOString()});
  assert.equal(refreshed.adjustment.status,'verified');assert.deepEqual(refreshed.confirmed_cash_dividends,data.confirmed_cash_dividends);
});
test('manual cash confirmation cannot excuse wrong factors, unrelated qfq corruption or missing cross-checks',()=>{
  const {record}=fixture();
  assert.throws(()=>prepareConfirmedDividend(record,{...input,cash_per_10:4},'admin',now));
  const confirmed=prepareConfirmedDividend(record,input,'admin',now);
  for(const mutate of [
    (d:any)=>d.adjustment_source.qfq[0].close-=1,
    (d:any)=>d.adjustment_source.factors[1].factor=2,
    (d:any)=>d.bars.splice(3,1),
    (d:any)=>delete d.bars[3].crossCheck,
    (d:any)=>d.adjustment_source.status='unavailable',
    (d:any)=>d.adjustment_source.factors.push({date:'2026-10-23',factor:2}),
    (d:any)=>d.confirmed_cash_dividends['2026-10-21']={...d.confirmed_cash_dividends['2026-10-22']}
  ]){
    const d=structuredClone(confirmed);mutate(d);
    assert.equal(corporateAdjustment({...record,market_data:JSON.stringify(d)},d.bars,d.adjustment_source,'2026-10-23').status,'pending');
  }
});
test('confirmation rejects stale, unrelated, future, invalid and finished-window inputs',()=>{
  const {record}=fixture();
  for(const change of [{revision:0},{date:'2026-10-21'},{date:'2026-10-26'},{date:'2026-10-16'},{cash_per_10:0},{cash_per_10:'3'},{reason:''}])assert.throws(()=>prepareConfirmedDividend(record,{...input,...change},'admin',now));
  assert.throws(()=>prepareConfirmedDividend(record,input,'admin',new Date('2026-11-02T09:00:00Z')));
  const data=prepareConfirmedDividend(record,input,'admin',now);
  const frozen={...data.adjustment,frozen:true,anchor:'2026-10-30'};
  const r={...record,market_data:JSON.stringify({...data,adjustment:frozen})};
  assert.deepEqual(corporateAdjustment(r,[],undefined,'2026-11-02'),frozen);
});

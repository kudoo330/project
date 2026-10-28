import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResearchTime, validateResearchInput, planResearchRows, researchDatasetId, researchPreviewToken,
  type ResearchInput, type StoredResearchRow,
} from '../src/research-data-validation';

const clock = new Date('2026-10-28T20:01:00Z');
const payload = (rows: any[] = [{ time:'2026-10-27T09:30:00-04:00', open:'100.20',high:102,low:99,close:101,volume:'' }], extra: any = {}) => ({
  dataset:{symbol:'AMD.US',period:'1m',provider:'Longbridge export',adjustment:'none',time_zone:'America/New_York',currency:'USD',...extra},
  source_note:'Export downloaded by administrator; not independently verified',rows,
});
const parsed = (value: any): ResearchInput => {
  const checked = validateResearchInput(value,clock);
  assert.deepEqual(checked.errors,[]); assert.ok(checked.input); return checked.input;
};
const invalid = (value: any, pattern: RegExp) => {
  const checked = validateResearchInput(value,clock);
  assert.equal(checked.input,undefined); assert.match(checked.errors.map(e=>e.message).join(';'),pattern);
};

test('research minute times normalize absolute timestamps and enforce NY DST and real dates',()=>{
  assert.equal(normalizeResearchTime('2026-10-27T09:30:00-04:00','1m').time,'2026-10-27T13:30:00.000Z');
  assert.equal(normalizeResearchTime('2026-10-27T21:30:00+08:00','1m').time,'2026-10-27T13:30:00.000Z');
  assert.equal(normalizeResearchTime('2026-01-27T09:30:00-05:00','1m').time,'2026-01-27T14:30:00.000Z');
  assert.equal(normalizeResearchTime('2026-11-01T01:30:00-04:00','1m').time,'2026-11-01T05:30:00.000Z');
  assert.equal(normalizeResearchTime('2026-11-01T01:30:00-05:00','1m').time,'2026-11-01T06:30:00.000Z');
  for (const time of ['2026-02-30T09:30:00Z','2026-10-27T09:30:00','2026-10-27T09:30:01Z','2026-10-27T24:30:00Z','2026-10-27T09:30:00+14:01','2026-10-27T09:30:00-05:00','2026-03-08T02:30:00-05:00']) {
    assert.throws(()=>normalizeResearchTime(time,'1m'),undefined,time);
  }
});

test('research daily bars remain independent NY dates and reject incomplete future bars',()=>{
  const daily=payload([{time:'2026-10-27',open:10,high:12,low:9,close:11}],{period:'1d'});
  assert.equal(parsed(daily).rows[0].time,'2026-10-27');
  invalid(payload([{...daily.rows[0],time:'2026-02-30'}],{period:'1d'}),/日线时间/);
  invalid(payload([{...daily.rows[0],time:'2026-10-27T00:00:00Z'}],{period:'1d'}),/日线时间/);
  const currentDaily=payload([{...daily.rows[0],time:'2026-10-28'}],{period:'1d'});
  assert.ok(validateResearchInput(currentDaily,new Date('2026-10-28T19:59:59Z')).errors.length);
  assert.ok(validateResearchInput(currentDaily,new Date('2026-10-28T20:00:00Z')).input);
  const future=payload([{...daily.rows[0],time:'2026-10-28T20:01:00Z'}]);
  invalid(future,/尚未结束/);
  assert.ok(validateResearchInput(future,new Date('2026-10-28T20:02:00Z')).input);
});

test('research missing values stay null with explicit reasons; zero and partial OHLC cannot impersonate absence',()=>{
  for(const status of ['missing','not_entitled','request_failed','no_eligible_trade']) {
    const value=payload([{time:'2026-10-27T13:31:00Z',status,reason:'Provider returned no eligible data',open:'',high:null}]);
    const row=parsed(value).rows[0];
    assert.deepEqual([row.open,row.high,row.low,row.close,row.volume],[null,null,null,null,null]);
    invalid(payload([{...value.rows[0],reason:''}]),/必须填写原因/);
    invalid(payload([{...value.rows[0],open:0}]),/OHLC必须全部留空/);
    invalid(payload([{...value.rows[0],close:100}]),/OHLC必须全部留空/);
  }
  const available=parsed(payload()).rows[0];
  assert.equal(available.open,100.2);assert.equal(available.volume,null);assert.equal(available.original_values.open,'100.20');
  assert.equal(parsed(payload([{...payload().rows[0],volume:0}])).rows[0].volume,0);
});

test('research numeric validation rejects malformed OHLC and volume without coercing blanks',()=>{
  const row=payload().rows[0];
  for(const open of ['',null,undefined,0,-1,NaN,Infinity,true,{},'0x10','1e4']) invalid(payload([{...row,open}]),/缺失|数字|范围|OHLC/);
  invalid(payload([{...row,high:100}]),/OHLC/);
  invalid(payload([{...row,low:102}]),/OHLC/);
  for(const volume of [-1,0.5,'bad',Number.MAX_SAFE_INTEGER+1]) invalid(payload([{...row,volume}]),/成交量/);
});

test('research rows enforce canonical uniqueness, supported instruments, provenance and row limit',()=>{
  const row=payload().rows[0];
  invalid(payload([row,{...row,time:'2026-10-27T13:30:00Z'}]),/重复时间/);
  invalid(payload([row],{symbol:'AAPL.US'}),/AMD/);
  invalid({...payload(),source_note:''},/来源依据/);
  invalid(payload([row],{provider:''}),/数据来源/);
  invalid(payload(Array(501).fill(row)),/500/);
  invalid(payload([row],{adjustment:'forward'}),/复权截至日期/);
  invalid(payload([row],{adjustment:'forward',adjustment_as_of:'2026-10-29'}),/复权截至日期/);
  invalid(payload([row],{adjustment:'forward',adjustment_as_of:'2026-10-26'}),/行情日期不能晚于/);
  invalid(payload([row],{adjustment_as_of:'2026-10-27'}),/不复权/);
});

test('research dataset identity separates provider, period, symbol and forward-adjustment anchor',async()=>{
  const base=parsed(payload()).dataset, id=await researchDatasetId(base);
  for(const patch of [{provider:'Sina'},{symbol:'AMDL.US'},{period:'1d'},{adjustment:'forward',adjustment_as_of:'2026-10-27'}]) {
    assert.notEqual(await researchDatasetId({...base,...patch} as any),id);
  }
  assert.notEqual(await researchDatasetId({...base,adjustment:'forward',adjustment_as_of:'2026-10-27'}),await researchDatasetId({...base,adjustment:'forward',adjustment_as_of:'2026-10-28'}));
});

test('research plans protect known values, distinguish fills and retain conflicts including provenance',async()=>{
  const input=parsed(payload());
  const saved:StoredResearchRow={...input.rows[0],source_note:input.source_note,revision:1};
  assert.equal(planResearchRows(input,[]).counts.insert,1);
  assert.equal(planResearchRows(input,[saved]).counts.unchanged,1);
  assert.equal(planResearchRows({...input,source_note:'different export'},[saved]).counts.conflict,1);
  assert.equal(planResearchRows({...input,rows:[{...input.rows[0],close:100.5}]},[saved]).counts.conflict,1);
  const missing=parsed(payload([{time:input.rows[0].time,status:'missing',reason:'No historical permission'}]));
  const missingSaved={...missing.rows[0],source_note:missing.source_note,revision:1};
  assert.equal(planResearchRows(input,[missingSaved]).counts.fill,1);
  assert.equal(planResearchRows(missing,[saved]).counts.blocked,1);
  const token=await researchPreviewToken(input,1,[saved]);
  assert.notEqual(token,await researchPreviewToken(input,2,[saved]));
  assert.notEqual(token,await researchPreviewToken(input,1,[{...saved,close:100.5}]));
  assert.notEqual(token,await researchPreviewToken({...input,source_note:'changed source'},1,[saved]));
});

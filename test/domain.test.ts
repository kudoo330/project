import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import {change,extrema,summarize,normalizeTime,normalizeSymbol,csvCell,indicators,closedBars} from '../src/domain';
import {verifyPassword} from '../src/auth';
import {track} from '../src/tracking';
import {parseCSV} from '../public/csv.js';
import type {RecordRow} from '../src/types';
test('known-return examples and missing denominator',()=>{
  assert.ok(Math.abs(change(10.2,10)!-2)<1e-10);assert.ok(Math.abs(change(10.5,10)!-5)<1e-10);assert.ok(Math.abs(change(11,10)!-10)<1e-10);
  assert.deepEqual(extrema([15,-5,null]),{max:15,min:-5});assert.deepEqual(extrema([null]),{max:null,min:null});assert.equal(change(11,null),null);
  const s=summarize([10,0,10,-10,null]);assert.equal(s.mean,2.5);assert.equal(s.positive,.5);assert.equal(s.count,4);
});
test('dates remain Shanghai; future, invalid and stale timestamps reject',()=>{
  const now=new Date('2026-10-16T03:00:00Z');assert.equal(normalizeTime('2026-10-15 09:47',now),'2026-10-15T09:47:00');
  for(const v of ['2026-10-16T13:00','2026-10-13T09:47','2026-02-30T10:00','2026-10-15T25:00'])assert.throws(()=>normalizeTime(v,now));
  assert.equal(normalizeSymbol('920162.bj'),'920162.BJ');assert.throws(()=>normalizeSymbol('920162'));
});
test('CSV handles commas, quoted newlines and spreadsheet formulas',()=>{
  assert.deepEqual(parseCSV('\uFEFF代码,备注\r\n300111.SZ,"a,b\n""c"""'),[['代码','备注'],['300111.SZ','a,b\n"c"']]);
  assert.equal(csvCell(' =HYPERLINK("x")'),'"\' =HYPERLINK(""x"")"');assert.throws(()=>parseCSV('"unclosed'));
});
test('MA and volume exclude current day from previous-five average',()=>{
  const bars=Array.from({length:20},(_,i)=>({date:'2026-10-'+String(i+1).padStart(2,'0'),open:10,high:30,low:1,close:i+1,volume:i===19?200:100}));
  const v=indicators(bars);assert.equal(v.ma5,18);assert.equal(v.ma20,10.5);assert.equal(v.volumeRatio,2);assert.equal(indicators(bars.slice(0,4)).ma5,null);
  assert.equal(closedBars(bars,new Date('2026-10-16T03:00:00Z')).length,15);
});
test('tracking uses market calendar, D0 separate; unverified corporate actions blocked',()=>{
  const r={buy_time:'2026-10-15T09:47:00',symbol:'300111.SZ',actual_price:10,reference_price:null,checked_through:'2026-10-16',market_data:JSON.stringify({bars:[{date:'2026-10-15',close:10.2},{date:'2026-10-16',close:10.5}]})} as RecordRow;
  const t=track(r,new Date('2026-10-16T09:00:00Z'));assert.equal(t.window[0].date,'2026-10-15');assert.equal(t.window[1].date,'2026-10-16');assert.equal(t.window[2].date,'2026-10-19');assert.ok(Math.abs(t.window[1].value!-5)<1e-10);
  assert.equal(track({...r,checked_through:null},new Date('2026-10-16T09:00:00Z')).window[0].value,null);
  assert.ok(Math.abs(track({...r,symbol:'920162.BJ'}).window[0].value!-2)<1e-10);assert.ok(Math.abs(track({...r,symbol:'920162.BJ'},new Date('2026-10-16T09:00:00Z')).window[1].value!-5)<1e-10);
  assert.equal(track(r,new Date('2026-10-16T03:00:00Z')).window[1].value,null);
});
test('PBKDF2 hashes from setup script match Worker verification',async()=>{
  const salt='1234567890abcdef1234567890abcdef',password='only-a-test-password';
  const encoded=`pbkdf2$100000$${salt}$${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}`;
  assert.equal(await verifyPassword(password,encoded),true);assert.equal(await verifyPassword('wrong',encoded),false);assert.equal(await verifyPassword(password,'garbage'),false);
});

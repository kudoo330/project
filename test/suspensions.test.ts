import test from 'node:test';
import assert from 'node:assert/strict';
import {suspensionInput,suspendedDates} from '../src/suspensions';
import {track} from '../src/tracking';
import {closeTargets} from '../src/close-sync-plan';
import {mergeCloseWindow} from '../src/close-validation';
import {hasPriceGap} from '../public/price-gaps.js';
import type {RecordRow} from '../src/types';
const day='2026-10-16',now=new Date(day+'T09:00:00Z');
const suspension={source:'admin-confirmed',reason:'测试停牌公告',confirmedBy:'test-admin',confirmedAt:now.toISOString()};
const record={symbol:'300111.SZ',buy_time:'2026-10-15T09:47:00',actual_price:10,reference_price:null,checked_through:null,market_data:JSON.stringify({bars:[],suspensions:{[day]:suspension}})} as RecordRow;
test('only explicitly confirmed completed trading dates can be marked suspended',()=>{
 assert.equal(suspensionInput({symbol:record.symbol,date:day,suspended:true,reason:'交易所公告'},now).date,day);
 for(const value of [{date:'2026-10-17'},{date:'2026-10-19'},{reason:''},{suspended:'true'}])assert.throws(()=>suspensionInput({symbol:record.symbol,date:day,suspended:true,reason:'test',...value},now));
 assert.throws(()=>suspensionInput({symbol:record.symbol,date:day,suspended:true,reason:'test'},new Date(day+'T07:00:00Z')));
 assert.equal(suspendedDates({bars:[],suspensions:{[day]:{reason:'missing quote'}}}).size,0);
});
test('suspension shows no fabricated price or return and never shifts later trading dates',()=>{
 const t=track(record,now),w=t.window[1];assert.equal(w.state,'停牌');assert.equal(w.rawClose,null);assert.equal(w.close,null);assert.equal(w.value,null);assert.equal(t.window[2].date,'2026-10-19');
 assert.deepEqual(closeTargets(record,day),['2026-10-15']);
 assert.equal(hasPriceGap({actual_price:10,tracking:{window:[w]}},now),false);
 assert.equal(hasPriceGap({actual_price:10,tracking:{window:[{...w,state:'缺少有效报价'}]}},now),true);
 const data=JSON.parse(record.market_data!);const result=mergeCloseWindow(record,{bars:[],validation:[],fetchedAt:now.toISOString()});assert.deepEqual(result.suspensions,data.suspensions);
});
test('trade evidence conflicts with a suspension instead of being silently hidden',()=>{
 const data=JSON.parse(record.market_data!);data.bars=[{date:day,open:10,close:10,high:10,low:10,volume:100}];
 assert.equal(suspendedDates(data).size,0);const t=track({...record,market_data:JSON.stringify(data)},now);assert.equal(t.window[1].state,'停牌标记与行情冲突');assert.equal(t.window[1].value,null);
 assert.ok(closeTargets({...record,market_data:JSON.stringify(data)},day).includes(day));
});

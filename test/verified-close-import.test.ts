import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCloseImport} from '../src/verified-close-import';
import {track} from '../src/tracking';
import type {RecordRow} from '../src/types';
const bar={date:'2026-10-15',open:10,high:11,low:9,close:10.5,volume:100};
const quote=()=>({symbol:'300111.SZ',bars:[bar],secondary:[bar],secondaryProvider:'腾讯',fetchedAt:'2026-10-16T09:00:00Z',evidence:{primary:{url:'https://push2his.eastmoney.com/'},secondary:{url:'https://web.ifzq.gtimg.cn/'}}});
test('verified close ingestion rejects disagreements, invalid OHLC and same-source validation',()=>{
 assert.throws(()=>validateCloseImport({...quote(),secondary:[{...bar,close:10.6}]}),/未逐日匹配/);assert.throws(()=>validateCloseImport({...quote(),bars:[{...bar,close:99}]}),/无效OHLC/);assert.throws(()=>validateCloseImport({...quote(),primaryProvider:'新浪',secondaryProvider:'新浪'}),/独立/);
 const q=validateCloseImport({...quote(),primaryProvider:'新浪'});assert.deepEqual(q.bars[0].crossCheck?.sources,['新浪','腾讯']);
});
test('verified D0 is usable independently of later corporate-action coverage; D+n waits for adjustment evidence',()=>{
 const r={symbol:'920344.BJ',buy_time:'2026-10-15T09:38:00',actual_price:null,reference_price:10,checked_through:null,market_data:JSON.stringify({bars:[{...bar,crossCheck:{status:'matched'}}],adjustment:{status:'pending',reason:'calendar pending'}})} as RecordRow;
 const t=track(r,new Date('2026-10-16T09:00:00Z'));assert.ok(Math.abs(t.window[0].value!-5)<1e-8);assert.equal(t.window[1].value,null);assert.equal(t.window[1].date,'2026-10-16');
 const conflict={...r,market_data:JSON.stringify({bars:[{...bar,crossCheck:{status:'matched'}}],validation:[{date:bar.date,status:'mismatch'}]})};assert.equal(track(conflict,new Date('2026-10-16T09:00:00Z')).window[0].value,null);
});

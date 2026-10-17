import test from 'node:test';import assert from 'node:assert/strict';import {minuteCloseSource} from '../src/reference-source';
const record={symbol:'600668.SH',buy_time:'2026-10-16T14:43:00'};
const source=()=>({symbol:record.symbol,source_label:'2026-10-16 14:43:00',provider:'东方财富',field:'close',interval:'1m',quotes:[{provider:'东方财富',price:8.45,url:'https://push2his.eastmoney.com/api/qt/stock/trends2/get',fetched_at:'2026-10-17T06:00:00Z'},{provider:'腾讯',price:8.45,url:'https://web.ifzq.gtimg.cn/appstock/app/day/query',fetched_at:'2026-10-17T06:00:00Z'}]});
test('minute-close evidence binds selected price to symbol, minute, independent source and explicit close field',()=>{
 assert.equal(minuteCloseSource(source(),8.45,record).cross_verified,true);assert.throws(()=>minuteCloseSource(source(),8.79,record),/不一致/);assert.throws(()=>minuteCloseSource({...source(),field:'open'},8.45,record),/不一致/);assert.throws(()=>minuteCloseSource(source(),8.45,{...record,buy_time:'2026-10-16T14:44:00'}),/不一致/);
 const only=source();only.quotes=only.quotes.slice(0,1);assert.equal(minuteCloseSource(only,8.45,record).cross_verified,false);
});

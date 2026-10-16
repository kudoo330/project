import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedRows} from '../src/reviewed-import';
import {shanghaiNow} from '../src/domain';
const row=()=>({strategy:'测试策略',symbol:'300111.SZ',buy_time:shanghaiNow(new Date(Date.now()-3600000)),reference_price:'3.25',reference_evidence:{provider:'test fixture'},original_time:'original time'});
test('reviewed import keeps reference price separate from actual fills and preserves original time',()=>{
 const r=reviewedRows([row()])[0];assert.equal(r.reference_price,3.25);assert.equal(r.original_time,'original time');assert.equal('actual_price'in r,false);assert.match(r.reference_evidence!,/test fixture/);
});
test('reviewed import rejects missing evidence, invalid prices and duplicate samples',()=>{
 assert.throws(()=>reviewedRows([{...row(),reference_evidence:null}]),/证据/);assert.throws(()=>reviewedRows([{...row(),reference_price:-1}]),/正数/);assert.throws(()=>reviewedRows([row(),row()]),/重复/);
 const rows=reviewedRows([row(),{...row(),strategy:'另一个策略'}]);assert.equal(rows.length,2);assert.equal(reviewedRows([{...row(),reference_price:null,reference_evidence:null}])[0].reference_price,null);
});

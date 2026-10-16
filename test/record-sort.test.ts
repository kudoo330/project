import test from 'node:test';import assert from 'node:assert/strict';import {sortRecords} from '../public/record-sort.js';
test('record ordering handles numeric returns, zero, missing values, dates and ties without changing input',()=>{
 const make=(id:string,time:string,value:number|null)=>({id,buy_time:time,tracking:{window:Array.from({length:11},()=>({value}))}});
 const rows=[make('zero','2026-10-16T09:32:00',0),make('missing','2026-10-16T09:30:00',null),make('up','2026-10-16T09:33:00',12),make('down','2026-10-16T09:31:00',-2)];const original=rows.map(r=>r.id);
 assert.deepEqual(sortRecords(rows,'d0','desc').map(r=>r.id),['up','zero','down','missing']);assert.deepEqual(sortRecords(rows,'d10','asc').map(r=>r.id),['down','zero','up','missing']);assert.deepEqual(sortRecords(rows,'buy_time','asc').map(r=>r.id),['missing','down','zero','up']);assert.deepEqual(rows.map(r=>r.id),original);
});

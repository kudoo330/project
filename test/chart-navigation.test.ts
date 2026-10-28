import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultChartRange,zoomChartRange,boundedChartRange} from '../public/chart-navigation.js';
import {loadChartRange,expandChartPage} from '../public/chart-range.js';

test('one-minute default covers one complete latest trading date; zoom and pan stay within the loaded range',()=>{
 const rows=['2026-10-23','2026-10-26','2026-10-27'].flatMap(trading_date=>Array.from({length:390},()=>({trading_date,_valid:true})));
 const one=defaultChartRange(rows,'1m');assert.deepEqual(one,{from:779.5,to:1169.5});
 assert.deepEqual(defaultChartRange(rows,'5m'),{from:-.5,to:1169.5});
 const bigger=zoomChartRange(one,rows.length,1/.65);assert.equal(Math.round(bigger.to-bigger.from),600);assert.ok(bigger.to<=1169.5);
 assert.deepEqual(zoomChartRange(bigger,rows.length,100),{from:-.5,to:1169.5});
 assert.deepEqual(boundedChartRange({from:-100,to:290},rows.length),{from:-.5,to:389.5});
 assert.equal(zoomChartRange({from:0,to:10},0,1),null);
});

test('continuous chunks preserve bars, weighted coverage, source version and cancellation',async()=>{
 const make=(day:string,available:number,next:string|null)=>({dataset:{id:'fixture',revision:2},timeframe:'1m',range:{start:'2026-10-01',end:'2026-10-20',page_start:day,page_end:day},next_cursor:next,bar_columns:['time_utc','end_utc','trading_date','session','open','source_note_index'],bar_rows:[[day+'T13:30:00Z',day+'T13:31:00Z',day,'regular',10,0]],source_notes:['Synthetic only'],warnings:['Unverified'],coverage:{expected_minutes:10,available_minutes:available,no_eligible_minutes:0,missing_minutes:10-available,incomplete_bars:10-available,trading_days:1}});
 const pages=[make('2026-10-01',10,'2026-10-15'),make('2026-10-15',5,null)];let calls=0;
 const result=await loadChartRange(async query=>{assert.equal(query.get('continuous'),'1');return pages[calls++];},new URLSearchParams({start:'2026-10-01',end:'2026-10-20'}));
 assert.equal(calls,2);assert.equal(result.bars.length,2);assert.equal(result.bars[0].source_note,'Synthetic only');assert.equal(result.coverage.percent,75);assert.equal(result.coverage.trading_days,2);assert.equal(result.range.page_end,'2026-10-15');assert.equal(result.next_cursor,null);
 assert.deepEqual(result.warnings,['Unverified']);assert.equal(expandChartPage(pages[0]).bars[0].interval_end_utc,'2026-10-01T13:31:00Z');
 calls=0;await assert.rejects(()=>loadChartRange(async()=>{const p=structuredClone(pages[calls++]);if(calls===2)p.dataset.revision=3;return p;},new URLSearchParams()),/行情版本/);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>loadChartRange(async()=>{throw new Error('must not fetch');},new URLSearchParams(),{signal:abort.signal}),{name:'AbortError'});
});

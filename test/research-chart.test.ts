import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildResearchChart, researchChartApi, type ChartDataset, type ChartSourceRow } from '../src/research-chart';
import { usCalendarDay, usMinuteUTC, US_CALENDAR } from '../src/us-market-calendar';

const dataset: ChartDataset={id:'market_'+'a'.repeat(64),symbol:'AMD.US',period:'1m',provider:'Synthetic unit fixture',adjustment:'none',adjustment_as_of:null,time_zone:'America/New_York',currency:'USD',revision:7};
const finalClock=Date.parse('2027-01-01T00:00:00Z');
function minute(day:string,at:number,offset=0,extra:Partial<ChartSourceRow>={}):ChartSourceRow {
  return {time_key:new Date(usMinuteUTC(day,at)).toISOString(),trading_date:day,open:100+offset,high:102+offset,low:99+offset,close:101+offset,volume:10+offset,status:'available',reason:'',source_note:'Synthetic unit fixture; no real quote',revision:2,...extra};
}
function chart(rows:ChartSourceRow[],timeframe:any='5m',extra:Record<string,unknown>={}) {
  return buildResearchChart(dataset,rows,{start:'2026-10-27',end:'2026-10-27',timeframe,sessions:['regular'],now:finalClock,...extra});
}

test('US sessions use IANA DST, holiday coverage and explicit half-day hours',()=>{
  assert.equal(new Date(usMinuteUTC('2026-03-06',570)).toISOString(),'2026-03-06T14:30:00.000Z');
  assert.equal(new Date(usMinuteUTC('2026-03-09',570)).toISOString(),'2026-03-09T13:30:00.000Z');
  assert.equal(new Date(usMinuteUTC('2026-11-02',570)).toISOString(),'2026-11-02T14:30:00.000Z');
  assert.equal(usCalendarDay('2026-07-03').is_trading_day,false);
  assert.equal(usCalendarDay('2026-07-04').is_trading_day,false);
  assert.equal(usCalendarDay('2026-11-26').is_trading_day,false);
  const half=usCalendarDay('2026-11-27');
  assert.equal(half.early_close,true);assert.equal(half.regular_close_minute,780);
  assert.deepEqual(half.sessions.map(s=>s.session),['pre','regular']);
  assert.equal(usCalendarDay('2025-01-09').is_trading_day,false);
  assert.equal(usCalendarDay('2025-11-28').regular_close_minute,780);
  assert.equal(new Date(usMinuteUTC('2025-10-31',570)).toISOString(),'2025-10-31T13:30:00.000Z');
  assert.equal(new Date(usMinuteUTC('2025-11-03',570)).toISOString(),'2025-11-03T14:30:00.000Z');
  assert.throws(()=>usCalendarDay('2027-01-04'),/仅覆盖2025–2026/);
  assert.throws(()=>usCalendarDay('2024-12-31'),/仅覆盖2025–2026/);
  assert.equal(US_CALENDAR.status,'reference_schedule');
});

test('5/15/30/60 minute OHLCV is anchored to 09:30 and preserves corrections and volume zero',()=>{
  for(const width of [5,15,30,60]) {
    const rows=Array.from({length:width},(_,i)=>minute('2026-10-27',570+i,i));
    const bar=chart(rows,`${width}m`).bars[0];
    assert.deepEqual([bar.open,bar.high,bar.low,bar.close],[100,101+width,99,100+width]);
    assert.equal(bar.volume,width*10+width*(width-1)/2);
    assert.equal(bar.time,'2026-10-27T13:30:00.000Z');assert.equal(bar.complete,true);assert.equal(bar.source_revision,7);
    const corrected=rows.map((row,i)=>i===0?{...row,high:300,revision:3}:row);
    assert.equal(chart(corrected,`${width}m`).bars[0].high,300,'must recompute after raw correction');
    assert.deepEqual(chart(corrected,`${width}m`).bars[0].row_revisions,[2,3]);
  }
  const zero=chart([minute('2026-10-27',570,0,{volume:0})],'1m').bars[0];
  assert.equal(zero.volume,0);assert.equal(zero.status,'available');assert.equal(zero.bar_revision,2);
});

test('60 minute bars never bridge pre/open/close sessions; short tails and 07:00/20:00 boundary',()=>{
  const rows=[minute('2026-10-27',419),minute('2026-10-27',420),minute('2026-10-27',569,10),minute('2026-10-27',570,20),minute('2026-10-27',959,30),minute('2026-10-27',960,40),minute('2026-10-27',1199,50),minute('2026-10-27',1200,60)];
  const result=chart(rows,'60m',{sessions:['pre','regular','post']});
  const pre=result.bars.filter(b=>b.session==='pre'),regular=result.bars.filter(b=>b.session==='regular'),post=result.bars.filter(b=>b.session==='post');
  assert.deepEqual(pre.map(b=>b.expected_minutes),[60,60,30]);
  assert.deepEqual(regular.map(b=>b.expected_minutes),[60,60,60,60,60,60,30]);
  assert.deepEqual(post.map(b=>b.expected_minutes),[60,60,60,60]);
  assert.equal(pre.at(-1)!.close,111);assert.equal(regular[0].open,120);assert.equal(regular.at(-1)!.close,131);assert.equal(post[0].open,140);
  assert.equal(pre.at(-1)!.short_window,true);assert.equal(regular.at(-1)!.short_window,true);
  assert.equal(result.coverage.excluded_rows,2);assert.equal(result.coverage.expected_minutes,780);
});

test('missing statuses remain distinct; incomplete aggregates do not fill prices or unknown volumes',()=>{
  const day='2026-10-27';
  const rows=[minute(day,570,0,{volume:null}),minute(day,572,0,{open:null,high:null,low:null,close:null,volume:null,status:'not_entitled',reason:'History quota unavailable'}),minute(day,573,0,{open:null,high:null,low:null,close:null,volume:0,status:'no_eligible_trade',reason:'Source explicitly reports no eligible trade'})];
  const result=chart(rows),first=result.bars[0];
  assert.equal(first.status,'partial');assert.equal(first.open,100);assert.equal(first.close,101);assert.equal(first.volume,null);
  assert.equal(first.missing_minutes,3);assert.equal(first.no_eligible_minutes,1);assert.equal(first.unknown_volume_minutes,4);
  assert.match(first.reason,/尚未载入/);assert.match(first.reason,/quota/);
  assert.equal(result.bars[1].open,null);assert.equal(result.bars[1].status,'missing');
  const one=chart(rows,'1m').bars;
  assert.equal(one[2].status,'not_entitled');assert.equal(one[2].open,null);
  assert.equal(one[3].status,'no_eligible_trade');assert.equal(one[3].open,null);assert.equal(one[3].complete,true);
});

test('known volume survives unavailable OHLC, and aggregates independently without inventing missing volume',()=>{
  const day='2026-10-27';
  const rows=Array.from({length:5},(_,i)=>minute(day,570+i,0));
  rows[2]={...rows[2],open:null,high:null,low:null,close:null,volume:40,status:'missing',reason:'Supplier returned volume but no OHLC'};
  const raw=chart(rows,'1m').bars[2];
  assert.equal(raw.status,'missing');assert.equal(raw.open,null);assert.equal(raw.volume,40);
  const aggregate=chart(rows,'5m').bars[0];
  assert.equal(aggregate.status,'partial');assert.equal(aggregate.missing_minutes,1);assert.equal(aggregate.volume,80);assert.equal(aggregate.unknown_volume_minutes,0);
  rows[2].volume=null;
  assert.equal(chart(rows,'5m').bars[0].volume,null);
});

test('half-day and closed sessions do not fabricate post-market windows; current incomplete windows excluded',()=>{
  const half=chart([minute('2026-11-27',779),minute('2026-11-27',780)],'60m',{start:'2026-11-27',end:'2026-11-27',sessions:['pre','regular','post']});
  assert.equal(half.bars.filter(b=>b.session==='regular').length,4);
  assert.equal(half.bars.filter(b=>b.session==='regular').at(-1)!.expected_minutes,30);
  assert.equal(half.bars.filter(b=>b.session==='post').length,0);assert.match(half.warnings.join(' '),/半日市/);
  assert.equal(half.coverage.excluded_rows,1);
  const live=chart([minute('2026-10-27',570),minute('2026-10-27',574)],'5m',{now:usMinuteUTC('2026-10-27',574)+59000});
  assert.equal(live.bars.length,0);assert.equal(live.coverage.percent,null);assert.equal(live.coverage.status,'unassessed');
  const holiday=chart([minute('2026-11-26',570)],'1m',{start:'2026-11-26',end:'2026-11-26'});
  assert.equal(holiday.bars.length,0);assert.equal(holiday.coverage.excluded_rows,1);
});

test('daily bars are independent persisted daily OHLCV, never derived from extended minutes',()=>{
  const daily={...dataset,period:'1d' as const};
  const row={...minute('2026-10-27',570),time_key:'2026-10-27',open:10,high:13,low:9,close:12,volume:500};
  const result=buildResearchChart(daily,[row],{start:'2026-10-26',end:'2026-10-27',timeframe:'1d',sessions:['regular'],now:finalClock});
  assert.equal(result.bars.length,2);assert.equal(result.bars[0].open,null);assert.equal(result.bars[1].close,12);
  assert.equal(result.bars[1].time,'2026-10-27');assert.equal(result.bars[1].bar_revision,2);assert.equal(result.coverage.unit,'trading_day');
  assert.throws(()=>buildResearchChart(dataset,[row],{start:'2026-10-27',end:'2026-10-27',timeframe:'1d',sessions:['regular']}),/日线必须/);
});

test('real D1 chart route paginates calendar windows, reports gaps and rejects daily/minute mismatch',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'chart-api-test'}}));
  try {
    const db=await mf.getD1Database('DB');
    const schema=await readFile(new URL('../migrations/0005_research_data.sql',import.meta.url),'utf8');
    await db.batch(schema.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    await db.prepare('INSERT INTO research_market_datasets(id,symbol,period,provider,adjustment,time_zone,currency,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(dataset.id,'AMD.US','1m',dataset.provider,'none','America/New_York','USD',7,'2026-01-01','2026-01-01').run();
    await db.prepare('INSERT INTO research_market_import_batches(id,dataset_id,input_hash,input_json,actor,source_note,replacement_reason,counts_json,dataset_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind('fixture',dataset.id,'fixture','{}','fixture','synthetic only','','{}',7,'2026-01-01').run();
    const row=minute('2026-01-05',570);
    await db.prepare('INSERT INTO research_market_bars(dataset_id,time_key,original_time,trading_date,session,open,high,low,close,volume,status,reason,original_values_json,source_note,revision,import_batch_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(dataset.id,row.time_key,row.time_key,row.trading_date,'regular',100,102,99,101,10,'available','','{}','synthetic only',2,'fixture','2026-01-01').run();
    const call=async(query:string)=>{const url=new URL('https://chart.test/api/research/chart?dataset_id='+dataset.id+'&'+query);return researchChartApi(new Request(url),{DB:db} as any,url);};
    const response=await call('start=2026-01-05&end=2026-01-09&timeframe=5m&sessions=regular');assert.equal(response.status,200);
    const data:any=await response.json();
    assert.equal(data.range.page_end,'2026-01-07');assert.equal(data.next_cursor,'2026-01-08');assert.equal(data.bars.length,234);
    assert.equal(data.coverage.available_minutes,1);assert.equal(data.coverage.source_revision,7);assert.equal(data.bars[0].close,101);
    const next:any=await (await call('start=2026-01-05&end=2026-01-09&timeframe=5m&sessions=regular&cursor=2026-01-08')).json();
    assert.equal(next.next_cursor,null);assert.equal(next.range.page_start,'2026-01-08');assert.equal(next.bars.length,156);
    assert.equal((await call('start=2026-01-05&end=2026-01-09&timeframe=1d')).status,400);
    assert.equal((await call('start=2027-01-05&end=2027-01-09')).status,422);
    assert.equal((await call('start=2026-01-05&end=2026-01-09&sessions=overnight')).status,400);
    assert.equal((await call('start=2026-01-05&end=2026-01-09&cursor=2026-01-01')).status,400);
  } finally {await mf.dispose();}
});

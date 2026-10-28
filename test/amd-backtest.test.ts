import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig,runBacktest,prepareFrames,simulateFill,reentryReason,DEFAULT_PARAMETERS,localMinute,type InputBar,type BacktestInput,type ExitState,type Frame} from '../src/amd-backtest';
import {usMinuteUTC,usCalendarDay,addUSDate} from '../src/us-market-calendar';
const day='2026-10-27';
function bar(minute:number,close=100,volume:number|null=10000,open=close):InputBar{return {time:new Date(usMinuteUTC(day,minute)).toISOString(),date:day,open,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,close,volume,status:'available',revision:1,verification:'unverified'};}
function config(end='10:30',extra:any={}){return normalizeConfig({initial_entry_local:day+'T09:30',end_local:day+'T'+end,initial_cash_usd:1000,sessions:['regular'],...extra});}
function input(rows:InputBar[],daily:InputBar[]=[]):BacktestInput{return {minutes:rows,daily,minuteSource:{provider:'Synthetic unit fixture',revision:1},dailySource:{provider:'Synthetic daily fixture',revision:1}};}
function flat(end=650){return Array.from({length:end-570},(_,i)=>bar(570+i));}
function ideal(run:ReturnType<typeof runBacktest>,id='D01'){return run.results.find(r=>r.strategyId===id&&r.model==='IDEAL_OHLCV'&&r.costScenario==='zero')!;}
function drop(at=599){const rows=flat(800);rows[at-570]=bar(at,98,20000,100);for(let m=at+1;m<800;m++)rows[m-570]=bar(m,98);return rows;}

test('AMD-only configuration, explicit session clock and DST boundaries',()=>{
 assert.equal(new Date(localMinute('2026-03-06T09:30')).toISOString(),'2026-03-06T14:30:00.000Z');assert.equal(new Date(localMinute('2026-03-09T09:30')).toISOString(),'2026-03-09T13:30:00.000Z');
 for(const patch of [{strategies:['898新']},{strategies:['AMDL']},{initial_entry_local:day+'T20:00'},{initial_entry_local:day+'T24:00'},{parameters:{D02:{rolling_drop_20m_pct:1.4}}},{parameters:{D01:{min_hold_minutes:1.5}}}])assert.throws(()=>config('10:30',patch));
 assert.deepEqual(config().strategies,['BH00','D01','D02','D03','D04']);
});
test('BH00 integer shares, costs, immutable inputs and common valuation timeline',()=>{
 const rows=flat(),data=input(rows);for(const b of rows){b.open=b.close=b.high=50;b.low=49;}
 rows.at(-1)!.close=rows.at(-1)!.high=60;const before=JSON.stringify(data),run=runBacktest(data,config('10:49'),'fixture');
 const bh=ideal(run,'BH00');assert.equal(bh.summary.finalShares,20);assert.equal(bh.summary.finalAssets,1200);assert.deepEqual(bh.signals.map(s=>s.action),['BUY']);assert.equal(JSON.stringify(data),before);
 for(const r of run.results)assert.deepEqual(r.equityCurve.map(p=>p.time),bh.equityCurve.map(p=>p.time));
 assert.equal(ideal(run).summary.relativeBH,0);const costly=run.results.find(r=>r.strategyId==='BH00'&&r.model==='IDEAL_OHLCV'&&r.costScenario==='10bp')!;assert.equal(costly.summary.finalShares,19);assert.equal(costly.summary.totalCost,.95);
});
test('D01 event clock, expensive R01 rebuy, cash/share accounting and cooldown',()=>{
 const rows=drop();for(let m=601;m<=608;m++)rows[m-570]=bar(m,97);
 rows[609-570]=bar(609,98);for(const [i,c]of [99,99.4,100,100.5,101].entries())rows[610+i-570]=bar(610+i,c);
 rows[615-570]=bar(615,102,10000,102);for(let m=616;m<800;m++)rows[m-570]=bar(m,102);
 const r=ideal(runBacktest(input(rows),config(),'snapshot'));
 const sell=r.signals.find(s=>s.action==='SELL')!,rebuy=r.signals.find(s=>s.action==='REBUY')!;
 assert.equal(sell.signalTimeUtc,new Date(usMinuteUTC(day,600)).toISOString());assert.equal(sell.decisionDataCutoffUtc,sell.signalTimeUtc);
 assert.equal(r.fills.find(f=>f.action==='SELL')!.fillTimeUtc,sell.signalTimeUtc);assert.equal(rebuy.rationale.rule,'BOTTOM_REBOUND');
 assert.equal(r.summary.buyingDear,1);assert.equal(r.summary.finalShares,9);assert.equal(r.summary.cash,62);assert.ok(r.diagnostics.COOLDOWN>0);
 for(const s of r.signals)for(const ref of s.contextBarRefs)assert.ok(Date.parse(ref)<Date.parse(s.decisionDataCutoffUtc));
});
test('D01 needs volume and closed bearish 5m; weak volume or incomplete current 5m cannot sell',()=>{
 const small=drop();small[29].volume=12000;assert.equal(ideal(runBacktest(input(small),config(),'x')).summary.fullExits,0);
 const intrabar=drop(597);const r=ideal(runBacktest(input(intrabar),config('09:58'),'x'));assert.equal(r.summary.fullExits,0);assert.equal(r.signals.filter(s=>s.action==='SELL').length,0);
});
test('missing execution minutes and insufficient volume preserve signals and old position',()=>{
 const rows=drop();rows[30]={...bar(600),open:null,high:null,low:null,close:null,status:'missing'};rows[31]={...rows[30],time:bar(601).time};
 const r=ideal(runBacktest(input(rows),config(),'missing'));assert.equal(r.signals.filter(s=>s.action==='SELL').length,1);assert.equal(r.fills.find(f=>f.action==='SELL')!.fillStatus,'EXPIRED');assert.equal(r.summary.finalShares,10);assert.equal(r.summary.fullExits,0);
 const thin=drop();thin[30].volume=1;const run=runBacktest(input(thin),config(),'thin'),limited=run.results.find(r=>r.strategyId==='D01'&&r.model==='VOLUME_LIMITED'&&r.costScenario==='zero')!;
 assert.equal(limited.fills.find(f=>f.action==='SELL')!.fillReason,'INSUFFICIENT_VOLUME');assert.equal(limited.summary.fullExits,0);assert.equal(limited.summary.finalShares,10);
 assert.equal(limited.signals[1].signalTimeUtc,ideal(run).signals[1].signalTimeUtc,'future volume does not suppress the historical sell signal');
});
test('D02 requires completed 5m structure and threshold changes preserve BH00',()=>{
 const rows=drop(619),data=input(rows),base=config('10:30');const r=ideal(runBacktest(data,base,'x'),'D02');assert.equal(r.signals.find(s=>s.action==='SELL')!.signalTimeUtc,new Date(usMinuteUTC(day,620)).toISOString());
 const high=config('10:30',{parameters:{D02:{rolling_drop_20m_pct:.03}}}),run=runBacktest(data,high,'x');assert.equal(ideal(run,'D02').summary.fullExits,0);assert.deepEqual(ideal(run,'BH00'),ideal(runBacktest(data,base,'x'),'BH00'));
});
test('D03 uses 20 prior independent daily bars, freezes UP state and never uses current daily',()=>{
 const days:InputBar[]=[];let date=addUSDate(day,-1);while(days.length<20){if(usCalendarDay(date).is_trading_day)days.unshift({...bar(570),time:date,date,close:days.length?100:110,open:100,high:110,low:99});date=addUSDate(date,-1);}
 const rows=flat(800);rows[714-570]=bar(714,99);for(let m=715;m<719;m++)rows[m-570]=bar(m,99);rows[719-570]=bar(719,96,20000,99);for(let m=720;m<800;m++)rows[m-570]=bar(m,96);
 const cfg=config('12:10'),run=runBacktest(input(rows,days),cfg,'d03'),r=ideal(run,'D03');assert.equal(r.signals.find(s=>s.action==='SELL')!.rationale.daily_trend,'UP');assert.equal(r.signals.find(s=>s.action==='SELL')!.signalTimeUtc,new Date(usMinuteUTC(day,720)).toISOString());
 assert.deepEqual(r,ideal(runBacktest(input(rows,[...days,{...bar(570),time:day,date:day,close:1000000,high:1000000}]),cfg,'d03'),'D03'));
 assert.equal(ideal(runBacktest(input(rows,days.slice(1)),cfg,'d03'),'D03').summary.fullExits,0);
});
test('D04 reacts to low ATR, refuses same drop in high ATR and freezes reentry threshold',()=>{
 const low=drop(649),run=runBacktest(input(low),config('11:00'),'atr'),r=ideal(run,'D04');assert.equal(r.summary.fullExits,1);assert.equal(r.signals.find(s=>s.action==='SELL')!.rationale.frozen_rebound,.005);
 const high=low.map(b=>({...b,high:106}));assert.equal(ideal(runBacktest(input(high),config('11:00'),'atr'),'D04').summary.fullExits,0);
});
test('R01 failed-exit path needs a later pullback then later reclaim; no forced final buy',()=>{
 const exit:ExitState={reference:100,lowest:Infinity,highest:-Infinity,candidateAt:null,pullbackAt:null,rebound:.5,sellPrice:80,time:0};
 function frame(t:number,c:number,previous:number[]=[100,100,100]):Frame{return {t:t*60000,end:(t+1)*60000,key:'test',bar:{...bar(570),close:c},history:previous.map(c=>({...bar(570),close:c})),five:{key:'test',end:(t+1)*60000,close:102,previousClose:101} as any} as Frame;}
 for(let i=0;i<5;i++)assert.equal(reentryReason(frame(i,102+i),exit,DEFAULT_PARAMETERS),null);
 assert.equal(exit.pullbackAt,null);assert.equal(reentryReason(frame(5,105),exit,DEFAULT_PARAMETERS),null);assert.notEqual(exit.pullbackAt,null);assert.equal(reentryReason(frame(6,105.5),exit,DEFAULT_PARAMETERS)!.rule,'FAILED_EXIT_PULLBACK');
 const rows=drop();for(let m=600;m<800;m++)rows[m-570]=bar(m,100+(m-600)/100);const r=ideal(runBacktest(input(rows),config(),'up'));assert.equal(r.summary.endingState,'CASH');assert.equal(r.signals.filter(s=>s.action==='REBUY').length,0);assert.equal(r.summary.finalAssets,r.summary.cash);
});
test('no future bars, no incomplete five-minute context, no cross-session aggregate, gaps reset',()=>{
 const rows=flat(),cfg=config('09:38'),data=input(rows),short=runBacktest(data,cfg,'prefix');
 const future=rows.map(b=>Date.parse(b.time)>=usMinuteUTC(day,579)?{...b,close:1,low:1}:b);assert.deepEqual(short,runBacktest(input(future),cfg,'prefix'));
 const fs=prepareFrames(data,cfg).frames.filter(f=>f.t>=usMinuteUTC(day,570));assert.ok(fs.every(f=>!f.five||f.five.end<=f.end));assert.equal(fs.at(-1)!.five!.end,usMinuteUTC(day,575));assert.equal(fs.at(-1)!.stats!.count,8);
 const sessions=input([...Array.from({length:10},(_,i)=>bar(565+i))]);const all=prepareFrames(sessions,config('09:35',{initial_entry_local:day+'T09:25',sessions:['pre','regular']})).frames;assert.equal(all.find(f=>f.t===usMinuteUTC(day,570))!.stats!.count,0);assert.equal(all.find(f=>f.t===usMinuteUTC(day,574))!.five!.t,usMinuteUTC(day,570));
 const missing=flat();missing.splice(2,1);const gaps=prepareFrames(input(missing),config()).frames;assert.equal(gaps.find(f=>f.t===usMinuteUTC(day,574))!.five,null);assert.equal(gaps.find(f=>f.t===usMinuteUTC(day,573))!.stats!.count,0);
});
test('all strategies run independently and deterministic snapshots reproduce all scenarios',()=>{
 const rows=drop(619),all=runBacktest(input(rows),config(),'fixed');assert.deepEqual(all,runBacktest(input(rows),config(),'fixed'));
 for(const id of ['D01','D02','D03','D04']){const single=runBacktest(input(rows),config('10:30',{strategies:[id]}),'fixed');assert.deepEqual(single.results.filter(r=>r.strategyId===id),all.results.filter(r=>r.strategyId===id));}
});
test('unaffordable/missing/volume-limited initial fill is not a zero-return success; no partial fills',()=>{
 const data=input(flat().map(b=>({...b,volume:1}))),run=runBacktest(data,config(),'liquidity');for(const r of run.results.filter(r=>r.model==='VOLUME_LIMITED')){assert.equal(r.status,'NOT_COMPARABLE');assert.equal(r.summary.finalAssets,null);assert.equal(r.summary.relativeBH,null);assert.equal(r.summary.finalShares,0);}
 const cfg=config(),fill=simulateFill(1000,0,'BUY',bar(570,50,10),'regular','VOLUME_LIMITED',0,cfg);assert.equal(fill.shares,0);assert.equal(fill.cash,1000);assert.equal(fill.reason,'INSUFFICIENT_VOLUME');
 const impossible=ideal(runBacktest(input([]),cfg,'empty'),'BH00');assert.equal(impossible.status,'NOT_COMPARABLE');assert.equal(impossible.fills[0].fillStatus,'NOT_FILLED');
});

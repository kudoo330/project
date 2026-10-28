/** AMD-only hypothetical research, no broker/account/network operations.
 * Versioned event clock: bars [t,t+1m), decisions at close, fills at next open.
 * This engine is deterministic and does not mutate its immutable inputs. */
import {addUSDate,usCalendarDay,usMinuteUTC,US_CALENDAR,type USSession} from './us-market-calendar';
import {nyParts} from './research-data-validation';
export const ENGINE_VERSION='amd-research@1.0.0';
export const REENTRY_VERSION='R01@1.0.0-amd';
export const STRATEGY_IDS=['BH00','D01','D02','D03','D04'] as const;
export type StrategyId=typeof STRATEGY_IDS[number];
export type FillModel='IDEAL_OHLCV'|'VOLUME_LIMITED';
export interface InputBar {time:string;date:string;open:number|null;high:number|null;low:number|null;close:number|null;volume:number|null;status:string;revision:number;verification:string;reason?:string}
export interface BacktestInput {minutes:readonly InputBar[];daily:readonly InputBar[];minuteSource:Readonly<Record<string,unknown>>;dailySource:Readonly<Record<string,unknown>>|null}
export const DEFAULT_PARAMETERS={
 D01:{drop_3m_pct:.01,break_low_lookback_1m:8,volume_mult:1.5,min_bars_1m:25,min_hold_minutes:15,max_age_of_5m_context_minutes:15},
 D02:{rolling_drop_20m_pct:.014,break_low_1m_lookback:10,break_low_5m_lookback:3,min_hold_minutes:20},
 D03:{up_drop_pct:.025,weak_drop_pct:.016,min_hold_minutes:30,bottom_rebound_pct:.01},
 D04:{atr_mult:1.8,threshold_min:.008,threshold_max:.025,volume_mult:1.25,min_hold_minutes:15,dynamic_reentry:true},
 R01:{bottom_rebound_pct:.008,short_breakout_1m:5,failed_exit_up_pct:.012,pullback_from_new_high_pct:.005,pullback_reclaim_1m:3,cooldown_minutes_after_fill:15},
};
export type Parameters=typeof DEFAULT_PARAMETERS;
export interface BacktestConfig {entry:string;end:string;initialCash:number;strategies:StrategyId[];sessions:USSession[];parameters:Parameters;maxFillDelayMinutes:number;minVolume:number;participationRate:number}
const NAMES={BH00:'Buy & Hold 基准',D01:'1m急跌 / 放量防守',D02:'1m + 5m结构破位',D03:'日线趋势过滤防守',D04:'ATR自适应防守'};
export const MANIFESTS=STRATEGY_IDS.map(strategyId=>({strategyId,version:ENGINE_VERSION,displayName:NAMES[strategyId],symbols:['AMD.US'],timeframes:strategyId==='D03'?['1m','5m','1d']:['1m','5m'],researchOnly:true,status:'RESEARCH_ONLY',parameterSchema:strategyId==='BH00'?{}:DEFAULT_PARAMETERS[strategyId],description:'独立虚拟组合；未验证的研究假设；不是真实交易信号'}));
export const COST_SCENARIOS=[{id:'zero',costBps:0,extendedExtraBps:0},{id:'10bp',costBps:10,extendedExtraBps:0},{id:'20bp',costBps:20,extendedExtraBps:0},{id:'20bp-ext20',costBps:20,extendedExtraBps:20}] as const;
const iso=(t:number)=>new Date(t).toISOString();
const max=(xs:number[])=>Math.max(...xs),min=(xs:number[])=>Math.min(...xs);
const median=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
export function localMinute(value:unknown){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('请输入精确到分钟的美东时间');
 const [day,clock]=value.split('T'),[h,m]=clock.split(':').map(Number);usCalendarDay(day);
 if(h>23||m>59)throw new Error('无效的美东时间');return usMinuteUTC(day,h*60+m);
}
export function normalizeConfig(value:any):BacktestConfig {
 if(!value||typeof value!=='object')throw new Error('需要回测配置');
 const start=localMinute(value.initial_entry_local),end=localMinute(value.end_local)+60000;
 if(start>=end||end-start>184*86400000||end>Date.now())throw new Error('范围须为已结束的历史分钟，且不超过184天');
 const cash=value.initial_cash_usd??460000;if(typeof cash!=='number'||!Number.isFinite(cash)||cash<1||cash>1e9)throw new Error('初始资金须为1至10亿美元');
 if(value.strategies!==undefined&&(!Array.isArray(value.strategies)||value.strategies.some((id:unknown)=>!STRATEGY_IDS.includes(id as StrategyId))))throw new Error('仅支持AMD研究策略BH00、D01—D04');
 const strategies=STRATEGY_IDS.filter(id=>id==='BH00'||(value.strategies??['D01','D02','D03','D04']).includes(id));
 const sessions=value.sessions??['pre','regular','post'];if(!Array.isArray(sessions)||!sessions.length||sessions.some((s:string)=>!['pre','regular','post'].includes(s)))throw new Error('请选择允许的交易时段');
 const entryDay=value.initial_entry_local.slice(0,10),entryMin=+value.initial_entry_local.slice(11,13)*60+ +value.initial_entry_local.slice(14);
 if(!usCalendarDay(entryDay).sessions.some(s=>sessions.includes(s.session)&&entryMin>=s.start_minute&&entryMin<s.end_minute))throw new Error('初始建仓须在选定的交易时段内');
 const supplied=value.parameters??{};if(typeof supplied!=='object'||Array.isArray(supplied))throw new Error('参数必须是对象');
 const parameters=structuredClone(DEFAULT_PARAMETERS);
 for(const [group,patch] of Object.entries(supplied)){
  if(!(group in parameters)||!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('未知策略参数组');
  for(const [key,v] of Object.entries(patch)){
   const original=(parameters as any)[group][key];if(original===undefined)throw new Error('未知参数 '+group+'.'+key);
   if(typeof v!==typeof original||(typeof v==='number'&&(!Number.isFinite(v)||v<=0||v>1000)))throw new Error('参数取值无效 '+key);
   if(typeof v==='number'&&(/lookback|bars|minutes|short_breakout|reclaim/.test(key))&&!Number.isInteger(v))throw new Error('窗口参数须为整数');
   if(typeof v==='number'&&(/pct|threshold/.test(key))&&v>=1)throw new Error('比例参数用小数，例如0.01代表1%');
   (parameters as any)[group][key]=v;
  }
 }
 if(parameters.D04.threshold_min>parameters.D04.threshold_max)throw new Error('ATR阈值上下限顺序错误');
 const delay=value.max_fill_delay_minutes??1,volume=value.min_volume_1m??1,rate=value.max_participation_rate??.05;
 if(![1,5].includes(delay)||!Number.isSafeInteger(volume)||volume<0||volume>1e12||typeof rate!=='number'||!Number.isFinite(rate)||rate<=0||rate>1)throw new Error('撮合参数无效');
 return {entry:iso(start),end:iso(end),initialCash:cash,strategies,sessions:[...new Set(sessions)] as USSession[],parameters,maxFillDelayMinutes:delay,minVolume:volume,participationRate:rate};
}
interface Five {t:number;end:number;key:string;open:number;low:number;close:number;ema8:number|null;ema20:number|null;atr:number|null;previousClose:number|null;previousEMA20:number|null;previousLow:number[];previousKey:string|null}
interface FrameStats {count:number;lowD01:number|null;lowD02:number|null;low8:number|null;low10:number|null;high20:number|null;high60:number|null;close3:number|null;close5:number|null;volumeMedian:number|null;breakout:number|null;reclaim:number|null}
function frameStats(history:readonly InputBar[],p:Parameters):FrameStats {
 const lows=(n:number)=>history.length<n?null:min(history.slice(-n).map(b=>b.low!)),highs=(n:number)=>history.length<n?null:max(history.slice(-n).map(b=>b.close!));
 const vols=history.slice(-20);return {count:history.length,lowD01:lows(p.D01.break_low_lookback_1m),lowD02:lows(p.D02.break_low_1m_lookback),low8:lows(8),low10:lows(10),high20:highs(20),high60:highs(59),close3:history.at(-3)?.close??null,close5:history.at(-5)?.close??null,volumeMedian:vols.length===20&&vols.every(b=>b.volume!==null)?median(vols.map(b=>b.volume!)):null,breakout:highs(p.R01.short_breakout_1m),reclaim:highs(p.R01.pullback_reclaim_1m)};
}
const EMPTY_HISTORY:readonly InputBar[]=[];
export interface Frame {t:number;end:number;date:string;session:USSession;key:string;bar:InputBar|null;valid:boolean;history:readonly InputBar[];five:Five|null;dailyTrend:'UP'|'WEAK'|null;stats?:FrameStats}
function emaUpdate(xs:number[],old:number|null,n:number){if(xs.length<n)return null;return old===null?xs.slice(-n).reduce((a,b)=>a+b,0)/n:old+2/(n+1)*(xs.at(-1)!-old);}
function validBar(b:InputBar|undefined):b is InputBar{return !!b&&b.status==='available'&&[b.open,b.high,b.low,b.close].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)&&b.low!<=Math.min(b.open!,b.close!)&&b.high!>=Math.max(b.open!,b.close!)&&b.low!<=b.high!;}
/** Missing minutes reset affected rolling indicators; session boundaries reset 1m
 * windows, while EMA/ATR may warm across sessions/dates on complete 5m bars. */
export function prepareFrames(input:BacktestInput,config:BacktestConfig){
 const entries=new Map(input.minutes.map(b=>[Date.parse(b.time),b]));if(entries.size!==input.minutes.length)throw new Error('分钟快照含重复时间');
 const dailies=new Map(input.daily.map(b=>[b.date,b]));if(dailies.size!==input.daily.length)throw new Error('日线快照含重复日期');
 const entry=Date.parse(config.entry),end=Date.parse(config.end),warmDate=addUSDate(nyParts(new Date(entry)).date,-14),start=warmDate<US_CALENDAR.from?US_CALENDAR.from:warmDate,last=nyParts(new Date(end-1)).date;
 const historyLimit=Math.max(60,config.parameters.D01.break_low_lookback_1m,config.parameters.D01.min_bars_1m,config.parameters.D02.break_low_1m_lookback,config.parameters.R01.short_breakout_1m,config.parameters.R01.pullback_reclaim_1m),fiveLimit=Math.max(3,config.parameters.D02.break_low_5m_lookback);
 let history:InputBar[]=[],five:Five|null=null,fiveHistory:Five[]=[],closes:number[]=[],trs:number[]=[],e8:number|null=null,e20:number|null=null,atr:number|null=null,prevClose:number|null=null;
 const frames:Frame[]=[],quality={expected_minutes:0,available_minutes:0,missing_minutes:0,unknown_volume_minutes:0,incomplete_5m:0,daily_warmup_days:[] as string[],warmup_start:start,calendar:US_CALENDAR.id,indicator_gap_policy:'reset affected windows; no fill-forward',session_coverage:{pre:{expected:0,available:0},regular:{expected:0,available:0},post:{expected:0,available:0}}};
 const reset=()=>{history=[];five=null;fiveHistory=[];closes=[];trs=[];e8=null;e20=null;atr=null;prevClose=null;};
 for(let date=start;date<=last;date=addUSDate(date,1)){
  const calendar=usCalendarDay(date);if(!calendar.is_trading_day)continue;
  const days:InputBar[]=[];let d=addUSDate(date,-1);
  while(days.length<20&&d>=US_CALENDAR.from){if(usCalendarDay(d).is_trading_day){const b=dailies.get(d);if(!validBar(b))break;days.unshift(b);}d=addUSDate(d,-1);}
  const dailyTrend=days.length<20?null:days.at(-1)!.close!>days.reduce((s,b)=>s+b.close!,0)/20&&days.slice(-10).reduce((s,b)=>s+b.close!,0)/10>=days.reduce((s,b)=>s+b.close!,0)/20?'UP':'WEAK';
  if(dailyTrend===null&&usMinuteUTC(date,1200)>entry)quality.daily_warmup_days.push(date);
  for(const session of calendar.sessions){
   if(!config.sessions.includes(session.session))continue;
   history=[];const key=date+'|'+session.session,sessionStart=usMinuteUTC(date,session.start_minute);let bucket:InputBar[]=[];
   for(let minute=session.start_minute;minute<session.end_minute;minute++){
    const t=sessionStart+(minute-session.start_minute)*60000,finish=t+60000;if(finish>end)break;
    const raw=entries.get(t),valid=validBar(raw),bar=valid?raw:null;
    if(t>=entry){quality.expected_minutes++;quality.session_coverage[session.session].expected++;if(valid){quality.available_minutes++;quality.session_coverage[session.session].available++;if(bar!.volume===null)quality.unknown_volume_minutes++;}else quality.missing_minutes++;}
    if(!valid){reset();bucket=[];}
    if((minute-session.start_minute)%5===0)bucket=[];
    if(bar)bucket.push(bar);
    if((minute-session.start_minute)%5===4){
     if(bucket.length===5&&bucket.every(b=>b.volume!==null)){
      const close=bucket[4].close!,low=min(bucket.map(b=>b.low!)),high=max(bucket.map(b=>b.high!));closes.push(close);if(closes.length>25)closes.shift();
      const tr=prevClose===null?high-low:Math.max(high-low,Math.abs(high-prevClose),Math.abs(low-prevClose));trs.push(tr);if(trs.length>14)trs.shift();
      e8=emaUpdate(closes,e8,8);e20=emaUpdate(closes,e20,20);atr=trs.length<14?null:atr===null?trs.reduce((a,b)=>a+b,0)/14:(atr*13+tr)/14;
      five={t:t-4*60000,end:finish,key,open:bucket[0].open!,low,close,ema8:e8,ema20:e20,atr,previousClose:prevClose,previousEMA20:fiveHistory.at(-1)?.ema20??null,previousLow:fiveHistory.map(b=>b.low),previousKey:fiveHistory.at(-1)?.key??null};
      fiveHistory.push(five);if(fiveHistory.length>fiveLimit)fiveHistory.shift();prevClose=close;
     }else {if(t>=entry)quality.incomplete_5m++;five=null;fiveHistory=[];closes=[];trs=[];e8=null;e20=null;atr=null;prevClose=null;}
    }
    // History excludes the current minute. Keep enough for adjustable windows.
    if(t>=entry)frames.push({t,end:finish,date,session:session.session,key,bar,valid,history:EMPTY_HISTORY,stats:frameStats(history,config.parameters),five,dailyTrend});
    if(bar){history.push(bar);if(history.length>historyLimit)history.shift();}
   }
  }
 }
 return {frames,quality};
}
function sellReason(id:StrategyId,f:Frame,p:Parameters):Record<string,unknown>|null {
 if(!f.bar)return null;const b=f.bar,c=b.close!,s=f.stats??frameStats(f.history,p),last=f.five;
 if(!last||last.end>f.end||f.end-last.end>15*60000)return null;
 if(id==='D01'){
  const q=p.D01;if(s.count+1<q.min_bars_1m||s.lowD01===null||s.close3===null||s.volumeMedian===null||b.volume===null||f.end-last.end>q.max_age_of_5m_context_minutes*60000)return null;
  const drop=c/s.close3-1,vol=s.volumeMedian;
  if(drop<=-q.drop_3m_pct&&c<s.lowD01&&vol>0&&b.volume>=q.volume_mult*vol&&(last.close<last.open||(last.previousClose!==null&&last.close<last.previousClose)))return {rule:'D01',drop,prior_low:s.lowD01,volume_ratio:b.volume/vol,five_close:last.close};
 }
 if(id==='D02'){
  const q=p.D02;if(s.high20===null||s.lowD02===null||last.key!==f.key||last.previousLow.length<q.break_low_5m_lookback||last.ema8===null)return null;
  const high=Math.max(s.high20,c),drop=(high-c)/high,fiveLow=min(last.previousLow.slice(-q.break_low_5m_lookback));
  if(drop>=q.rolling_drop_20m_pct&&c<s.lowD02&&last.close<fiveLow&&last.close<last.ema8)return {rule:'D02',drop,prior_five_low:fiveLow,ema8:last.ema8};
 }
 if(id==='D03'){
  if(s.high60===null||s.low10===null||!f.dailyTrend||last.key!==f.key||last.previousKey!==f.key||last.ema20===null||last.previousEMA20===null||last.previousClose===null)return null;
  const high=Math.max(s.high60,c),drop=(high-c)/high,threshold=f.dailyTrend==='UP'?p.D03.up_drop_pct:p.D03.weak_drop_pct;
  if(drop>=threshold&&c<s.low10&&last.close<last.ema20&&last.previousClose<last.previousEMA20&&last.close<last.previousClose)return {rule:'D03',daily_trend:f.dailyTrend,drop,threshold};
 }
 if(id==='D04'){
  const q=p.D04;if(s.low8===null||s.volumeMedian===null||s.close5===null||last.atr===null||last.previousClose===null||b.volume===null)return null;
  const normalized=last.atr/last.close,threshold=Math.min(q.threshold_max,Math.max(q.threshold_min,q.atr_mult*normalized)),drop=c/s.close5-1,vol=s.volumeMedian;
  if(drop<=-threshold&&c<s.low8&&last.close<last.previousClose&&vol>0&&b.volume>=q.volume_mult*vol)return {rule:'D04',drop,threshold,normalized_atr:normalized,frozen_rebound:q.dynamic_reentry?Math.min(.012,Math.max(.005,.8*normalized)):p.R01.bottom_rebound_pct};
 }
 return null;
}
export interface ExitState {reference:number;lowest:number;highest:number;candidateAt:number|null;pullbackAt:number|null;rebound:number;sellPrice:number;time:number}
export function reentryReason(f:Frame,exit:ExitState,p:Parameters):Record<string,unknown>|null {
 if(!f.bar)return null;const c=f.bar.close!,q=p.R01;exit.lowest=Math.min(exit.lowest,c);exit.highest=Math.max(exit.highest,c);
 // Three distinct observations: failed-exit high, later pullback, later reclaim.
 if(exit.candidateAt===null&&exit.highest/exit.reference-1>=q.failed_exit_up_pct)exit.candidateAt=f.end;
 if(exit.candidateAt!==null&&f.end>exit.candidateAt&&exit.pullbackAt===null&&1-c/exit.highest>=q.pullback_from_new_high_pct)exit.pullbackAt=f.end;
 const five=f.five;if(!five||five.key!==f.key||f.end-five.end>15*60000||five.previousClose===null||five.close<=five.previousClose)return null;
 const stats=f.stats??frameStats(f.history,p);
 const bottom=stats.breakout!==null&&c/exit.lowest-1>=exit.rebound&&c>stats.breakout;
 const failure=exit.pullbackAt!==null&&f.end>exit.pullbackAt&&stats.reclaim!==null&&c>stats.reclaim;
 return bottom||failure?{rule:bottom?'BOTTOM_REBOUND':'FAILED_EXIT_PULLBACK',bottom_rebound:bottom,failed_exit_pullback:failure,lowest:exit.lowest,highest:exit.highest,rebound_threshold:exit.rebound,candidate_at:exit.candidateAt===null?null:iso(exit.candidateAt),pullback_at:exit.pullbackAt===null?null:iso(exit.pullbackAt)}:null;
}
export interface Signal {id:string;strategyId:StrategyId;strategyVersion:string;symbol:'AMD.US';action:'BUY'|'SELL'|'REBUY';signalTimeUtc:string;decisionDataCutoffUtc:string;rationale:Record<string,unknown>;parametersSnapshot:unknown;contextBarRefs:string[];inputDataRevision:string;status:'research_signal'}
export interface VirtualFill {signalId:string;action:Signal['action'];instrument:'AMD.US';candidateTimeUtc:string;candidatePrice:number|null;liquidityStatus:string;dataQuality:string;barRevision:number|null;simulatedNotional:number;fillTimeUtc:string|null;fillPrice:number|null;simulatedQty:number;cashAfter:number;positionAfter:number;costBps:number;cost:number;fillStatus:'FILLED'|'NOT_FILLED'|'EXPIRED';fillReason:string;session:USSession|null;buyingDear:boolean;priceVsLastSell:number|null;source:Readonly<Record<string,unknown>>;status:'simulated_fill'}
export function simulateFill(cash:number,shares:number,action:Signal['action'],bar:InputBar|null,session:USSession|null,model:FillModel,costBps:number,config:BacktestConfig){
 const raw=validBar(bar??undefined)?bar!.open!:null,qty=action==='SELL'?shares:raw===null?0:Math.floor(cash/(raw*(1+costBps/10000)));
 const required=raw===null?'NO_VALID_MINUTE':qty<1?'NO_AFFORDABLE_INTEGER_SHARE':model==='VOLUME_LIMITED'&&(bar!.volume===null||bar!.volume<config.minVolume||qty>bar!.volume*config.participationRate)?'INSUFFICIENT_VOLUME':null;
 if(required)return {cash,shares,qty:0,raw,cost:0,reason:required};
 const notional=raw!*qty,cost=notional*costBps/10000;
 const nextCash=action==='SELL'?cash+notional-cost:cash-notional-cost;
 if(nextCash<-.000001)throw new Error('Negative virtual cash');
 return {cash:Math.max(0,nextCash),shares:action==='SELL'?0:qty,qty,raw,cost,reason:null};
}
function oneRun(id:StrategyId,frames:Frame[],config:BacktestConfig,input:BacktestInput,model:FillModel,scenario:typeof COST_SCENARIOS[number],snapshotId:string){
 let cash=config.initialCash,shares=0,lastFill=0,exit:ExitState|null=null,pending:Signal|null=null,exitSignal:Signal|null=null,initialValid=false,initialDone=false,highEquity=config.initialCash,maxDrawdown=0,lastPrice:number|null=null,lastPriceTime:number|null=null,maxWait=0,sells=0,dear=0,totalCost=0,first=Date.parse(config.entry),end=Date.parse(config.end),lastSignalId=0;
 const signals:Signal[]=[],fills:VirtualFill[]=[],positionChanges:Record<string,unknown>[]=[],curve:{time:string;equity:number|null;priceAgeMinutes:number|null}[]=[],diagnostics:Record<string,number>={WARMUP:0,DATA_INSUFFICIENT:0,COOLDOWN:0,DAILY_WARMUP:0,VOLUME_BASELINE_UNAVAILABLE:0};
 const active=frames.filter(f=>f.t>=first&&f.end<=end),stride=Math.max(1,Math.ceil(active.length/800));
 const signal=(action:Signal['action'],f:Frame,rationale:Record<string,unknown>,initial=false):Signal=>{
  const at=initial?f.t:f.end;
  const s:Signal={id:`${id}-${++lastSignalId}`,strategyId:id,strategyVersion:ENGINE_VERSION,symbol:'AMD.US',action,signalTimeUtc:iso(at),decisionDataCutoffUtc:iso(at),rationale,parametersSnapshot:{strategy:id==='BH00'?{}:config.parameters[id],reentry:config.parameters.R01},contextBarRefs:initial?[]:[iso(f.t),...(f.five?[iso(f.five.t)]:[])],inputDataRevision:snapshotId,status:'research_signal'};
  signals.push(s);return s;
 };
 const execute=(s:Signal,f:Frame|null,at:number)=>{
  const session=f?.session??null,bps=scenario.costBps+(session&&session!=='regular'?scenario.extendedExtraBps:0),out=simulateFill(cash,shares,s.action,f?.bar??null,session,model,bps,config),filled=!out.reason;
  const fill:VirtualFill={signalId:s.id,action:s.action,instrument:'AMD.US',candidateTimeUtc:iso(at),candidatePrice:out.raw,liquidityStatus:out.reason??(model==='IDEAL_OHLCV'?'NOT_CHECKED_IDEAL':'PASSED_POST_HOC_VOLUME_CHECK'),dataQuality:f?.bar?.verification??'missing',barRevision:f?.bar?.revision??null,simulatedNotional:filled?out.qty*out.raw!:0,fillTimeUtc:filled?iso(at):null,fillPrice:filled?out.raw:null,simulatedQty:out.qty,cashAfter:out.cash,positionAfter:out.shares,costBps:bps,cost:out.cost,fillStatus:filled?'FILLED':'NOT_FILLED',fillReason:out.reason??(model==='IDEAL_OHLCV'?'THEORETICAL_FULL_OPEN_FILL':'POST_HOC_VOLUME_ELIGIBILITY'),session,buyingDear:filled&&s.action==='REBUY'&&!!exit&&out.raw!>exit.sellPrice,priceVsLastSell:filled&&s.action==='REBUY'&&exit?out.raw!/exit.sellPrice-1:null,source:input.minuteSource,status:'simulated_fill'};
  fills.push(fill);
  if(!filled)return false;
  const oldShares=shares;cash=out.cash;shares=out.shares;lastFill=at;totalCost+=out.cost;
  positionChanges.push({time:iso(at),signalId:s.id,from:oldShares?'LONG_AMD':'CASH',to:shares?'LONG_AMD':'CASH',shares,cash});
  if(s.action==='SELL'){
   sells++;const ref=Number(s.rationale.amd_reference),rebound=id==='D03'?config.parameters.D03.bottom_rebound_pct:Number(s.rationale.frozen_rebound??config.parameters.R01.bottom_rebound_pct);
   exit={reference:ref,lowest:Infinity,highest:-Infinity,candidateAt:null,pullbackAt:null,rebound,sellPrice:out.raw!,time:at};exitSignal=s;
  }else {if(fill.buyingDear)dear++;if(exit)maxWait=Math.max(maxWait,at-exit.time);exit=null;exitSignal=null;}
  return true;
 };
 for(let index=0;index<active.length;index++){
  const f=active[index];
  if(!initialDone){initialDone=true;const s=signal('BUY',f,{rule:'EXTERNAL_INITIAL_ENTRY',initial_fill_assumption:'AMD_1M_OPEN_AT_TIME'},true);initialValid=f.t===first&&execute(s,f,first);if(!initialValid){if(!fills.length)execute(s,null,first);}}
  if(pending){
   const created=Date.parse(pending.signalTimeUtc),deadline=created+config.maxFillDelayMinutes*60000;
   if(f.t<=deadline&&f.valid){execute(pending,f,f.t);pending=null;}else if(f.t>=deadline){execute(pending,null,created);fills.at(-1)!.fillStatus='EXPIRED';pending=null;}
  }
  if(f.bar){lastPrice=f.bar.close;lastPriceTime=f.end;}
  const rebuyReason=exit&&f.valid?reentryReason(f,exit,config.parameters):null;
  if(initialValid&&id!=='BH00'&&!pending){
   if(!f.valid)diagnostics.DATA_INSUFFICIENT++;
   else if(f.end-lastFill<config.parameters.R01.cooldown_minutes_after_fill*60000)diagnostics.COOLDOWN++;
   else if(shares){
    const hold=(config.parameters as any)[id].min_hold_minutes;
    if(f.end-lastFill<hold*60000)diagnostics.COOLDOWN++;
    else {if(id==='D03'&&!f.dailyTrend)diagnostics.DAILY_WARMUP++;
     const stats=f.stats??frameStats(f.history,config.parameters),needed=id==='D01'?config.parameters.D01.min_bars_1m-1:id==='D03'?59:20;
     if(stats.count<needed||!f.five||(id==='D02'&&f.five.ema8===null)||(id==='D03'&&f.five.ema20===null)||(id==='D04'&&f.five.atr===null))diagnostics.WARMUP++;
     if((id==='D01'||id==='D04')&&(stats.volumeMedian===null||stats.volumeMedian===0||f.bar!.volume===null))diagnostics.VOLUME_BASELINE_UNAVAILABLE++;
     const reason=sellReason(id,f,config.parameters);if(reason)pending=signal('SELL',f,{...reason,amd_reference:f.bar!.close});}
   }else if(exit){if(rebuyReason)pending=signal('REBUY',f,{...rebuyReason,amd_reference:f.bar!.close,exit_signal_id:(exitSignal as Signal|null)?.id});}
  }
  const equity=initialValid&&lastPrice!==null?cash+shares*lastPrice:null;
  if(equity!==null){highEquity=Math.max(highEquity,equity);maxDrawdown=Math.max(maxDrawdown,1-equity/highEquity);}
  if(index%stride===0||index===active.length-1)curve.push({time:iso(f.end),equity,priceAgeMinutes:lastPriceTime===null?null:(f.end-lastPriceTime)/60000});
 }
 if(!initialDone){const dummy={t:first} as Frame,s=signal('BUY',dummy,{rule:'INITIAL_DATA_UNAVAILABLE'},true);execute(s,null,first);}
 if(pending){execute(pending,null,Date.parse(pending.signalTimeUtc));fills.at(-1)!.fillStatus='EXPIRED';fills.at(-1)!.fillReason='END_OF_WINDOW';}
 const finalExit=exit as ExitState|null;if(finalExit)maxWait=Math.max(maxWait,end-finalExit.time);
 const comparable=initialValid&&lastPrice!==null,assets=comparable?cash+shares*lastPrice!:null;
 return {strategyId:id,version:ENGINE_VERSION,model,costScenario:scenario.id,costBps:scenario.costBps,extendedExtraBps:scenario.extendedExtraBps,status:comparable?'RESEARCH_ONLY':'NOT_COMPARABLE',signals,fills,positionChanges,equityCurve:curve,diagnostics,summary:{finalAssets:assets,relativeBH:null as number|null,returnPct:assets===null?null:assets/config.initialCash-1,finalShares:shares,cash,maxDrawdown:comparable?maxDrawdown:null,fullExits:sells,buyingDear:dear,maxCashWaitMinutes:maxWait/60000,executionFailureRate:fills.length?fills.filter(f=>f.fillStatus!=='FILLED').length/fills.length:0,totalCost,markPrice:lastPrice,markTime:lastPriceTime===null?null:iso(lastPriceTime),markAgeMinutes:lastPriceTime===null?null:(end-lastPriceTime)/60000,endingState:shares?'LONG_AMD':'CASH',initialFillAssumption:'AMD_1M_OPEN_AT_TIME'}};
}
export function runBacktest(input:BacktestInput,config:BacktestConfig,snapshotId:string){
 const prepared=prepareFrames(input,config),results=[];
 for(const model of ['IDEAL_OHLCV','VOLUME_LIMITED'] as const)for(const scenario of COST_SCENARIOS){
  const same=config.strategies.map(id=>oneRun(id,prepared.frames,config,input,model,scenario,snapshotId)),bh=same.find(r=>r.strategyId==='BH00')!;
  for(const result of same)if(result.summary.finalAssets!==null&&bh.summary.finalAssets!==null)result.summary.relativeBH=result.summary.finalAssets-bh.summary.finalAssets;
  results.push(...same);
 }
 return {engineVersion:ENGINE_VERSION,reentryVersion:REENTRY_VERSION,symbol:'AMD.US',researchOnly:true,priceValidation:'UNVERIFIED — independent historical verification and out-of-sample validation pending',config,snapshotId,quality:prepared.quality,results};
}

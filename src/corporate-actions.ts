import {afterBuyWindow} from './observation-window';
import dates from './calendar.json';
import type {Bar,RecordRow} from './types';
export interface CorporateSource {status:'available'|'unavailable';factors:{date:string;factor:number}[];qfq:Bar[];fetchedAt:string;error?:string}
export interface ConfirmedCashDividend {cashPerShare:number;source:'admin-confirmed';reason:string;confirmedBy:string;confirmedAt:string}
export function confirmedCashDividends(data:any):Record<string,ConfirmedCashDividend>{
  const entries=data?.confirmed_cash_dividends;
  if(!entries||typeof entries!=='object'||Array.isArray(entries))return {};
  return Object.fromEntries(Object.entries(entries).filter(([day,e]:[string,any])=>dates.includes(day)&&e?.source==='admin-confirmed'&&typeof e.cashPerShare==='number'&&Number.isFinite(e.cashPerShare)&&e.cashPerShare>0&&typeof e.reason==='string'&&e.reason.trim()&&typeof e.confirmedBy==='string'&&Number.isFinite(Date.parse(e.confirmedAt)))) as Record<string,ConfirmedCashDividend>;
}
export interface Adjustment {status:'verified'|'no_action'|'pending'|'completed_unchanged';anchor:string;frozen:boolean;baseMultiplier:number;dateMultipliers:Record<string,number>;events:{date:string;factor:number}[];checkedAt:string;reason:string;verification?:'dual-source'|'admin-cash-dividend'}
export function factorAt(factors:CorporateSource['factors'],date:string){return factors.filter(f=>f.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).at(-1)?.factor??null;}
// Cash-only exceptions must explain BOTH vendor methods: Sina's proportional
// factor and Tencent's additive cash adjustment. Never waive arbitrary conflicts.
function cashMethodsAgree(record:RecordRow,bars:Bar[],source:CorporateSource,buy:string,anchor:string){
  let confirmed:Record<string,ConfirmedCashDividend>={};try{confirmed=confirmedCashDividends(JSON.parse(record.market_data??'{}'));}catch{}
  const factors=[...source.factors].sort((x,y)=>x.date.localeCompare(y.date));
  const changes=factors.filter((f,i)=>i>0&&f.date>buy&&f.date<=anchor&&Math.abs(f.factor/factors[i-1].factor-1)>1e-10);
  if(!changes.length)return false;
  const applicable=Object.keys(confirmed).filter(d=>d>buy&&d<=anchor);
  if(applicable.length!==changes.length||applicable.some(d=>!changes.some(f=>f.date===d)))return false;
  for(const change of changes){
    const e=confirmed[change.date],priorDay=dates[dates.indexOf(change.date)-1];
    const prior=bars.find(b=>b.date===priorDay),before=factorAt(factors,priorDay);
    if(!e||!prior||prior.crossCheck?.status!=='matched'||!before||!(prior.close>e.cashPerShare))return false;
    if(Math.abs(before/change.factor-(prior.close-e.cashPerShare)/prior.close)>1e-8)return false;
  }
  for(const bar of bars.filter(b=>b.date>=buy&&b.date<=anchor)){
    if(bar.crossCheck?.status!=='matched')return false;
    const expected=source.qfq.find(q=>q.date===bar.date)?.close;
    const cash=changes.filter(f=>f.date>bar.date).reduce((sum,f)=>sum+confirmed[f.date].cashPerShare,0);
    if(!expected||Math.abs(bar.close-cash-expected)>.021)return false;
  }
  return true;
}
export function corporateAdjustment(record:RecordRow,bars:Bar[],source:CorporateSource|undefined,today:string,asOf=today):Adjustment{
  let previous:Adjustment|undefined;try{previous=JSON.parse(record.market_data??'{}').adjustment;}catch{}
  const window=afterBuyWindow(record),end=window.at(-1),buy=record.buy_time.slice(0,10),anchor=dates.filter(d=>d<=asOf).at(-1)??asOf;
  const empty:Adjustment={status:'pending',anchor,frozen:false,baseMultiplier:1,dateMultipliers:{},events:[],checkedAt:source?.fetchedAt??'',reason:''};
  if(!end||window.length!==10)return {...empty,reason:'市场日历尚未完整覆盖后10个交易日，无法核实除权窗口'};
  // A finished sample never adopts factors from a new corporate action.
  if(today>end){
    if(previous?.frozen)return previous;
    if(previous)return {...previous,status:'pending',frozen:true,reason:'10日窗口已结束，但未形成D+10复权快照；保留原口径，需人工核对'};
    return {...empty,status:'completed_unchanged',frozen:true,reason:'既有10日窗口已结束，不自动改动历史价格口径'};
  }
  if(anchor<buy)return {...empty,reason:'尚未形成买入日完整收盘，不调整计算口径'};
  if(!source||source.status!=='available')return {...empty,reason:source?.error??'复权因子来源不可用，暂停收益计算'};
  const b=factorAt(source.factors,buy),a=factorAt(source.factors,anchor);
  if(!b||!a||!Number.isFinite(a/b))return {...empty,reason:'缺少买入日或当前日复权因子'};
  if(Math.abs(b/a-1)>1e-10&&!bars.some(v=>v.date===buy))return {...empty,reason:'缺少交叉验证通过的买入日日线，无法核对买入基准的调整因子'};
  const current=bars.find(b=>b.date===anchor),qCurrent=source.qfq.find(b=>b.date===anchor);
  if(!current||!qCurrent||qCurrent.close<=0)return {...empty,reason:'缺少同日完整收盘，复权口径待核对'};
  const scale=current.close/qCurrent.close,dateMultipliers:Record<string,number>={};
  for(const day of [buy,...window]){const f=factorAt(source.factors,day);if(f)dateMultipliers[day]=day>anchor?1:f/a;}
  const qfq=new Map(source.qfq.map(b=>[b.date,b.close]));
  let methodConflict=false;
  for(const bar of bars.filter(v=>v.date>=buy&&v.date<=anchor)){
    const expected=qfq.get(bar.date),mult=dateMultipliers[bar.date];
    // Tencent daily prices are quoted to cents. Normalising its rounded anchor
    // adds at most two ticks of rounding; larger differences block adjustment.
    if(!expected||!mult||Math.abs(bar.close*mult-expected*scale)>.021)methodConflict=true;
  }
  if(methodConflict&&!cashMethodsAgree(record,bars,source,buy,anchor))return {...empty,reason:'新浪复权因子与腾讯前复权日线不一致，暂停调整及收益统计'};
  const factors=[...source.factors].sort((x,y)=>x.date.localeCompare(y.date));
  const events=factors.filter((f,i)=>f.date>buy&&f.date<=anchor&&i>0&&Math.abs(f.factor/factors[i-1].factor-1)>1e-10);
  return {status:events.length?'verified':'no_action',anchor,frozen:anchor===end,baseMultiplier:b/a,dateMultipliers,events,checkedAt:source.fetchedAt,verification:methodConflict?'admin-cash-dividend':'dual-source',reason:methodConflict?'现金分红方案经管理员人工确认；已核验新浪比例因子与腾讯减息口径，计算价格及买入基准同比例调整，原价保留':events.length?'按当前除权后口径前复权；原始成交价与行情保留':'本观察期截至当前未检测到因子变化'};
}

import {afterBuyWindow} from './observation-window';
import dates from './calendar.json';
import type {Bar,RecordRow} from './types';
export interface CorporateSource {status:'available'|'unavailable';factors:{date:string;factor:number}[];qfq:Bar[];fetchedAt:string;error?:string}
export interface Adjustment {status:'verified'|'no_action'|'pending'|'completed_unchanged';anchor:string;frozen:boolean;baseMultiplier:number;dateMultipliers:Record<string,number>;events:{date:string;factor:number}[];checkedAt:string;reason:string}
export function factorAt(factors:CorporateSource['factors'],date:string){return factors.filter(f=>f.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).at(-1)?.factor??null;}
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
  for(const bar of bars.filter(v=>v.date>=buy&&v.date<=anchor)){
    const expected=qfq.get(bar.date),mult=dateMultipliers[bar.date];
    // Tencent daily prices are quoted to cents. Normalising its rounded anchor
    // adds at most two ticks of rounding; larger differences block adjustment.
    if(!expected||!mult||Math.abs(bar.close*mult-expected*scale)>.021)return {...empty,reason:'新浪复权因子与腾讯前复权日线不一致，暂停调整及收益统计'};
  }
  const factors=[...source.factors].sort((x,y)=>x.date.localeCompare(y.date));
  const events=factors.filter((f,i)=>f.date>buy&&f.date<=anchor&&i>0&&Math.abs(f.factor/factors[i-1].factor-1)>1e-10);
  return {status:events.length?'verified':'no_action',anchor,frozen:anchor===end,baseMultiplier:b/a,dateMultipliers,events,checkedAt:source.fetchedAt,reason:events.length?'按当前除权后口径前复权；原始成交价与行情保留':'本观察期截至当前未检测到因子变化'};
}

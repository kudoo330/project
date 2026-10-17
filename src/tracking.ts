import dates from './calendar.json';
import type { Bar, RecordRow } from './types';
import { change, closedBars, extrema, indicators, shanghaiNow } from './domain';
import type {Adjustment} from './corporate-actions';
export const calendarInfo={source:'新浪独立沪深交易日历，经AKShare读取',fetchedAt:'2026-10-16',start:dates[0],end:dates.at(-1),officialVerified:false};
export function track(record:RecordRow, now=new Date()) {
  const date=record.buy_time.slice(0,10),index=dates.indexOf(date),local=shanghaiNow(now);
  let data: {bars?:Bar[];validation?:{date:string;status:string}[];adjustment?:Adjustment}={};try{data=JSON.parse(record.market_data??'{}');}catch{}
  const bars=closedBars(data.bars??[],now),byDate=new Map(bars.map(b=>[b.date,b]));
  let minuteClose=false,referenceConflict=false;try{const e=JSON.parse(record.reference_evidence??'{}');minuteClose=e.field==='close';referenceConflict=minuteClose&&e.cross_verified===false&&(e.quotes?.length??0)>1;}catch{}
  const rawBase=record.actual_price??record.reference_price,a=data.adjustment;
  const adjusted=a?.status==='verified'||a?.status==='no_action';
  const adjustmentPending=a?.status==='pending';
  const base=rawBase===null?null:rawBase*(adjusted?a!.baseMultiplier:1);
  const blocked=record.symbol.endsWith('.BJ')?'北交所日历尚未核实':index<0?'买入日不在已加载交易日历':'公司行动尚未自动核实，以下仅为未复权价格观察';
  const time=record.buy_time.slice(11,19),inSession=time>='09:30:00'&&time<='11:30:00'||time>='13:00:00'&&time<='15:00:00';
  const calendarUsable=!record.symbol.endsWith('.BJ')&&index>=0&&inSession;
  const window=Array.from({length:11},(_,n)=>{
    const day=n===0&&inSession?date:calendarUsable?dates[index+n]??null:null;
    const b=day?byDate.get(day):undefined;
    const conflict=day?data.validation?.some(v=>v.date===day&&v.status!=='matched'):false;
    const checked=day!==null&&(n===0&&b?.crossCheck?.status==='matched'||adjusted&&day<=a!.anchor||record.checked_through!==null&&day<=record.checked_through);
    const close=b?b.close*(adjusted&&day?a!.dateMultipliers[day]??1:1):null;
    const state=!day?'日历待核实':day>local.slice(0,10)?'待更新':day===local.slice(0,10)&&local.slice(11)<'16:00:00'?'盘中，未确认收盘':!b?'缺少有效报价':base===null?'待补价':!checked?'公司行动口径待核对':'有效价格观察';
    return {n,date:day,close,rawClose:b?.close??null,value:close!==null&&checked&&!conflict&&(!adjustmentPending||n===0)?change(n===0?b!.close:close,n===0?rawBase:base):null,state:adjustmentPending&&n>0?'除权口径待核对':conflict?'收盘价交叉核对待确认':state};
  });
  const complete=window.slice(1).every(w=>w.value!==null);
  const ended=window[10].date!==null&&window[10].date<local.slice(0,10);
  return {window,base,rawBase,adjustment:a??null,baseType:(record.actual_price!==null?'实际成交价':record.reference_price!==null?(minuteClose?(referenceConflict?'分钟收盘参考价（两源有差异）':'分钟收盘参考价（暂估）'):'分钟参考买入价（暂估）'):'待补价')+(adjusted&&a!.status==='verified'?'（计算基准已前复权）':''),...extrema(window.slice(1).map(w=>w.value)),progress:window.slice(1).filter(w=>w.value!==null).length,status:!calendarUsable?'日历待核实':base===null?'待补价':complete?'10日价格观察完成':ended?'窗口结束但数据不完整':'追踪中',warning:adjustmentPending?a!.reason:adjusted?a!.reason:!inSession?'非连续竞价时段（含午休或集合竞价），请核对时间；当前不输出统计':blocked,indicators:indicators(bars)};
}

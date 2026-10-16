import dates from './calendar.json';
import type { Bar, RecordRow } from './types';
import { change, closedBars, extrema, indicators, shanghaiNow } from './domain';
export const calendarInfo={source:'新浪独立沪深交易日历，经AKShare读取',fetchedAt:'2026-10-16',start:dates[0],end:dates.at(-1),officialVerified:false};
export function track(record:RecordRow, now=new Date()) {
  const date=record.buy_time.slice(0,10),index=dates.indexOf(date),local=shanghaiNow(now);
  let data: {bars?:Bar[]}={};try{data=JSON.parse(record.market_data??'{}');}catch{}
  const bars=closedBars(data.bars??[],now),byDate=new Map(bars.map(b=>[b.date,b]));
  const base=record.actual_price??record.reference_price;
  const blocked=record.symbol.endsWith('.BJ')?'北交所日历尚未核实':index<0?'买入日不在已加载交易日历':'公司行动尚未自动核实，以下仅为未复权价格观察';
  const time=record.buy_time.slice(11,19),inSession=time>='09:30:00'&&time<='11:30:00'||time>='13:00:00'&&time<='15:00:00';
  const calendarUsable=!record.symbol.endsWith('.BJ')&&index>=0&&inSession;
  const window=Array.from({length:11},(_,n)=>{
    const day=calendarUsable?dates[index+n]??null:null;
    const b=day?byDate.get(day):undefined;
    const checked=day!==null&&record.checked_through!==null&&day<=record.checked_through;
    const state=!day?'日历待核实':day>local.slice(0,10)?'待更新':day===local.slice(0,10)&&local.slice(11)<'16:00:00'?'盘中，未确认收盘':!b?'缺少有效报价':base===null?'待补价':!checked?'公司行动口径待核对':'有效价格观察';
    return {n,date:day,close:b?.close??null,value:b&&checked?change(b.close,base):null,state};
  });
  const complete=window.every(w=>w.value!==null);
  const ended=window[10].date!==null&&window[10].date<local.slice(0,10);
  return {window,base,baseType:record.actual_price!==null?'实际成交价':record.reference_price!==null?'分钟参考买入价':'待补价',...extrema(window.slice(1).map(w=>w.value)),progress:window.filter(w=>w.value!==null).length,status:!calendarUsable?'日历待核实':base===null?'待补价':complete?'价格观察齐全（待公司行动核对）':ended?'窗口结束但数据不完整':'追踪中',warning:!inSession?'非连续竞价时段（含午休或集合竞价），请核对时间；当前不输出统计':blocked,indicators:indicators(bars)};
}

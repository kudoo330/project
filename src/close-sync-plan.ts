import dates from './calendar.json';
import {shanghaiNow} from './domain';
import type {Bar,RecordRow} from './types';
import {afterBuyWindow} from './close-validation';
export const closeSyncSchedule={timezone:'Asia/Shanghai',starts:'16:05',ends:'23:55',intervalMinutes:10,limitPerRun:8,calendarEnd:dates.at(-1)};
export function syncDay(now:Date){
  const local=shanghaiNow(now),date=local.slice(0,10);
  if(date<dates[0]||date>dates[dates.length-1])return {date,active:false,reason:'交易日历超出覆盖范围，自动同步暂停；需更新日历'};
  if(!dates.includes(date))return {date,active:false,reason:'市场休市，跳过'};
  if(local.slice(11)<'16:05:00')return {date,active:false,reason:'未到北京时间16:05'};
  return {date,active:true,reason:''};
}
export function storedBars(record:RecordRow):Bar[]{try{return JSON.parse(record.market_data??'{}').bars??[];}catch{return [];}}
export function closeTargets(record:RecordRow,today:string):string[]{
  if(record.symbol.endsWith('.BJ'))return []; // Calendar coverage remains unverified.
  const start=dates.indexOf(record.buy_time.slice(0,10)),end=dates.indexOf(today);
  if(start<0||end<start)return [];
  let invalid=new Set<string>();try{invalid=new Set((JSON.parse(record.market_data??'{}').validation??[]).filter((v:any)=>v.status!=='matched').map((v:any)=>v.date));}catch{}
  const window=afterBuyWindow(record),known=new Set(storedBars(record).filter(b=>b.close>0&&Number.isFinite(b.close)&&b.crossCheck?.status==='matched'&&!invalid.has(b.date)).map(b=>b.date));
  const cutoff=today+'T16:05:00';
  const fetched=record.fetched_at?shanghaiNow(new Date(record.fetched_at)):'';
  // Only D+1 through D+10; D0 does not belong to this collection window.
  return window.filter(date=>date<=today&&(!known.has(date)||date===today&&fetched<cutoff));
}
export function planCloseSync(records:RecordRow[],today:string,lastAttempt:Map<string,string>=new Map()){
  const bySymbol=new Map<string,{symbol:string;records:RecordRow[];dates:Set<string>}>();
  for(const r of records){const targets=closeTargets(r,today);if(!targets.length)continue;
    let group=bySymbol.get(r.symbol);if(!group){group={symbol:r.symbol,records:[],dates:new Set()};bySymbol.set(r.symbol,group);}
    group.records.push(r);targets.forEach(d=>group!.dates.add(d));
  }
  // Rotate failed securities behind those not yet attempted, preventing starvation.
  return [...bySymbol.values()].sort((a,b)=>(lastAttempt.get(a.symbol)??'').localeCompare(lastAttempt.get(b.symbol)??'')||a.symbol.localeCompare(b.symbol));
}
export function selectCloseBatch(groups:ReturnType<typeof planCloseSync>,today:string){
  let queryBudget=36;
  const selected=[];
  for(const group of groups){
    if(selected.length>=closeSyncSchedule.limitPerRun||queryBudget<3)break;
    const records=group.records.slice(0,queryBudget-2);queryBudget-=records.length+2;
    selected.push({...group,records,dates:new Set(records.flatMap(r=>closeTargets(r,today))),hasMoreRecords:records.length<group.records.length});
  }
  return selected;
}

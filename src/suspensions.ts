import {normalizeSymbol,shanghaiNow} from './domain';
import {collectionWindow} from './observation-window';
import dates from './calendar.json';
import type {Bar,RecordRow} from './types';
export interface SuspensionEvidence {source:'admin-confirmed';reason:string;confirmedBy:string;confirmedAt:string}
export function suspensionMap(data:any):Record<string,SuspensionEvidence>{
  const entries=data?.suspensions;
  if(!entries||typeof entries!=='object'||Array.isArray(entries))return {};
  return Object.fromEntries(Object.entries(entries).filter(([day,e]:[string,any])=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&e?.source==='admin-confirmed'&&typeof e.reason==='string'&&e.reason.trim()&&typeof e.confirmedBy==='string'&&Number.isFinite(Date.parse(e.confirmedAt)))) as Record<string,SuspensionEvidence>;
}
export function suspendedDates(data:any){
  const traded=new Set((data?.bars??[]).filter((b:Bar)=>b.volume>0&&b.close>0).map((b:Bar)=>b.date));
  return new Set(Object.keys(suspensionMap(data)).filter(day=>!traded.has(day)));
}
export function suspensionInput(value:any,now=new Date()){
  const symbol=normalizeSymbol(value.symbol),date=String(value.date??''),local=shanghaiNow(now);
  if(!dates.includes(date))throw new Error('停牌日期必须在已加载交易日历内');
  if(date>local.slice(0,10)||date===local.slice(0,10)&&local.slice(11)<'16:05:00')throw new Error('仅能确认已收盘交易日的全天停牌');
  if(typeof value.suspended!=='boolean')throw new Error('缺少停牌或撤销操作');
  const reason=String(value.reason??'').trim();if(!reason||reason.length>500)throw new Error('请填写停牌确认或撤销依据（最多500字）');
  return {symbol,date,suspended:value.suspended,reason};
}
export async function setSuspension(db:D1Database,value:any,actor:string){
  const input=suspensionInput(value),stamp=new Date().toISOString();
  const rows=(await db.prepare('SELECT * FROM records WHERE symbol=?').bind(input.symbol).all<RecordRow>()).results.filter(r=>collectionWindow(r).includes(input.date));
  if(!rows.length)throw new Error('没有覆盖该日期的股票追踪记录');
  if(rows.length>20)throw new Error('相关样本超过20条，请通过Codex分批处理');
  const writes:D1PreparedStatement[]=[];
  for(const r of rows){
    const data=JSON.parse(r.market_data??'{}'),suspensions=suspensionMap(data);
    if(input.suspended&&(data.bars??[]).some((b:Bar)=>b.date===input.date&&b.volume>0&&b.close>0))throw new Error('该日已有成交行情，与全天停牌冲突；未修改任何记录');
    if(input.suspended)suspensions[input.date]={source:'admin-confirmed',reason:input.reason,confirmedBy:actor,confirmedAt:stamp};else delete suspensions[input.date];
    writes.push(db.prepare('UPDATE records SET market_data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify({...data,suspensions}),stamp,r.id,r.revision));
    writes.push(db.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),r.id,actor,input.suspended?'confirm-suspension':'remove-suspension',JSON.stringify({market_data:r.market_data,date:input.date,reason:input.reason}),stamp));
  }
  const results=await db.batch(writes),updated=results.filter((_,i)=>i%2===0).reduce((sum,r)=>sum+r.meta.changes,0);
  return {ok:updated===rows.length,updated,matched_records:rows.length,conflicts:rows.length-updated};
}

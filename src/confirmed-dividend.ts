import {afterBuyWindow} from './observation-window';
import {shanghaiNow} from './domain';
import {confirmedCashDividends,corporateAdjustment} from './corporate-actions';
import dates from './calendar.json';
import type {Bar,RecordRow} from './types';

export function prepareConfirmedDividend(record:RecordRow,value:any,actor:string,now=new Date()){
  if(!Number.isInteger(value.revision)||value.revision!==record.revision)throw new Error('记录版本不一致，请刷新后重试');
  const local=shanghaiNow(now),today=local.slice(0,10),end=afterBuyWindow(record).at(-1),buy=record.buy_time.slice(0,10);
  const asOf=local.slice(11)>='16:05:00'?today:new Date(now.getTime()+8*3600000-86400000).toISOString().slice(0,10);
  if(!end||today>end)throw new Error('观察期已结束，不追溯修改复权快照');
  const date=String(value.date??''),reason=String(value.reason??'').trim(),cash=value.cash_per_10;
  if(!dates.includes(date)||date<=buy||date>asOf||date>end)throw new Error('除息日必须是买入后、已收盘且观察期内的交易日');
  if(typeof cash!=='number'||!Number.isFinite(cash)||cash<=0)throw new Error('每10股现金分红必须为正数');
  if(!reason||reason.length>500)throw new Error('请填写人工确认依据（最多500字）');
  const old=JSON.parse(record.market_data??'{}');
  const evidence={...confirmedCashDividends(old),[date]:{cashPerShare:cash/10,source:'admin-confirmed' as const,reason,confirmedBy:actor,confirmedAt:now.toISOString()}};
  const invalid=new Set((old.validation??[]).filter((v:any)=>v.status!=='matched').map((v:any)=>v.date));
  const bars:Bar[]=(old.bars??[]).filter((b:Bar)=>b.crossCheck?.status==='matched'&&!invalid.has(b.date));
  const candidate={...record,market_data:JSON.stringify({...old,confirmed_cash_dividends:evidence})};
  const adjustment=corporateAdjustment(candidate,bars,old.adjustment_source,today,asOf);
  // A confirmation must match a real factor change; mere acceptance of an
  // unrelated no-action day must never install an exception for future refreshes.
  const priorDay=dates[dates.indexOf(date)-1],prior=bars.find(b=>b.date===priorDay);
  const factorRows=old.adjustment_source?.factors??[];
  const previousFactor=[...factorRows].filter((f:any)=>f.date<date).sort((a:any,b:any)=>a.date.localeCompare(b.date)).at(-1)?.factor;
  const eventFactor=factorRows.find((f:any)=>f.date===date)?.factor;
  if(!prior||!previousFactor||!eventFactor||prior.close<=cash/10||Math.abs(previousFactor/eventFactor-(prior.close-cash/10)/prior.close)>1e-8)throw new Error('现金分红方案与除息日前收盘价或来源因子不符，未修改记录');
  if(adjustment.status!=='verified')throw new Error('人工方案尚未解释来源差异，未修改记录：'+adjustment.reason);
  return {...old,confirmed_cash_dividends:evidence,adjustment,adjustment_history:[...(old.adjustment_history??[]),...(old.adjustment?[old.adjustment]:[])].slice(-20)};
}

export async function confirmDividend(db:D1Database,value:any,actor:string){
  const id=String(value.record_id??'');
  const record=await db.prepare('SELECT * FROM records WHERE id=?').bind(id).first<RecordRow>();
  if(!record)throw new Error('记录不存在');
  const stamp=new Date(),data=prepareConfirmedDividend(record,value,actor,stamp);
  // Cron does not increment revision, so also compare the full old market data.
  const results=await db.batch([
    db.prepare('UPDATE records SET market_data=?,revision=revision+1,updated_at=?,error=NULL WHERE id=? AND revision=? AND market_data IS ?').bind(JSON.stringify(data),stamp.toISOString(),id,record.revision,record.market_data),
    db.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),id,actor,'confirm-cash-dividend',JSON.stringify({record,confirmation:data.confirmed_cash_dividends[value.date]}),stamp.toISOString())
  ]);
  return results[0].meta.changes?{ok:true,record_id:id,revision:record.revision+1,adjustment:data.adjustment}:{ok:false,conflict:true,error:'记录已被刷新或修改，请重新读取后重试'};
}

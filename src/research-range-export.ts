import type {Env} from './types';
import {csvCell} from './domain';
import {normalizeResearchTime,validDate,nyParts} from './research-data-validation';

/** Complete, revision-checked CSV of saved source rows, never generated gap prices. */
export async function researchRangeExport(env:Env,url:URL):Promise<Response>{
 const fail=(error:string,status=400)=>Response.json({error},{status});
 try{
  const id=url.searchParams.get('dataset_id')??'';if(!/^market_[a-f0-9]{64}$/.test(id))return fail('请选择行情来源');
  const dataset=await env.DB.prepare('SELECT * FROM research_market_datasets WHERE id=?').bind(id).first<any>();if(!dataset)return fail('行情来源不存在',404);
  const start=url.searchParams.get('start')??'',end=url.searchParams.get('end')??'';
  if(!start||!end)return fail('请选择完整的下载起止时间');
  const dateMode=dataset.period==='1d'||validDate(start)&&validDate(end);
  const first=normalizeResearchTime(start,dateMode?'1d':'1m').time,last=normalizeResearchTime(end,dateMode?'1d':'1m').time;
  if(first>last)return fail('下载开始时间不能晚于结束时间');
  const sessions=(url.searchParams.get('sessions')??'pre,regular,post').split(',');
  if(!sessions.length||sessions.some(s=>!['pre','regular','post'].includes(s))||new Set(sessions).size!==sessions.length)return fail('请选择有效的交易时段');
  const key=dateMode?'trading_date':'time_key';
  const where=`dataset_id=? AND ${key}>=? AND ${key}<=?${dataset.period==='1m'?` AND session IN (${sessions.map(()=>'?').join(',')})`:''}`;
  const values=[id,first,last,...(dataset.period==='1m'?sessions:[])];
  const count=(await env.DB.prepare(`SELECT COUNT(*) n FROM research_market_bars WHERE ${where}`).bind(...values).first<{n:number}>())!.n;
  if(count>500000)return fail('所选范围超过50万条，请缩短下载范围；文件没有截断',413);
  const headers=['time','time_ny','trading_date','session','open','high','low','close','volume','status','reason','symbol','period','provider','currency','adjustment','dataset_revision','row_revision','verification'];
  const parts=['\ufeff'+headers.join(',')+'\r\n'];let cursor='',seen=0,byteLength=parts[0].length;
  while(true){
   const rows=(await env.DB.prepare(`SELECT time_key,trading_date,session,open,high,low,close,volume,status,reason,verification,revision FROM research_market_bars WHERE ${where} AND time_key>? ORDER BY time_key LIMIT 2000`).bind(...values,cursor).all<any>()).results;
   if(!rows.length)break;
   const lines=rows.map(row=>{
    let local=row.time_key;if(dataset.period==='1m'){const p=nyParts(new Date(row.time_key));local=p.date+' '+String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0');}
    return [row.time_key,local,row.trading_date,row.session,row.open,row.high,row.low,row.close,row.volume,row.status,row.reason,dataset.symbol,dataset.period,dataset.provider,dataset.currency,dataset.adjustment,dataset.revision,row.revision,row.verification].map(csvCell).join(',');
   }).join('\r\n')+'\r\n';
   byteLength+=new TextEncoder().encode(lines).length;if(byteLength>64*1024*1024)return fail('下载文件超过64MB，请缩短日期范围；文件没有截断',413);
   parts.push(lines);seen+=rows.length;cursor=rows.at(-1).time_key;if(rows.length<2000)break;
  }
  const revision=await env.DB.prepare('SELECT revision FROM research_market_datasets WHERE id=?').bind(id).first<{revision:number}>();
  if(revision?.revision!==dataset.revision||seen!==count)return fail('导出期间行情已变更，请重新下载；未返回混合版本文件',409);
  return new Response(parts.join(''),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="AMD_${dataset.period}_${first.slice(0,10)}_${last.slice(0,10)}.csv"`,'Cache-Control':'no-store','X-Export-Rows':String(count),'X-Source-Revision':String(dataset.revision),'X-Dataset-Id':id}});
 }catch{return fail('下载参数无效或暂时无法读取行情，请重试');}
}

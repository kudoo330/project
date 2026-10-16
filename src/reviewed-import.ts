import {normalizeSymbol,normalizeTime,optionalPositive} from './domain';
import {digest} from './auth';
import type {Identity} from './types';
const str=(v:unknown,max:number)=>String(v??'').slice(0,max);
export function reviewedRows(value:unknown){
  if(!Array.isArray(value)||!value.length||value.length>250)throw new Error('核验数据需包含1至250条记录');
  const seen=new Set<string>();
  return value.map(r=>{
    const strategy=str(r.strategy,80).trim();if(!strategy)throw new Error('缺少策略名称');
    const symbol=normalizeSymbol(r.symbol),buy_time=normalizeTime(r.buy_time),reference_price=optionalPositive(r.reference_price,'参考价');
    const evidence=r.reference_evidence??null;
    if(reference_price!==null&&(!evidence||typeof evidence!=='object'||Array.isArray(evidence)))throw new Error('参考价必须附带来源证据');
    const reference_evidence=evidence===null?null:JSON.stringify(evidence);if(reference_evidence&&reference_evidence.length>12000)throw new Error('单条来源证据过大');
    const key=JSON.stringify([strategy,symbol,buy_time]);if(seen.has(key))throw new Error('文件存在同策略、同股票、同时点重复记录');seen.add(key);
    return {strategy,symbol,buy_time,original_time:str(r.original_time??r.buy_time,100),name:str(r.name,100),reference_price,reference_evidence,pricing_status:reference_price===null?'pending':'reviewed_reference',notes:str(r.notes,2000)};
  });
}
export async function importReviewed(db:D1Database,body:any,user:Identity){
  if(!/^[\w-]{16,80}$/.test(body.request_id??''))throw new Error('缺少有效导入ID');
  const rows=reviewedRows(body.rows),hash=await digest(JSON.stringify(rows));
  const previous=await db.prepare('SELECT input_hash FROM batches WHERE id=?').bind(body.request_id).first<{input_hash:string}>();
  if(previous)return previous.input_hash===hash?{ok:true,replayed:true,count:rows.length}:{error:'导入ID已用于其他内容',status:409};
  const strategies=(await db.prepare('SELECT id,name,archived FROM strategies').all<{id:string;name:string;archived:number}>()).results;
  const additions:{id:string;name:string}[]=[],ids=new Map<string,string>();
  for(const name of new Set(rows.map(r=>r.strategy))){
    const matches=strategies.filter(s=>s.name===name&&!s.archived);if(matches.length>1)throw new Error('策略名称重复，请先整理：'+name);
    if(!matches.length&&strategies.some(s=>s.name===name))throw new Error('策略已归档：'+name);
    const id=matches[0]?.id??crypto.randomUUID();ids.set(name,id);if(!matches.length)additions.push({id,name});
  }
  const keys=new Set(rows.map(r=>JSON.stringify([ids.get(r.strategy),r.symbol,r.buy_time])));
  const times=rows.map(r=>r.buy_time).sort();
  const existing=(await db.prepare('SELECT strategy_id,symbol,buy_time FROM records WHERE buy_time>=? AND buy_time<=?').bind(times[0],times.at(-1)).all<{strategy_id:string;symbol:string;buy_time:string}>()).results;
  if(existing.some(r=>keys.has(JSON.stringify([r.strategy_id,r.symbol,r.buy_time]))))return {error:'网站已有相同策略、股票和时点的记录；未导入任何数据',status:409};
  const stamp=new Date().toISOString();
  // D1 free tier allows 50 statements/invocation and 100 bound parameters/statement.
  // Seven records use 91 parameters, keeping a 223-row import within that budget.
  const inserts:D1PreparedStatement[]=[];
  for(let offset=0;offset<rows.length;offset+=7){
    const chunk=rows.slice(offset,offset+7),bindings=chunk.flatMap(r=>[crypto.randomUUID(),body.request_id,ids.get(r.strategy)!,r.symbol,r.name,r.buy_time,r.original_time,r.reference_price,r.reference_evidence,r.pricing_status,r.notes,stamp,stamp]);
    inserts.push(db.prepare('INSERT INTO records(id,batch_id,strategy_id,symbol,name,buy_time,original_time,actual_price,shares,reference_price,reference_evidence,pricing_status,notes,created_at,updated_at) VALUES'+chunk.map(()=>'(?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)').join(',')).bind(...bindings));
  }
  if(inserts.length+additions.length+8>49)throw new Error('新增策略过多，请按策略拆分文件导入');
  try{
    await db.batch([
      db.prepare('INSERT INTO batches(id,created_by,created_at,input_hash) VALUES(?,?,?,?)').bind(body.request_id,user.username,stamp,hash),
      ...additions.map(s=>db.prepare('INSERT INTO strategies(id,name) VALUES(?,?)').bind(s.id,s.name)),
      ...inserts
    ]);
  }catch(e){const saved=await db.prepare('SELECT input_hash FROM batches WHERE id=?').bind(body.request_id).first<{input_hash:string}>();if(saved?.input_hash===hash)return {ok:true,replayed:true,count:rows.length};throw e;}
  return {ok:true,count:rows.length,batch_id:body.request_id};
}

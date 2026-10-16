import schema from '../migrations/0003_close_sync.sql';
import {verifiedDaily} from './market';
import {mergeCloseWindow,afterBuyWindow} from './close-validation';
import {closeSyncSchedule,planCloseSync,syncDay,selectCloseBatch} from './close-sync-plan';
import type {Env,RecordRow} from './types';
const ready=new WeakMap<object,Promise<void>>();
export function ensureCloseSyncSchema(env:Env){
  let promise=ready.get(env.DB);
  if(!promise){promise=env.DB.batch(schema.split(';').map(s=>s.trim()).filter(Boolean).map(sql=>env.DB.prepare(sql))).then(()=>{}).catch(e=>{ready.delete(env.DB);throw e;});ready.set(env.DB,promise);}
  return promise;
}
export async function closeSyncStatus(env:Env){
  await ensureCloseSyncSchema(env);
  const latest=await env.DB.prepare('SELECT * FROM close_sync_runs ORDER BY started_at DESC LIMIT 1').first();
  return {schedule:closeSyncSchedule,latest,warning:'北交所日历未核实，暂不自动计算或补齐其10日窗口。缺失报价不自动认定为停牌。'};
}
export async function runCloseSync(env:Env,now=new Date(),load:typeof verifiedDaily=verifiedDaily){
  await ensureCloseSyncSchema(env);
  const day=syncDay(now),id=crypto.randomUUID(),started=now.toISOString();
  const acquired=await env.DB.prepare(`INSERT INTO close_sync_runs(id,trade_date,started_at,status)
    SELECT ?,?,?,'running' WHERE NOT EXISTS(SELECT 1 FROM close_sync_runs WHERE status='running' AND started_at>?) RETURNING id`).bind(id,day.date,started,new Date(now.getTime()-15*60000).toISOString()).first();
  if(!acquired)return {status:'overlap_skipped'};
  const finish=async(status:string,message:string,values={total:0,processed:0,succeeded:0,failed:0,remaining:0})=>{
    await env.DB.prepare('UPDATE close_sync_runs SET status=?,finished_at=?,message=?,total_symbols=?,processed=?,succeeded=?,failed=?,remaining=? WHERE id=?').bind(status,new Date().toISOString(),message,values.total,values.processed,values.succeeded,values.failed,values.remaining,id).run();
    return {status,message,...values};
  };
  try{
    if(!day.active)return await finish('skipped',day.reason);
    const records=(await env.DB.prepare('SELECT * FROM records').all<RecordRow>()).results;
    const history=(await env.DB.prepare('SELECT symbol,last_attempt FROM close_sync_symbols').all<{symbol:string;last_attempt:string}>()).results;
    const groups=planCloseSync(records,day.date,new Map(history.map(s=>[s.symbol,s.last_attempt]))),selected=selectCloseBatch(groups,day.date);
    let succeeded=0,failed=0;const unfinished=new Set<string>();
    // Respect free-tier D1 query budgets, including repeated samples of one security.
    for(const group of selected){
      let error:string|null=null;
      let quote;
      try{quote=await load(env,group.symbol,true);}catch(e){error=e instanceof Error?e.message:'自动同步失败';}
      if(quote){
        const available=new Map(quote.bars.filter(b=>b.close>0&&Number.isFinite(b.close)&&b.date<=day.date).map(b=>[b.date,b]));
        const absent=[...group.dates].filter(date=>!available.has(date));
        if(absent.length)error='缺少有效收盘报价：'+absent.join('、');
        for(const r of group.records){
          const missing=afterBuyWindow(r).filter(d=>d<=day.date&&!available.has(d));
          if(missing.length)error='缺少交叉验证通过的收盘价：'+missing.join('、');
          await env.DB.prepare('UPDATE records SET name=?,market_data=?,fetched_at=?,error=? WHERE id=? AND revision=?').bind(quote.name,JSON.stringify(mergeCloseWindow(r,quote)),quote.fetchedAt,missing.length?'自动同步：缺少交叉验证通过的收盘价 '+missing.join('、'):null,r.id,r.revision).run();
        }
      }else{
        // Preserve both the last valid quote and fetch timestamp on transport failures.
        await env.DB.batch(group.records.map(r=>env.DB.prepare('UPDATE records SET error=? WHERE id=? AND revision=?').bind('自动同步失败：'+error,r.id,r.revision)));
      }
      if(error)failed++;else succeeded++;
      if(error||group.hasMoreRecords)unfinished.add(group.symbol);
      await env.DB.prepare(`INSERT INTO close_sync_symbols(symbol,last_attempt,last_success,last_error) VALUES(?,?,?,?)
        ON CONFLICT(symbol) DO UPDATE SET last_attempt=excluded.last_attempt,last_error=excluded.last_error,
        last_success=COALESCE(excluded.last_success,close_sync_symbols.last_success)`).bind(group.symbol,started,error?null:started,error).run();
    }
    const remaining=groups.length-selected.length+unfinished.size;
    await env.DB.prepare("DELETE FROM close_sync_runs WHERE started_at<? AND status!='running'").bind(new Date(now.getTime()-30*86400000).toISOString()).run();
    return await finish(failed||remaining?'partial':'success',remaining?'存在待补齐报价或排队股票，后续定时执行继续尝试':'本次收盘价补齐完成',{total:groups.length,processed:selected.length,succeeded,failed,remaining});
  }catch(e){return await finish('failed',e instanceof Error?e.message:'定时同步异常');}
}

import type {Env} from './types';
import {normalizeConfig,runBacktest,MANIFESTS,ENGINE_VERSION,DEFAULT_PARAMETERS,type BacktestInput,type InputBar} from './amd-backtest';
import {buildResearchChart} from './research-chart';
import {addUSDate} from './us-market-calendar';
import {researchDigest,type ResearchStatus} from './research-data-validation';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'private, no-store'}});
const columns='time_key AS time,trading_date AS date,open,high,low,close,volume,status,revision,verification,reason';
async function readSnapshot(db:D1Database,id:unknown,period:string,start:string,end:string){
 if(typeof id!=='string'||!/^market_[a-f0-9]{64}$/.test(id))throw new Error('请选择有效的'+period+'行情数据集');
 const source=await db.prepare('SELECT * FROM research_market_datasets WHERE id=?').bind(id).first<any>();
 if(!source||source.symbol!=='AMD.US'||source.period!==period||source.adjustment!=='none')throw new Error('本轮仅支持AMD独立、不复权数据集');
 const rows:InputBar[]=[];let cursor='';
 while(true){const part=(await db.prepare(`SELECT ${columns} FROM research_market_bars WHERE dataset_id=? AND trading_date>=? AND trading_date<=? AND time_key>? ORDER BY time_key LIMIT 2000`).bind(id,start,end,cursor).all<InputBar>()).results;rows.push(...part);if(rows.length>150000)throw new Error('快照超过15万行，请缩短回测区间');if(part.length<2000)break;cursor=part.at(-1)!.time;}
 const check=await db.prepare('SELECT revision FROM research_market_datasets WHERE id=?').bind(id).first<any>();if(check?.revision!==source.revision)throw new Error('读取时行情已变更，请重试');
 return {source,rows};
}
async function loadRun(db:D1Database,id:string){
 const run=await db.prepare('SELECT * FROM research_backtest_runs WHERE id=?').bind(id).first<any>();if(!run)return null;
 const parts=(await db.prepare("SELECT value_json FROM research_backtest_parts WHERE run_id=? AND kind='result' ORDER BY part").bind(id).all<{value_json:string}>()).results;
 return {id:run.id,createdAt:run.created_at,...JSON.parse(run.metadata_json),results:parts.map(p=>JSON.parse(p.value_json))};
}
export async function amdBacktestApi(request:Request,env:Env,url:URL,actor:string):Promise<Response>{
 try{
  const path=url.pathname.slice('/api/research/backtests'.length);
  if(request.method==='GET'&&path==='/strategies')return json({manifests:MANIFESTS,defaultParameters:DEFAULT_PARAMETERS,engineVersion:ENGINE_VERSION});
  if(request.method==='GET'&&path===''){
   const rows=(await env.DB.prepare('SELECT id,created_at,metadata_json FROM research_backtest_runs ORDER BY created_at DESC,id LIMIT 50').all<any>()).results;
   return json({runs:rows.map(r=>({id:r.id,createdAt:r.created_at,...JSON.parse(r.metadata_json),results:undefined}))});
  }
  const chartMatch=path.match(/^\/([A-Za-z0-9_-]{16,100})\/chart$/);
  if(request.method==='GET'&&chartMatch){
   const run=await env.DB.prepare('SELECT metadata_json FROM research_backtest_runs WHERE id=?').bind(chartMatch[1]).first<{metadata_json:string}>();if(!run)return json({error:'回测不存在'},404);
   const meta=JSON.parse(run.metadata_json),date=url.searchParams.get('date')??'',timeframe=url.searchParams.get('timeframe')??'1m';
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['1m','5m'].includes(timeframe))throw new Error('需要有效日期及1m/5m周期');
   const parts=(await env.DB.prepare("SELECT value_json FROM research_backtest_parts WHERE run_id=? AND kind='input' AND json_extract(value_json,'$.kind')='minutes' AND json_extract(value_json,'$.rows[0].date')<=? AND json_extract(value_json,'$.rows[#-1].date')>=? ORDER BY part").bind(chartMatch[1],date,date).all<{value_json:string}>()).results;
   const rows=parts.flatMap(p=>JSON.parse(p.value_json).rows).filter((r:InputBar)=>r.date===date).map((r:InputBar)=>({...r,time_key:r.time,trading_date:r.date,status:r.status as ResearchStatus,reason:r.reason||(r.status==='available'?'':'快照缺价'),source_note:String(meta.minuteSource.provider)}));
   const chart=buildResearchChart(meta.minuteSource,rows,{start:date,end:date,timeframe:timeframe as '1m'|'5m',sessions:meta.config.sessions,now:Date.parse(meta.config.end)});
   return json({dataset:meta.minuteSource,timeframe,immutable:true,snapshotId:meta.snapshotId,...chart});
  }
  const match=path.match(/^\/([A-Za-z0-9_-]{16,100})(\/export)?$/);
  if(request.method==='GET'&&match){
   const run=await loadRun(env.DB,match[1]);if(!run)return json({error:'回测不存在'},404);
   if(!match[2])return json(run);
   const parts=(await env.DB.prepare("SELECT value_json FROM research_backtest_parts WHERE run_id=? AND kind='input' ORDER BY part").bind(match[1]).all<{value_json:string}>()).results;
   return json({...run,immutableInput:parts.map(p=>JSON.parse(p.value_json)),reproduce:'Flatten input parts by kind, then runBacktest(input, config, snapshotId) using engineVersion. No broker data.'});
  }
  if(request.method!=='POST'||path!=='')return json({error:'回测接口不存在'},404);
  const text=await request.text();if(text.length>20000)return json({error:'配置过大'},413);
  const value=JSON.parse(text);if(!/^[A-Za-z0-9_-]{16,100}$/.test(value.request_id??''))throw new Error('需要有效的幂等请求ID');
  const config=normalizeConfig(value),requestHash=await researchDigest(value),id=value.request_id;
  const prior=await env.DB.prepare('SELECT request_hash FROM research_backtest_runs WHERE id=?').bind(id).first<{request_hash:string}>();
  if(prior)return prior.request_hash===requestHash?json({...(await loadRun(env.DB,id)),replayed:true}):json({error:'请求ID已用于其他配置'},409);
  const start=value.initial_entry_local.slice(0,10),end=value.end_local.slice(0,10);
  const minute=await readSnapshot(env.DB,value.minute_dataset_id,'1m',addUSDate(start,-14),end);
  const daily=value.daily_dataset_id?await readSnapshot(env.DB,value.daily_dataset_id,'1d',addUSDate(start,-90),end):null;
  const input:BacktestInput={minutes:minute.rows.filter(r=>Date.parse(r.time)+60000<=Date.parse(config.end)),daily:(daily?.rows??[]).filter(r=>r.date<end),minuteSource:minute.source,dailySource:daily?.source??null};
  if(config.strategies.includes('D03')&&!daily)throw new Error('D03需要独立日线来源');
  const snapshotId=await researchDigest(input),computed=runBacktest(input,config,snapshotId),{results,...metadata}=computed;
  const meta={...metadata,minuteSource:minute.source,dailySource:daily?.source??null,requestHash,inputRows:{minute:input.minutes.length,daily:input.daily.length},summary:results.map(r=>({strategyId:r.strategyId,model:r.model,costScenario:r.costScenario,status:r.status,...r.summary}))};
  const stamp=new Date().toISOString();
  const revisionGate=`EXISTS(SELECT 1 FROM research_market_datasets WHERE id=? AND revision=?)${daily?' AND EXISTS(SELECT 1 FROM research_market_datasets WHERE id=? AND revision=?)':''}`;
  const stmts=[env.DB.prepare(`INSERT INTO research_backtest_runs(id,request_hash,actor,created_at,metadata_json) SELECT ?,?,?,?,? WHERE ${revisionGate}`).bind(id,requestHash,actor,stamp,JSON.stringify(meta),minute.source.id,minute.source.revision,...(daily?[daily.source.id,daily.source.revision]:[]))];
  const append=(kind:string,part:number,value:unknown)=>{const data=JSON.stringify(value);if(new TextEncoder().encode(data).length>1500000)throw new Error('单份结果超过安全存储上限，请缩短范围');stmts.push(env.DB.prepare('INSERT INTO research_backtest_parts(run_id,kind,part,value_json) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM research_backtest_runs WHERE id=? AND request_hash=?)').bind(id,kind,part,data,id,requestHash));};
  let part=0;for(const kind of ['minutes','daily'] as const)for(let i=0;i<input[kind].length;i+=1000)append('input',part++,{kind,rows:input[kind].slice(i,i+1000)});
  results.forEach((r,i)=>append('result',i,r));
  try{const saved=await env.DB.batch(stmts);if(!saved[0].meta.changes)return json({error:'行情版本已变化，结果未保存，请重新运行'},409);}
  catch(error){const replay=await env.DB.prepare('SELECT request_hash FROM research_backtest_runs WHERE id=?').bind(id).first<{request_hash:string}>();if(replay?.request_hash===requestHash)return json({...(await loadRun(env.DB,id)),replayed:true});if(replay)return json({error:'请求ID已用于其他配置'},409);throw error;}
  return json({id,createdAt:stamp,...meta,results,replayed:false},201);
 }catch(error){const message=(error as Error).message;
  if(message.includes('no such table'))return json({error:'回测存储尚未升级，请先备份并应用0008迁移'},503);
  if(message.includes('D1_')||message.includes('SQLITE_'))return json({error:'回测保存失败，没有修改原行情；请重试或缩短区间'},503);
  return json({error:message},400);
 }
}

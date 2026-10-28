import { digest, identity, login, logout } from './auth';
import { csvCell, normalizeSymbol, normalizeTime, optionalPositive, shanghaiNow } from './domain';
import { daily, minute, verifiedDaily } from './market';
import {mergeCloseWindow,collectionWindow,verifiedCloseDates} from './close-validation';
import { calendarInfo, track } from './tracking';
import type { Env, RecordRow } from './types';
import {listStrategies,ensureAnalysisSchema} from './strategy-analysis';
import {analysisSummary} from './analysis-summary';
import {normalizeAnalysisRule} from '../public/analysis-scope.js';
import {runCloseSync,closeSyncStatus} from './close-sync';
import {importReviewed} from './reviewed-import';
import {setSuspension,suspendedDates} from './suspensions';
import {confirmDividend} from './confirmed-dividend';
import {minuteCloseSource} from './reference-source';
import {importVerifiedCloses} from './verified-close-import';
import {canReadWithToken,generateReadToken,revokeReadToken} from './read-access';
import {researchDataApi} from './research-data';
import {researchChartApi} from './research-chart';
import {researchMarkersApi} from './research-markers';
import {userManagementApi} from './user-management';
const json=(data:unknown,status=200)=>Response.json(data,{status});
const now=()=>new Date().toISOString();
const text=(s:unknown,max=2000)=>String(s??'').slice(0,max);
async function body(request:Request,limit=200000) {
  if(Number(request.headers.get('Content-Length')??0)>limit)throw new Error('请求超过大小限制');
  const s=await request.text();if(s.length>limit)throw new Error('请求超过大小限制');
  return JSON.parse(s);
}
async function getRecord(env:Env,id:string){return env.DB.prepare('SELECT * FROM records WHERE id=?').bind(id).first<RecordRow>();}
function input(row:any, editing=false) {
  const symbol=normalizeSymbol(row.symbol);
  const buy_time=editing?String(row.buy_time):normalizeTime(row.buy_time);
  if(editing&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(buy_time))throw new Error('买入时间格式错误');
  const strategy_id=text(row.strategy_id,80);if(!strategy_id)throw new Error('必须显式选择策略');
  return {strategy_id,symbol,buy_time,original_time:text(row.original_time??row.buy_time,100),name:text(row.name,100),version:text(row.version,80),actual_price:optionalPositive(row.actual_price,'成交价'),shares:optionalPositive(row.shares,'股数'),reason:text(row.reason),tags:text(row.tags,300),notes:text(row.notes)};
}
async function api(request:Request,env:Env,url:URL) {
  if(url.pathname.startsWith('/api/readonly/')){
    if(request.method!=='GET')return json({error:'此接口只允许读取'},405);
    if(!await canReadWithToken(env.DB,request))return json({error:'只读密钥缺失、失效或已撤销'},401);
    if(url.pathname==='/api/readonly/records'){
      const rows=(await env.DB.prepare('SELECT r.*,s.name AS strategy_name FROM records r JOIN strategies s ON s.id=r.strategy_id ORDER BY buy_time DESC,created_at DESC LIMIT 5000').all<RecordRow>()).results;
      return json({records:rows.map(r=>({...r,tracking:track(r)})),limit:5000,calendar:calendarInfo});
    }
    if(url.pathname==='/api/readonly/close-sync')return json(await closeSyncStatus(env));
    return json({error:'只读接口不存在'},404);
  }
  const mutating=!['GET','HEAD'].includes(request.method);
  if(mutating) {
    if(request.headers.get('Origin')!==url.origin)return json({error:'请求来源校验失败'},403);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'需要 JSON 请求'},415);
  }
  if(url.pathname==='/api/login'&&request.method==='POST')return login(request,env);
  const user=await identity(request,env);
  if(!user)return json({error:'请先登录'},401);
  if(url.pathname==='/api/me')return json(user);
  if(url.pathname==='/api/logout'&&request.method==='POST')return logout(request,env);
  if(url.pathname==='/api/account/password')return userManagementApi(request,env,url,user);
  // Ordinary users receive only the comparison quotes they need. Private A-share
  // records, summaries, exports and all research endpoints are denied server-side.
  if(user.role!=='admin'&&!(url.pathname==='/api/quote'&&request.method==='GET'))return json({error:'此账号仅可访问股价对比'},403);
  if(url.pathname==='/api/users'||url.pathname.startsWith('/api/users/'))return userManagementApi(request,env,url,user);
  if(url.pathname==='/api/research/chart')return researchChartApi(request,env,url);
  if(url.pathname==='/api/research'||url.pathname.startsWith('/api/research/'))return researchMarkersApi(request,env,url,user.username);
  if(url.pathname==='/api/research-data'||url.pathname.startsWith('/api/research-data/')){
    if(user.role!=='admin')return json({error:'仅管理员可访问研究行情数据'},403);
    return researchDataApi(request,env,url,user.username);
  }
  if(url.pathname==='/api/close-sync'&&request.method==='GET')return json(await closeSyncStatus(env));
  if(mutating&&user.role!=='admin')return json({error:'此账号只有查看权限'},403);
  if(url.pathname==='/api/confirm-dividend'&&request.method==='POST'){
    const result=await confirmDividend(env.DB,await body(request),user.username);
    return json(result,result.ok?200:409);
  }
  if(url.pathname==='/api/read-access'){
    if(user.role!=='admin')return json({error:'仅管理员可管理只读授权'},403);
    if(request.method==='POST')return json(await generateReadToken(env.DB,user.username));
    if(request.method==='DELETE'){await revokeReadToken(env.DB);return json({ok:true});}
    return json({error:'请求方法不支持'},405);
  }
  if(url.pathname==='/api/import-closes'&&request.method==='POST')return json(await importVerifiedCloses(env.DB,await body(request,1500000),user.username));
  if(url.pathname==='/api/import-reviewed'&&request.method==='POST'){
    const result=await importReviewed(env.DB,await body(request,1500000),user);return json(result,result.status??200);
  }
  if(url.pathname==='/api/strategies') {
    if(request.method==='GET')return json(await listStrategies(env));
    if(request.method==='POST') {
      const b=await body(request),name=text(b.name,80).trim();if(!name)throw new Error('策略名称不能为空');
      await env.DB.prepare('INSERT INTO strategies(id,name) VALUES(?,?)').bind(crypto.randomUUID(),name).run();return json({ok:true},201);
    }
  }
  const ruleMatch=url.pathname.match(/^\/api\/strategies\/([\w-]+)\/analysis-rule$/);
  if(ruleMatch&&request.method==='PATCH') {
    await ensureAnalysisSchema(env);
    if(!await env.DB.prepare('SELECT id FROM strategies WHERE id=?').bind(ruleMatch[1]).first())return json({error:'策略不存在'},404);
    const b=await body(request),rule=normalizeAnalysisRule(b.rule);
    if(!Number.isInteger(b.revision)||b.revision<0)throw new Error('缺少有效的分析规则版本，请刷新后重试');
    const saved=b.revision===0
      ?await env.DB.prepare(`INSERT INTO strategy_analysis_rules(strategy_id,rule_json,revision,updated_by,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(strategy_id) DO NOTHING RETURNING revision`).bind(ruleMatch[1],JSON.stringify(rule),user.username,now()).first<{revision:number}>()
      :await env.DB.prepare('UPDATE strategy_analysis_rules SET rule_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE strategy_id=? AND revision=? RETURNING revision').bind(JSON.stringify(rule),user.username,now(),ruleMatch[1],b.revision).first<{revision:number}>();
    return saved?json({ok:true,rule,revision:saved.revision}):json({error:'分析规则已被修改，请刷新后重试'},409);
  }
  const strategyMatch=url.pathname.match(/^\/api\/strategies\/([\w-]+)$/);
  if(strategyMatch&&request.method==='DELETE') {
    await ensureAnalysisSchema(env);
    const old=await env.DB.prepare('SELECT * FROM strategies WHERE id=?').bind(strategyMatch[1]).first();
    if(!old)return json({error:'策略不存在'},404);
    const result=await env.DB.batch([
      env.DB.prepare('DELETE FROM strategy_analysis_rules WHERE strategy_id=? AND NOT EXISTS(SELECT 1 FROM records WHERE strategy_id=?)').bind(strategyMatch[1],strategyMatch[1]),
      env.DB.prepare('DELETE FROM strategies WHERE id=? AND NOT EXISTS(SELECT 1 FROM records WHERE strategy_id=?)').bind(strategyMatch[1],strategyMatch[1]),
      env.DB.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),'strategy:'+strategyMatch[1],user.username,'delete-empty-strategy',JSON.stringify(old),now())
    ]);
    return result[1].meta.changes?json({ok:true}):json({error:'策略存在买入记录，不能删除；可使用归档'},409);
  }
  if(strategyMatch&&request.method==='PATCH') {
    const b=await body(request);const old=await env.DB.prepare('SELECT name,archived FROM strategies WHERE id=?').bind(strategyMatch[1]).first<{name:string;archived:number}>();
    if(!old)return json({error:'策略不存在'},404);
    const name=b.name===undefined?old.name:text(b.name,80).trim();if(!name)throw new Error('名称不能为空');
    await env.DB.prepare('UPDATE strategies SET name=?,archived=? WHERE id=?').bind(name,b.archived===undefined?old.archived:b.archived?1:0,strategyMatch[1]).run();return json({ok:true});
  }
  if(url.pathname==='/api/records'&&request.method==='GET') {
    const rows=(await env.DB.prepare('SELECT r.*,s.name AS strategy_name FROM records r JOIN strategies s ON s.id=r.strategy_id ORDER BY buy_time DESC,created_at DESC LIMIT 5000').all<RecordRow>()).results;
    return json({records:rows.map(r=>({...r,tracking:track(r)})),limit:5000,calendar:calendarInfo});
  }
  if(url.pathname==='/api/records'&&request.method==='POST') {
    const b=await body(request);
    if(!/^[\w-]{16,80}$/.test(b.request_id??''))throw new Error('缺少有效的提交请求ID');
    if(!Array.isArray(b.rows)||b.rows.length<1||b.rows.length>100)throw new Error('一次支持1至100个策略样本');
    const rows=b.rows.map((r:any)=>input(r));
    const hash=await digest(JSON.stringify(rows));
    const existing=await env.DB.prepare('SELECT input_hash FROM batches WHERE id=?').bind(b.request_id).first<{input_hash:string}>();
    if(existing)return existing.input_hash===hash?json({ok:true,replayed:true,batch_id:b.request_id}):json({error:'请求ID已用于其他内容，请新建提交'},409);
    const valid=(await env.DB.prepare('SELECT id FROM strategies WHERE archived=0').all<{id:string}>()).results.map(s=>s.id);
    if(rows.some((r:any)=>!valid.includes(r.strategy_id)))throw new Error('存在无效或已归档的策略');
    const duplicate=[];
    const seen=new Set<string>();
    for(const r of rows){
      const key=[r.strategy_id,r.symbol,r.buy_time].join('|');
      if(seen.has(key)||await env.DB.prepare('SELECT id FROM records WHERE strategy_id=? AND symbol=? AND buy_time=? LIMIT 1').bind(r.strategy_id,r.symbol,r.buy_time).first())duplicate.push(r.symbol);
      seen.add(key);
    }
    if(duplicate.length&&!b.confirm_duplicates)return json({error:'发现同策略、同股票、同时点记录。确认后可作为独立样本保留。',duplicates:duplicate},409);
    const stamp=now();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO batches(id,created_by,created_at,input_hash) VALUES(?,?,?,?)').bind(b.request_id,user.username,stamp,hash),
        ...rows.map((r:any)=>env.DB.prepare(`INSERT INTO records(id,batch_id,strategy_id,symbol,buy_time,original_time,name,version,actual_price,shares,reason,tags,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),b.request_id,r.strategy_id,r.symbol,r.buy_time,r.original_time,r.name,r.version,r.actual_price,r.shares,r.reason,r.tags,r.notes,stamp,stamp))
      ]);
    } catch(e) {
      const saved=await env.DB.prepare('SELECT input_hash FROM batches WHERE id=?').bind(b.request_id).first<{input_hash:string}>();
      if(saved?.input_hash===hash)return json({ok:true,replayed:true,batch_id:b.request_id});
      throw e;
    }
    return json({ok:true,count:rows.length,batch_id:b.request_id},201);
  }
  const recordMatch=url.pathname.match(/^\/api\/records\/([\w-]+)$/);
  if(recordMatch) {
    const r=await getRecord(env,recordMatch[1]);if(!r)return json({error:'记录不存在'},404);
    if(request.method==='GET')return json({...r,tracking:track(r)});
    if(request.method==='PATCH') {
      const b=await body(request);if(b.revision!==r.revision)return json({error:'记录已被修改，请刷新后重试'},409);
      const candidate={...r,...b};
      if(candidate.buy_time!==r.buy_time)normalizeTime(candidate.buy_time);
      const v=input(candidate,true);
      if(!await env.DB.prepare('SELECT id FROM strategies WHERE id=?').bind(v.strategy_id).first())throw new Error('策略不存在');
      const changed=v.buy_time!==r.buy_time||v.symbol!==r.symbol;
      const override=Object.hasOwn(b,'reference_price');
      if(override&&changed)throw new Error('请分别修改股票/时间与买入参考价');
      const reference=override?optionalPositive(b.reference_price,'参考价'):r.reference_price;
      const referenceReason=text(b.reference_reason,2000).trim();
      if(override&&!referenceReason)throw new Error('修改参考价必须填写依据');
      const source=override&&b.reference_source?minuteCloseSource(b.reference_source,reference,v):{provider:'用户手动提供',kind:'manual_override'};
      const evidence=override?JSON.stringify({...source,value:reference,reason:referenceReason,previous_reference_price:r.reference_price,previous_evidence:r.reference_evidence,updated_by:user.username,updated_at:now()}):r.reference_evidence;

      const checked=b.checked_through===undefined?r.checked_through:b.checked_through||null;
      if(checked!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(checked))throw new Error('核对日期格式错误');
      if(checked!==null&&(checked>shanghaiNow().slice(0,10)||checked<v.buy_time.slice(0,10)))throw new Error('核对范围必须在买入日期至今天之间');
      const results=await env.DB.batch([
        env.DB.prepare(`UPDATE records SET strategy_id=?,symbol=?,buy_time=?,original_time=?,name=?,version=?,actual_price=?,shares=?,reason=?,tags=?,notes=?,reference_price=?,reference_evidence=?,market_data=?,fetched_at=?,checked_through=?,error=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=?`).bind(v.strategy_id,v.symbol,v.buy_time,v.original_time,v.name,v.version,v.actual_price,v.shares,v.reason,v.tags,v.notes,changed?null:reference,changed?null:evidence,changed?null:r.market_data,changed?null:r.fetched_at,changed?null:checked,now(),r.id,r.revision),
        env.DB.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),r.id,user.username,'update',JSON.stringify(r),now())
      ]);
      return results[0].meta.changes?json({ok:true}):json({error:'记录已被修改，请刷新'},409);
    }
    if(request.method==='DELETE') {
      const b=await body(request);if(b.revision!==r.revision)return json({error:'记录已变化，请刷新后删除'},409);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM records WHERE id=? AND revision=?').bind(r.id,r.revision),
        env.DB.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),r.id,user.username,'delete',JSON.stringify(r),now())
      ]);return json({ok:true});
    }
  }
  if(url.pathname==='/api/suspensions'&&request.method==='POST')return json(await setSuspension(env.DB,await body(request),user.username));
  if(url.pathname==='/api/refresh'&&request.method==='POST') {
    const b=await body(request);if(!Array.isArray(b.ids)||b.ids.length>8)throw new Error('每批最多刷新8条记录，页面会自动分批');
    const results=[];
    const quotes=new Map<string,ReturnType<typeof verifiedDaily>>();
    for(const id of [...new Set(b.ids)] as string[]) {
      const r=await getRecord(env,id);if(!r)continue;
      try {
        if(!quotes.has(r.symbol))quotes.set(r.symbol,verifiedDaily(env,r.symbol));
        const d=await quotes.get(r.symbol)!,saved=mergeCloseWindow(r,d),conflicts=saved.validation.filter(v=>v.status!=='matched');
        const local=shanghaiNow(),due=collectionWindow(r).filter(date=>date<local.slice(0,10)||date===local.slice(0,10)&&local.slice(11)>='16:05:00');
        const valid=verifiedCloseDates(saved),stopped=suspendedDates(saved),missing=due.filter(date=>!valid.has(date)&&!stopped.has(date));
        const pending=[...new Set([...conflicts.map(v=>v.date),...missing])];
        const error=pending.length?'缺少交叉核对通过的收盘价：'+pending.join('、'):saved.adjustment.status==='pending'?'除权核对：'+saved.adjustment.reason:null;
        await env.DB.prepare('UPDATE records SET name=?,market_data=?,fetched_at=?,error=? WHERE id=? AND revision=?').bind(d.name||r.name,JSON.stringify(saved),d.fetchedAt,error,id,r.revision).run();
        results.push({id,ok:!error,cached:d.cached,error});
      } catch(e) {
        const error=e instanceof Error?e.message:'行情请求失败';
        await env.DB.prepare('UPDATE records SET error=? WHERE id=? AND revision=?').bind(error,id,r.revision).run();results.push({id,ok:false,error});
      }
    }
    return json({results});
  }
  if(url.pathname==='/api/quote'&&request.method==='GET') {
    const symbol=normalizeSymbol(url.searchParams.get('symbol'));
    return json(await daily(env,symbol));
  }
  if(url.pathname==='/api/minute'&&request.method==='GET') {
    const symbol=normalizeSymbol(url.searchParams.get('symbol')),date=url.searchParams.get('date')??'';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期格式错误');
    return json(await minute(env,symbol,date));
  }
  if(url.pathname==='/api/export'&&request.method==='GET') {
    const rows=(await env.DB.prepare('SELECT r.*,s.name AS strategy_name FROM records r JOIN strategies s ON s.id=r.strategy_id ORDER BY buy_time DESC').all<RecordRow>()).results;
    const columns=['id','batch_id','strategy_name','version','symbol','name','original_time','buy_time','actual_price','reference_price','reference_evidence','shares','reason','tags','notes','market_data','fetched_at','error','created_at','updated_at'] as const;
    const csv='\uFEFF'+[columns.map(csvCell).join(','),...rows.map(r=>columns.map(k=>csvCell(r[k])).join(','))].join('\r\n');
    return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="records.csv"'}});
  }
  if(url.pathname==='/api/summary'&&request.method==='GET') {
    const records=(await env.DB.prepare('SELECT * FROM records').all<RecordRow>()).results;
    return json(analysisSummary(records,await listStrategies(env)));
  }
  return json({error:'接口不存在'},404);
}
async function handle(request:Request,env:Env) {
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/'))return api(request,env,url);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  if(/^\/(?:market-data|research|backtest|users)(?:\.html)?\/?$/.test(url.pathname)){
    const user=await identity(request,env);
    if(!user)return Response.redirect(url.origin+'/',302);
    if(user.role!=='admin')return new Response('仅管理员可访问研究行情数据',{status:403,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
  if(/^\/(?:home|app|comparison|compare)(?:\.html)?\/?$/.test(url.pathname)){
    const user=await identity(request,env);
    if(!user)return Response.redirect(url.origin+'/',302);
    if(/^\/app(?:\.html)?\/?$/.test(url.pathname)&&user.role!=='admin')return Response.redirect(url.origin+'/comparison',302);
  }
  const alias=/^\/compare(?:\.html)?\/?$/.test(url.pathname)?'/comparison':/^\/backtest(?:\.html)?\/?$/.test(url.pathname)?'/research':null;
  if(alias){const target=new URL(request.url);target.pathname=alias;return env.ASSETS.fetch(new Request(target,request));}
  return env.ASSETS.fetch(request);
}
export default {
  async scheduled(event:ScheduledController,env:Env,ctx:ExecutionContext){
    ctx.waitUntil(runCloseSync(env,new Date(event.scheduledTime)));
  },
  async fetch(request:Request,env:Env) {
    let response:Response;
    try{response=await handle(request,env);}catch(e){
      const message=e instanceof Error?e.message:'请求失败';
      // Never expose database errors, stack traces or environment details.
      response=json({error:/D1_|SQLITE|syntax error|constraint|fetch failed/i.test(message)?'服务暂时不可用，请稍后重试':message},400);
    }
    const result=new Response(response.body,response);
    result.headers.set('Cache-Control','no-store');
    result.headers.set('X-Content-Type-Options','nosniff');
    result.headers.set('Referrer-Policy','no-referrer');
    result.headers.set('X-Frame-Options','DENY');
    // Pinned Lightweight Charts 5.0.9 inserts one immutable attribution-logo
    // stylesheet. Permit only that exact text on its page, never arbitrary CSS.
    const chartStyle=/^\/(?:research|backtest)(?:\.html)?\/?$/.test(new URL(request.url).pathname)?" 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='":'';
    result.headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'${chartStyle}; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    if(new URL(request.url).protocol==='https:')result.headers.set('Strict-Transport-Security','max-age=31536000');
    return result;
  }
};

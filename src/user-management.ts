import type {Env,Identity} from './types';
import {hashPassword,verifyPassword,sessionCookie,type ManagedUser} from './auth';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const fields='id,username,role,status,revision,created_at,updated_at';
type PublicUser={id:string;username:string;role:'admin'|'viewer';status:'active'|'disabled';revision:number;created_at:string;updated_at:string};
class InputError extends Error{}
function publicUser(user:PublicUser):PublicUser{return {id:user.id,username:user.username,role:user.role,status:user.status,revision:user.revision,created_at:user.created_at,updated_at:user.updated_at};}
function staticAccount(env:Env,username:string){return [env.ADMIN_USERNAME,env.VIEWER_USERNAME].filter(Boolean).some(name=>name!.toLowerCase()===username.toLowerCase());}
function password(value:unknown){
  if(typeof value!=='string'||value.length<12||value.length>256||!value.trim())throw new InputError('密码须为12至256位，且不能全部为空格');
  return value;
}
function accountRole(value:unknown):'admin'|'viewer'{
  if(value==='user')return 'viewer';
  if(value!=='admin'&&value!=='viewer')throw new InputError('角色只能是admin或viewer');
  return value;
}
async function body(request:Request){
  if(Number(request.headers.get('Content-Length')??0)>12000)throw new InputError('账号请求过大');
  const text=await request.text();
  if(new TextEncoder().encode(text).byteLength>12000)throw new InputError('账号请求过大');
  let value:any;try{value=JSON.parse(text);}catch{throw new InputError('需要有效JSON内容');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('请求内容必须为对象');
  return value;
}
function reason(value:unknown){
  if(typeof value!=='string'||!value.trim()||value.length>1000)throw new InputError('请填写不超过1000字的修改依据');
  return value.trim();
}
async function list(env:Env){
  const rows=(await env.DB.prepare(`SELECT ${fields} FROM research_users ORDER BY created_at,id LIMIT 201`).all<PublicUser>()).results;
  const static_accounts=[{username:env.ADMIN_USERNAME,role:'admin',managed:false},...(env.VIEWER_USERNAME&&env.VIEWER_PASSWORD_HASH?[{username:env.VIEWER_USERNAME,role:'viewer',managed:false}]:[])];
  return json({users:rows.slice(0,200).map(publicUser),static_accounts,truncated:rows.length>200});
}
async function create(request:Request,env:Env,actor:Identity){
  const value=await body(request);
  if(typeof value.username!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{2,79}$/.test(value.username))throw new InputError('用户名须为3至80位字母、数字或 _ . @ -，且以字母或数字开头');
  if(staticAccount(env,value.username))throw new InputError('该用户名由部署配置管理，不能在此覆盖');
  const role=accountRole(value.role??'viewer'),hash=await hashPassword(password(value.password));
  const now=new Date().toISOString(),id=crypto.randomUUID(),change=crypto.randomUUID();
  const user:PublicUser={id,username:value.username,role,status:'active',revision:1,created_at:now,updated_at:now};
  await env.DB.batch([
    env.DB.prepare('INSERT INTO research_users(id,username,password_hash,role,status,revision,last_change_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user.username,hash,role,'active',1,change,now,now),
    env.DB.prepare('INSERT INTO user_account_audit(id,user_id,actor,action,previous_value,new_value,reason,created_at) VALUES(?,?,?,?,NULL,?,?,?)').bind(change,id,actor.username,'create',JSON.stringify(user),'管理员开通指定账号',now)
  ]);
  return json({ok:true,user},201);
}
async function mutate(env:Env,actor:Identity,current:PublicUser,update:{role:'admin'|'viewer';status:'active'|'disabled';hash:string|null;reason:string;action:string}){
  const now=new Date().toISOString(),change=crypto.randomUUID();
  const next:PublicUser={...publicUser(current),role:update.role,status:update.status,revision:current.revision+1,updated_at:now};
  const gate='EXISTS(SELECT 1 FROM research_users WHERE id=? AND revision=? AND last_change_id=?)';
  const result=await env.DB.batch([
    env.DB.prepare('UPDATE research_users SET role=?,status=?,password_hash=COALESCE(?,password_hash),revision=revision+1,last_change_id=?,updated_at=? WHERE id=? AND revision=?').bind(update.role,update.status,update.hash,change,now,current.id,current.revision),
    env.DB.prepare(`INSERT INTO user_account_audit(id,user_id,actor,action,previous_value,new_value,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${gate}`)
      .bind(change,current.id,actor.username,update.action,JSON.stringify(publicUser(current)),JSON.stringify(next),update.reason,now,current.id,next.revision,change),
    env.DB.prepare(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM research_user_sessions WHERE user_id=?) AND ${gate}`).bind(current.id,current.id,next.revision,change)
  ]);
  if(!result[0].meta.changes)return json({error:'账号已被其他操作修改，请刷新后重试',code:'stale_revision'},409);
  return json({ok:true,user:next,sessions_revoked:true});
}
async function edit(request:Request,env:Env,actor:Identity,id:string){
  const value=await body(request);
  if(!Number.isSafeInteger(value.revision)||value.revision<1)throw new InputError('请提供有效账号版本');
  const current=await env.DB.prepare(`SELECT ${fields} FROM research_users WHERE id=?`).bind(id).first<PublicUser>();
  if(!current)return json({error:'账号不存在'},404);
  if(staticAccount(env,current.username))throw new InputError('该用户名现由部署配置管理，不能在此覆盖');
  if(current.revision!==value.revision)return json({error:'账号已更新，请刷新后重试',code:'stale_revision'},409);
  const role=value.role===undefined?current.role:accountRole(value.role);
  const status=value.status===undefined?current.status:value.status;
  if(!['active','disabled'].includes(status))throw new InputError('账号状态只能是active或disabled');
  const note=reason(value.reason),hash=value.password===undefined?null:await hashPassword(password(value.password));
  if(role===current.role&&status===current.status&&!hash)return json({ok:true,unchanged:true,user:publicUser(current),sessions_revoked:false});
  const result=await mutate(env,actor,current,{role,status,hash,reason:note,action:hash?'admin_update_with_password':'admin_update'});
  if(result.ok&&current.username===actor.username)result.headers.set('Set-Cookie',sessionCookie(request,'',0));
  return result;
}
async function ownPassword(request:Request,env:Env,actor:Identity){
  const managed=!staticAccount(env,actor.username);
  if(request.method==='GET')return json({username:actor.username,can_change:managed,managed,password_min_length:12,password_max_length:256,...(!managed?{message:'此账号的密码由Cloudflare部署密钥管理，请使用现有安全配置流程更改。'}:{})});
  if(request.method!=='POST')return json({error:'请求方法不支持'},405);
  if(!managed)return json({error:'此账号使用部署密钥管理密码，请在Cloudflare安全配置中更改；此接口不会覆盖部署密钥。',code:'environment_managed_password'},409);
  const value=await body(request),nextPassword=password(value.new_password);
  if(typeof value.current_password!=='string'||value.current_password.length>256)throw new InputError('请填写当前密码');
  const current=await env.DB.prepare(`SELECT ${fields},password_hash FROM research_users WHERE username=? AND status='active'`).bind(actor.username).first<PublicUser&ManagedUser>();
  if(!current||!await verifyPassword(value.current_password,current.password_hash))return json({error:'当前密码不正确'},401);
  const result=await mutate(env,actor,current,{role:current.role,status:current.status,hash:await hashPassword(nextPassword),reason:'用户自行修改密码',action:'self_password_change'});
  if(result.ok)result.headers.set('Set-Cookie',sessionCookie(request,'',0));
  return result;
}

/** Root authenticates the actor and applies CSRF/JSON checks; this module also
 * rejects missing roles and cross-origin mutations when called directly. */
export async function userManagementApi(request:Request,env:Env,url:URL,actor:Identity):Promise<Response>{
  if(!actor)return json({error:'请先登录'},401);
  if(!['GET','HEAD'].includes(request.method)){
    if(request.headers.get('Origin')!==url.origin)return json({error:'请求来源校验失败'},403);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'需要JSON请求'},415);
  }
  try{
    if(url.pathname==='/api/account/password')return await ownPassword(request,env,actor);
    if(actor.role!=='admin')return json({error:'仅管理员可管理用户'},403);
    if(url.pathname==='/api/users'&&request.method==='GET')return await list(env);
    if(url.pathname==='/api/users'&&request.method==='POST')return await create(request,env,actor);
    const match=url.pathname.match(/^\/api\/users\/([a-f0-9-]{36})$/);
    if(match&&request.method==='PATCH')return await edit(request,env,actor,match[1]);
    return json({error:'用户管理接口或方法不存在'},404);
  }catch(error){
    if(error instanceof InputError)return json({error:error.message},400);
    if(error instanceof Error&&/UNIQUE constraint failed: research_users.username/i.test(error.message))return json({error:'用户名已存在'},409);
    return json({error:'账号管理暂不可用，请确认数据库迁移已完成后重试'},503);
  }
}

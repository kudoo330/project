import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {hashPassword,verifyPassword,login,identity,logout,digest} from '../src/auth';
import {userManagementApi} from '../src/user-management';
import type {Env,Identity} from '../src/types';

const admin:Identity={username:'admin',role:'admin'};
const initial='synthetic-initial-password',changed='synthetic-changed-password';
const site='https://accounts.test';
const cookie=(response:Response)=>response.headers.get('Set-Cookie')!.split(';')[0];
function request(path:string,method='GET',data?:unknown,session?:string){
  return new Request(site+path,{method,headers:{Origin:site,'Content-Type':'application/json',...(session?{Cookie:session}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
async function fixture(all=true){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic fixture")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'accounts-'+crypto.randomUUID()}}));
  const db=await mf.getD1Database('DB');
  for(const name of ['0001_initial.sql',...(all?['0007_research_users.sql']:[])]){
    const schema=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    await db.batch(schema.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  const env={DB:db,ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:await hashPassword('synthetic-admin-password'),VIEWER_USERNAME:'legacy',VIEWER_PASSWORD_HASH:await hashPassword('synthetic-legacy-password')} as unknown as Env;
  const call=(path:string,method='GET',data?:unknown,actor:Identity=admin)=>{const req=request(path,method,data);return userManagementApi(req,env,new URL(req.url),actor);};
  const signIn=(username:string,password:string)=>login(request('/api/login','POST',{username,password}),env);
  return {mf,db,env,call,signIn};
}

test('existing static credentials and sessions survive without account migration; both password channels are unchanged',async()=>{
  const f=await fixture(false);
  try{
    const response=await f.signIn('admin','synthetic-admin-password');assert.equal(response.status,200);
    assert.deepEqual(await identity(request('/api/me','GET',undefined,cookie(response)),f.env),admin);
    const viewer=await f.signIn('legacy','synthetic-legacy-password');assert.equal(viewer.status,200);
    assert.deepEqual(await identity(request('/api/me','GET',undefined,cookie(viewer)),f.env),{username:'legacy',role:'viewer'});
    const header=request('/api/login','POST',{username:'admin'});header.headers.set('X-Tracker-Admin-Password','synthetic-admin-password');
    assert.equal((await login(header,f.env)).status,200);
    const oldHash=f.env.ADMIN_PASSWORD_HASH;
    assert.equal((await f.call('/api/account/password','POST',{current_password:'synthetic-admin-password',new_password:changed})).status,409);
    assert.equal(f.env.ADMIN_PASSWORD_HASH,oldHash);
    assert.equal((await(await f.call('/api/account/password')).json() as any).can_change,false);
  }finally{await f.mf.dispose();}
});

test('real D1 account provisioning is private, hashes credentials and never exposes them in metadata or audit',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM research_users').first<any>())!.n,0);
    const ordinary:Identity={username:'ordinary',role:'viewer'};
    assert.equal((await f.call('/api/users','GET',undefined,ordinary)).status,403);
    assert.equal((await f.call('/api/users','POST',{username:'blocked',password:initial},ordinary)).status,403);
    const foreign=request('/api/users','POST',{username:'blocked',password:initial});foreign.headers.set('Origin','https://foreign.test');
    assert.equal((await userManagementApi(foreign,f.env,new URL(foreign.url),admin)).status,403);
    assert.equal((await f.call('/api/users','POST',{username:'ADMIN',password:initial})).status,400);
    assert.equal((await f.call('/api/users','POST',{username:'valid',password:'short'})).status,400);
    const created=await f.call('/api/users','POST',{username:'researcher',password:initial});assert.equal(created.status,201);
    const {user}=await created.json() as any;assert.equal(user.role,'viewer');assert.equal(user.revision,1);
    const stored=await f.db.prepare('SELECT password_hash FROM research_users WHERE id=?').bind(user.id).first<any>();
    assert.notEqual(stored.password_hash,initial);assert.equal(await verifyPassword(initial,stored.password_hash),true);
    assert.equal((await f.call('/api/users','POST',{username:'RESEARCHER',password:initial})).status,409);
    const list=await(await f.call('/api/users')).text(),audit=JSON.stringify((await f.db.prepare('SELECT * FROM user_account_audit').all()).results);
    for(const output of [JSON.stringify(user),list,audit]){assert.equal(output.includes(initial),false);assert.equal(output.includes('password_hash'),false);assert.equal(output.includes('pbkdf2$'),false);}
    const authenticated=await f.signIn('RESEARCHER',initial);assert.equal(authenticated.status,200);
    assert.deepEqual(await identity(request('/api/me','GET',undefined,cookie(authenticated)),f.env),{username:'researcher',role:'viewer'});
    await logout(request('/api/logout','POST',{},cookie(authenticated)),f.env);
    assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM research_user_sessions').first<any>())!.n,0);
  }finally{await f.mf.dispose();}
});

test('disable, role and password changes revoke all existing sessions, enforce revisions and retain audit',async()=>{
  const f=await fixture();
  try{
    let {user}=await(await f.call('/api/users','POST',{username:'researcher',password:initial})).json() as any;
    const first=cookie(await f.signIn(user.username,initial)),second=cookie(await f.signIn(user.username,initial));
    const patch=async(values:any)=>f.call('/api/users/'+user.id,'PATCH',{revision:user.revision,reason:'Synthetic account lifecycle verification',...values});
    let response=await patch({status:'disabled'});assert.equal(response.status,200);user=(await response.json() as any).user;
    for(const session of [first,second])assert.equal(await identity(request('/api/me','GET',undefined,session),f.env),null);
    assert.equal((await f.signIn(user.username,initial)).status,401);
    assert.equal((await f.call('/api/users/'+user.id,'PATCH',{revision:1,reason:'Stale edit',status:'active'})).status,409);
    response=await patch({status:'active'});user=(await response.json() as any).user;
    const viewerSession=cookie(await f.signIn(user.username,initial));
    response=await patch({role:'admin'});user=(await response.json() as any).user;
    assert.equal(await identity(request('/api/me','GET',undefined,viewerSession),f.env),null);
    const promoted=cookie(await f.signIn(user.username,initial));
    assert.deepEqual(await identity(request('/api/me','GET',undefined,promoted),f.env),{username:user.username,role:'admin'});
    response=await patch({password:changed});user=(await response.json() as any).user;
    assert.equal(await identity(request('/api/me','GET',undefined,promoted),f.env),null);
    assert.equal((await f.signIn(user.username,initial)).status,401);
    assert.equal((await f.signIn(user.username,changed)).status,200);
    assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM user_account_audit WHERE user_id=?').bind(user.id).first<any>())!.n,5);
    // A session whose mapping has an old revision must fail even if not deleted.
    const live=cookie(await f.signIn(user.username,changed)),token=live.split('=')[1];
    await f.db.prepare('UPDATE research_user_sessions SET user_revision=user_revision-1 WHERE token_hash=?').bind(await digest(token)).run();
    assert.equal(await identity(request('/api/me','GET',undefined,live),f.env),null);
  }finally{await f.mf.dispose();}
});

test('self password change checks the current password, revokes sessions and preserves exact whitespace; failures never lock login',async()=>{
  const f=await fixture();
  try{
    const {user}=await(await f.call('/api/users','POST',{username:'researcher',password:initial})).json() as any;
    const actor:Identity={username:user.username,role:'viewer'},session=cookie(await f.signIn(user.username,initial));
    assert.equal((await(await f.call('/api/account/password','GET',undefined,actor)).json() as any).can_change,true);
    assert.equal((await f.call('/api/account/password','POST',{current_password:'incorrect',new_password:changed},actor)).status,401);
    assert.deepEqual(await identity(request('/api/me','GET',undefined,session),f.env),actor);
    const exact=' '+changed+' ';
    const response=await f.call('/api/account/password','POST',{current_password:initial,new_password:exact},actor);assert.equal(response.status,200);
    assert.match(response.headers.get('Set-Cookie')!,/Max-Age=0/);
    assert.equal(await identity(request('/api/me','GET',undefined,session),f.env),null);
    for(let i=0;i<12;i++)assert.equal((await f.signIn(user.username,'incorrect-password')).status,401);
    assert.equal((await f.signIn(user.username,changed)).status,401);
    assert.equal((await f.signIn(user.username,exact)).status,200);
    assert.equal((await f.signIn('admin','synthetic-admin-password')).status,200);
    const audit=JSON.stringify((await f.db.prepare('SELECT * FROM user_account_audit').all()).results);
    assert.equal(audit.includes(changed),false);assert.equal(audit.includes(initial),false);assert.match(audit,/self_password_change/);
  }finally{await f.mf.dispose();}
});

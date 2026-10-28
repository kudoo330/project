import type { Env, Identity } from './types';
const encoder = new TextEncoder();
const hex = (a: ArrayBuffer) => [...new Uint8Array(a)].map(n => n.toString(16).padStart(2, '0')).join('');
export async function digest(s: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(s))); }
export async function verifyPassword(password: string, encoded: string) {
  const [kind, rounds, salt, expected] = encoded.split('$');
  if (kind !== 'pbkdf2' || Number(rounds) !== 100000 || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const actual = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: Number(rounds) }, key, 256));
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
export async function hashPassword(password: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
  return `pbkdf2$100000$${salt}$${hash}`;
}
export interface ManagedUser {id:string;username:string;password_hash:string;role:'admin'|'viewer';status:'active'|'disabled';revision:number}
export function cookieName(request: Request) { return new URL(request.url).protocol === 'https:' ? '__Host-session' : 'dev-session'; }
export function sessionCookie(request: Request, token: string, maxAge: number) {
  return `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function identity(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(request) + '='))?.split('=')[1];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash=await digest(token);
  const session=await env.DB.prepare('SELECT username,role FROM sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash, Date.now()).first<Identity>();
  if(!session)return null;
  // Preserve existing environment-managed sessions without requiring new tables.
  if(session.role==='admin'&&session.username===env.ADMIN_USERNAME&&env.ADMIN_PASSWORD_HASH)return session;
  if(session.role==='viewer'&&session.username===env.VIEWER_USERNAME&&env.VIEWER_PASSWORD_HASH)return session;
  const user=await env.DB.prepare(`SELECT u.username,u.role FROM research_user_sessions s JOIN research_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND u.status='active' AND u.revision=s.user_revision AND u.username=? AND u.role=?`)
    .bind(tokenHash,session.username,session.role).first<Identity>();
  return user;
}
export async function login(request: Request, env: Env) {
  if (!env.ADMIN_PASSWORD_HASH) return Response.json({ error: '管理员尚未配置，网站保持锁定。' }, { status: 503 });
  const raw=await request.text();
  if(raw.length>4096)return Response.json({error:'登录请求过大'},{status:413});
  const data = JSON.parse(raw) as { username?: string; password?: string };
  const username = String(data.username ?? '').slice(0, 80);
  // Proxy-backed Codex credentials travel in a scoped HTTPS header, never in a URL.
  // This uses the same admin hash and session creation as browser login.
  const scopedPassword=request.headers.get('X-Tracker-Admin-Password');
  if(scopedPassword!==null&&username!==env.ADMIN_USERNAME)return Response.json({error:'此凭据通道仅用于管理员登录'},{status:401});
  const password = scopedPassword??String(data.password ?? '');
  if (password.length > 256) return Response.json({ error: '登录失败' }, { status: 400 });
  const staticRole = username === env.ADMIN_USERNAME ? 'admin' : username === env.VIEWER_USERNAME ? 'viewer' : null;
  let managed:ManagedUser|null=null;
  if(!staticRole){
    try{managed=await env.DB.prepare('SELECT id,username,password_hash,role,status,revision FROM research_users WHERE username=?').bind(username).first<ManagedUser>();}
    catch{return Response.json({error:'账号服务暂不可用，请管理员确认数据库迁移已完成。'},{status:503});}
  }
  const role=staticRole??managed?.role??null;
  const encoded=staticRole==='admin'?env.ADMIN_PASSWORD_HASH:staticRole==='viewer'?env.VIEWER_PASSWORD_HASH:managed?.password_hash;
  // Unknown usernames take the same PBKDF2 path as valid users.
  const valid = await verifyPassword(password, encoded || env.ADMIN_PASSWORD_HASH);
  if (!role || !encoded || !valid || managed?.status==='disabled') return Response.json({ error: '用户名或密码错误' }, { status: 401 });
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  if(managed){
    const tokenHash=await digest(token);
    const inserted=await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()),
      env.DB.prepare(`INSERT INTO sessions(token_hash,username,role,expires_at)
        SELECT ?,username,role,? FROM research_users WHERE id=? AND revision=? AND status='active'`)
        .bind(tokenHash,Date.now()+28800000,managed.id,managed.revision),
      env.DB.prepare(`INSERT INTO research_user_sessions(token_hash,user_id,user_revision)
        SELECT ?,id,revision FROM research_users WHERE id=? AND revision=? AND status='active' AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)`)
        .bind(tokenHash,managed.id,managed.revision,tokenHash)
    ]);
    if(!inserted[1].meta.changes)return Response.json({error:'账号已更新，请重新登录。'},{status:401});
    return Response.json({username:managed.username,role:managed.role},{headers:{'Set-Cookie':sessionCookie(request,token,28800)}});
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions(token_hash,username,role,expires_at) VALUES(?,?,?,?)').bind(await digest(token), username, role, Date.now()+28800000)
  ]);
  return Response.json({ username, role }, { headers: { 'Set-Cookie': sessionCookie(request, token, 28800) } });
}
export async function logout(request: Request, env: Env) {
  const token = request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(request)+'='))?.split('=')[1];
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(request, '', 0) } });
}

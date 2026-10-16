import {digest} from './auth';
const schema='CREATE TABLE IF NOT EXISTS read_access (token_hash TEXT PRIMARY KEY,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)';
const initialized=new WeakMap<object,Promise<unknown>>();
export async function ensureReadAccess(db:D1Database){let ready=initialized.get(db);if(!ready){ready=db.prepare(schema).run();initialized.set(db,ready);}try{await ready;}catch(e){initialized.delete(db);throw e;}}
export async function generateReadToken(db:D1Database,actor:string,now=Date.now()){
 await ensureReadAccess(db);
 const bytes=crypto.getRandomValues(new Uint8Array(32)),token='read_'+[...bytes].map(v=>v.toString(16).padStart(2,'0')).join(''),expires_at=now+7*86400000;
 const hash=await digest(token);
 // One active token; rotation atomically invalidates all previous tokens.
 await db.batch([db.prepare('DELETE FROM read_access'),db.prepare('INSERT INTO read_access(token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?)').bind(hash,actor,now,expires_at)]);
 return {token,expires_at};
}
export async function canReadWithToken(db:D1Database,request:Request,now=Date.now()){
 if(request.method!=='GET')return false;
 const token=request.headers.get('X-Tracker-Read-Token')??'';
 if(!/^read_[a-f0-9]{64}$/.test(token))return false;
 await ensureReadAccess(db);
 return Boolean(await db.prepare('SELECT 1 AS allowed FROM read_access WHERE token_hash=? AND expires_at>?').bind(await digest(token),now).first());
}
export async function revokeReadToken(db:D1Database){await ensureReadAccess(db);await db.prepare('DELETE FROM read_access').run();}

import {test,expect,request} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash,pbkdf2Sync} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('old lockouts and repeated failures never block valid login, while authentication remains required',async()=>{
  const salt='1234567890abcdef1234567890abcdef';
  const hash=(password:string)=>'pbkdf2$100000$'+salt+'$'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-16',d1Databases:{DB:'isolated-login-retry-fixture'},bindings:{ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash('local-test-admin-only'),VIEWER_USERNAME:'viewer',VIEWER_PASSWORD_HASH:hash('local-test-viewer-only')}}));
  const origin=(await mf.ready).origin,ip='192.0.2.42';
  const c=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin,'CF-Connecting-IP':ip}});
  try{
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_initial.sql','0007_research_users.sql']){
      const schema=await readFile(new URL('../../migrations/'+name,import.meta.url),'utf8');
      await db.batch(schema.replace(/--[^\n]*/g,'').split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
    }
    for(const value of [ip,'127.0.0.1','local'])await db.prepare('INSERT INTO login_limits(key,attempts,expires_at) VALUES(?,99,?)').bind(createHash('sha256').update(value).digest('hex'),Date.now()+900000).run();
    const valid={username:'admin',password:'local-test-admin-only'};
    expect((await c.post('/api/login',{data:valid})).status()).toBe(200);
    expect((await(await c.get('/api/me')).json()).role).toBe('admin');
    await c.post('/api/logout',{data:{}});
    for(let i=0;i<12;i++){
      const failed=await c.post('/api/login',{data:{...valid,password:'incorrect-test-password'}});
      expect(failed.status()).toBe(401);
      expect((await failed.json()).error).toBe('用户名或密码错误');
    }
    expect((await c.get('/api/me')).status()).toBe(401);
    expect((await c.post('/api/login',{data:{...valid,username:'unknown'}})).status()).toBe(401);
    expect((await c.post('/api/login',{headers:{Origin:'https://invalid.test'},data:valid})).status()).toBe(403);
    expect((await c.post('/api/login',{headers:{'X-Tracker-Admin-Password':'local-test-viewer-only'},data:{username:'viewer'}})).status()).toBe(401);
    expect((await c.post('/api/login',{data:valid})).status()).toBe(200);
    await c.post('/api/logout',{data:{}});
    expect((await c.post('/api/login',{headers:{'X-Tracker-Admin-Password':'local-test-admin-only'},data:{username:'admin'}})).status()).toBe(200);
    await c.post('/api/logout',{data:{}});
    expect((await c.get('/api/me')).status()).toBe(401);
    const rows=(await db.prepare('SELECT attempts FROM login_limits').all()).results;
    expect(rows).toHaveLength(3);expect(rows.every(row=>row.attempts===99)).toBe(true);
  }finally{await c.dispose();await mf.dispose();}
});

import {test,expect,request} from '@playwright/test';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pbkdf2Sync} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('ordinary users cannot read private A-share records, AMD research, exports or user administration',async()=>{
  const salt='1234567890abcdef1234567890abcdef';
  const hash=(password:string)=>'pbkdf2$100000$'+salt+'$'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-16',d1Databases:{DB:'research-rbac-isolated'},bindings:{ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash('isolated-admin-password'),VIEWER_USERNAME:'viewer',VIEWER_PASSWORD_HASH:hash('isolated-viewer-password')},serviceBindings:{ASSETS:async()=>new Response('authenticated page fixture')}}));
  const origin=(await mf.ready).origin,c=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
  try{
    const db=await mf.getD1Database('DB'),dir=new URL('../../migrations/',import.meta.url);
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()){
      const sql=await readFile(new URL(name,dir),'utf8');await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    const privatePaths=['/api/records','/api/strategies','/api/summary','/api/export','/api/close-sync','/api/research-data/datasets','/api/research/chart','/api/research/groups','/api/research/markers','/api/research/markers/export','/api/users'];
    for(const path of privatePaths)expect((await c.get(path)).status(),path).toBe(401);
    for(const path of ['/home','/home.html','/compare','/compare.html','/backtest','/backtest.html','/research','/research.html','/market-data','/users','/comparison','/app'])expect((await c.get(path,{maxRedirects:0})).status(),path).toBe(302);
    expect((await c.post('/api/login',{data:{username:'viewer',password:'isolated-viewer-password'}})).status()).toBe(200);
    for(const path of privatePaths)expect((await c.get(path)).status(),path).toBe(403);
    for(const path of ['/backtest','/backtest.html','/research','/research.html','/market-data','/users'])expect((await c.get(path,{maxRedirects:0})).status(),path).toBe(403);
    for(const path of ['/home','/compare','/comparison'])expect((await c.get(path)).status()).toBe(200);
    expect((await c.get('/app',{maxRedirects:0})).headers().location).toBe(origin+'/comparison');
    expect((await c.get('/api/account/password')).status()).toBe(200);
    expect((await c.get('/api/quote?symbol=invalid')).status()).toBe(400);
    expect((await c.post('/api/research/groups',{data:{name:'not-authorized'}})).status()).toBe(403);expect((await c.delete('/api/research-data/datasets/market_'+'a'.repeat(64),{data:{request_id:crypto.randomUUID(),expected_revision:1,reason:'not authorized'}})).status()).toBe(403);
    await c.post('/api/logout',{data:{}});
    expect((await c.post('/api/login',{data:{username:'admin',password:'isolated-admin-password'}})).status()).toBe(200);
    for(const path of ['/api/records','/api/research-data/datasets','/api/research/groups','/api/research/markers','/api/users'])expect((await c.get(path)).status(),path).toBe(200);
    for(const path of ['/home','/compare','/backtest','/app','/research','/users','/comparison'])expect((await c.get(path)).status(),path).toBe(200);
    expect((await c.post('/api/research/groups',{headers:{Origin:'https://foreign.test'},data:{name:'blocked'}})).status()).toBe(403);
    expect((await db.prepare('SELECT COUNT(*) n FROM records').first<any>())!.n).toBe(0);
  }finally{await c.dispose();await mf.dispose();}
});

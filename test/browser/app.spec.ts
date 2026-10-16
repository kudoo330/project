import {test,expect,request as makeRequest} from '@playwright/test';
import {pbkdf2Sync} from 'node:crypto';
const origin='http://127.0.0.1:8787';
const headers={Origin:origin};
const prefix='LOCAL-VERIFICATION-';
test('password helper matches server format and sends no password requests',async({page})=>{
  const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
  await page.goto('/password-tool');
  await page.locator('[name=password]').fill('local-test-new-password');await page.locator('[name=confirm]').fill('local-test-new-password');await page.getByRole('button',{name:'生成哈希'}).click();
  await expect(page.locator('#password-hash')).toHaveValue(/^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  const value=await page.locator('#password-hash').inputValue(),[,rounds,salt,hash]=value.split('$');
  expect(pbkdf2Sync('local-test-new-password',salt,Number(rounds),32,'sha256').toString('hex')).toBe(hash);
  expect(await page.locator('[name=password]').inputValue()).toBe('');expect(writes).toEqual([]);
});
test('unauthenticated pages and APIs cannot expose records',async({request})=>{
  expect((await request.get('/api/records')).status()).toBe(401);
  expect((await request.get('/api/export')).status()).toBe(401);
  const page=await request.get('/app.html',{maxRedirects:0});expect(page.status()).toBe(302);
  expect((await request.get('/app',{maxRedirects:0})).status()).toBe(302);
});
test('viewer may read but cannot create, edit, delete or refresh',async()=>{
  const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});
  const response=await c.post('/api/login',{data:{username:'viewer',password:'local-test-viewer-only'}});expect(response.ok()).toBeTruthy();
  expect((await c.get('/api/records')).status()).toBe(200);
  for(const [path,method]of [['/api/records','POST'],['/api/records/nonexistent','PATCH'],['/api/records/nonexistent','DELETE'],['/api/refresh','POST']])expect((await c.fetch(path,{method,data:{}})).status()).toBe(403);
  await c.post('/api/logout',{data:{}});expect((await c.get('/api/records')).status()).toBe(401);await c.dispose();
});
test('origin protection, cross-strategy samples, retries, revision and persistence',async()=>{
  const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});
  expect((await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}})).ok()).toBeTruthy();
  expect((await c.post('/api/records',{headers:{Origin:'https://untrusted.invalid'},data:{}})).status()).toBe(403);
  const stamp=new Date(Date.now()+8*3600000-1800000).toISOString().slice(0,19),request_id=crypto.randomUUID();
  const rows=['twenty-minute','898'].map(strategy_id=>({strategy_id,symbol:'300111.SZ',buy_time:stamp,actual_price:3.1,notes:prefix+request_id,reason:'=HYPERLINK("unsafe")'}));
  try{
    const responses=await Promise.all([c.post('/api/records',{data:{rows,request_id}}),c.post('/api/records',{data:{rows,request_id}})]);for(const r of responses)expect(r.ok()).toBeTruthy();
    let all=(await(await c.get('/api/records')).json()).records;let own=all.filter(r=>r.notes===prefix+request_id);expect(own).toHaveLength(2);expect(new Set(own.map(r=>r.id)).size).toBe(2);
    expect((await c.post('/api/records',{data:{rows:[{...rows[0],actual_price:9}],request_id}})).status()).toBe(409);
    const duplicate=await c.post('/api/records',{data:{rows:[rows[0]],request_id:crypto.randomUUID()}});expect(duplicate.status()).toBe(409);
    const row=own[0];expect((await c.patch('/api/records/'+row.id,{data:{revision:row.revision,actual_price:3.2}})).ok()).toBeTruthy();
    expect((await c.patch('/api/records/'+row.id,{data:{revision:row.revision,actual_price:99}})).status()).toBe(409);
    const one=await(await c.get('/api/records/'+row.id)).json();expect(one.actual_price).toBe(3.2);
    const other=await(await c.get('/api/records/'+own[1].id)).json();expect(other.actual_price).toBe(3.1);
    expect(await(await c.get('/api/export')).text()).toContain("'=HYPERLINK");
    await c.post('/api/logout',{data:{}});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});
    expect((await(await c.get('/api/records/'+row.id)).json()).actual_price).toBe(3.2);
  }finally{
    const all=(await(await c.get('/api/records')).json()).records;
    for(const row of all.filter(r=>r.notes===prefix+request_id))await c.delete('/api/records/'+row.id,{data:{revision:row.revision}});
    await c.dispose();
  }
});
test('desktop login, empty state, form and theme',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();
  await expect(page).toHaveURL(/\/app(?:\.html)?$/);await expect(page.getByText('从第一条记录开始')).toBeVisible();
  await page.locator('#add').click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'数据与设置'}).click();await page.getByRole('button',{name:'切换深色 / 浅色'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('button',{name:'买入追踪',exact:false}).click();
  await page.screenshot({path:'/workspace/scratch/tracker-desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('mobile viewer has readable navigation and no edit controls',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByLabel('用户名').fill('viewer');await page.getByLabel('密码',{exact:true}).fill('local-test-viewer-only');await page.getByRole('button',{name:'登录研究室'}).click();
  await expect(page).toHaveURL(/\/app(?:\.html)?$/);await expect(page.getByText('从第一条记录开始')).toBeVisible();await expect(page.locator('#add')).toBeHidden();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:'/workspace/scratch/tracker-mobile.png',fullPage:true});
});
test('single-entry UI creates independent strategy samples; CSV preview rejects bad rows',async({page})=>{
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();await expect(page).toHaveURL(/\/app(?:\.html)?$/);
  const note=prefix+crypto.randomUUID();
  try{
    await page.locator('#add').click();const form=page.locator('#record-form');await form.locator('[name=strategies]').selectOption(['twenty-minute','898']);await form.locator('[name=symbol]').fill('300111.SZ');await form.locator('[name=time]').fill('09:47:00');await form.locator('[name=actual_price]').fill('3.1');await form.locator('[name=notes]').fill(note);await form.getByRole('button',{name:'保存记录'}).click();await expect(page.locator('#editor')).not.toBeVisible();
    await expect(page.locator('#record-count')).toContainText('2 个策略样本');
    await page.locator('#import').click();await page.locator('#paste').fill('BAD 09:47\n688265.SH 10:05');await page.locator('#preview-import').click();await expect(page.locator('#submit-import')).toBeDisabled();await expect(page.locator('#import-summary')).toContainText('1行有错误');await page.locator('#importer .close').click();
  }finally{
    const response=await page.request.get('/api/records');if(response.ok())for(const r of (await response.json()).records.filter(r=>r.notes===note))await page.request.delete('/api/records/'+r.id,{headers,data:{revision:r.revision}});
  }
});

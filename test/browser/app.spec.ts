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
  for(const [path,method]of [['/api/import-closes','POST'],['/api/import-reviewed','POST'],['/api/records','POST'],['/api/records/nonexistent','PATCH'],['/api/records/nonexistent','DELETE'],['/api/refresh','POST'],['/api/strategies/twenty-minute/analysis-rule','PATCH']])expect((await c.fetch(path,{method,data:{}})).status()).toBe(403);
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
test('strategy scope persists independently, handles stale revisions and never removes original samples',async()=>{
  const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});
  const old=await(await c.get('/api/strategies')).json(),ids=['twenty-minute','898'],before=(await(await c.get('/api/records')).json()).records.length,note=prefix+crypto.randomUUID();
  const yesterday=new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
  try{
    const rows=[['twenty-minute','09:31:00',null],['twenty-minute','09:40:00',3],['898','13:00:00',3],['898','10:00:00',3]].map(([strategy_id,time,actual_price])=>({strategy_id,buy_time:yesterday+'T'+time,symbol:'300111.SZ',actual_price,notes:note}));
    expect((await c.post('/api/records',{data:{rows,request_id:crypto.randomUUID(),confirm_duplicates:true}})).ok()).toBeTruthy();
    for(const id of ids){const s=old.find(s=>s.id===id),rule=id==='twenty-minute'?{first_n:1,before_time:null}:{first_n:null,before_time:'13:00'};const r=await c.patch('/api/strategies/'+id+'/analysis-rule',{data:{revision:s.analysis_revision,rule}});expect(r.ok()).toBeTruthy();}
    const stale=await c.patch('/api/strategies/twenty-minute/analysis-rule',{data:{revision:old.find(s=>s.id==='twenty-minute').analysis_revision,rule:{}}});expect(stale.status()).toBe(409);
    const fresh=await(await c.get('/api/strategies')).json(),a=fresh.find(s=>s.id==='twenty-minute');expect((await c.patch('/api/strategies/twenty-minute/analysis-rule',{data:{revision:a.analysis_revision,rule:{first_n:0}}})).status()).toBe(400);
    const all=(await(await c.get('/api/records')).json()).records;expect(all.length).toBe(before+4);const own=all.filter(r=>r.notes===note),summary=await(await c.get('/api/summary')).json();
    const selected=summary.find(s=>s.strategy_id==='analysis-all').selected_ids;
    expect(own.filter(r=>selected.includes(r.id)).map(r=>r.buy_time.slice(11)).sort()).toEqual(['09:31:00','10:00:00']);
    expect(summary.find(s=>s.strategy_id==='all').samples).toBe(before+4);expect(summary.find(s=>s.strategy_id==='twenty-minute').points[0].count).toBe(0);
    await c.post('/api/logout',{data:{}});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});expect((await(await c.get('/api/strategies')).json()).find(s=>s.id==='898').analysis_rule.before_time).toBe('13:00:00');
  }finally{
    for(const r of (await(await c.get('/api/records')).json()).records.filter(r=>r.notes===note))await c.delete('/api/records/'+r.id,{data:{revision:r.revision}});
    const current=await(await c.get('/api/strategies')).json();for(const id of ids)await c.patch('/api/strategies/'+id+'/analysis-rule',{data:{revision:current.find(s=>s.id===id).analysis_revision,rule:old.find(s=>s.id===id).analysis_rule}});await c.dispose();
  }
});
test('strategy analysis dialog previews, saves, survives reload and can reset to all',async({page})=>{
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();await expect(page).toHaveURL(/\/app(?:\.html)?$/);
  await page.getByRole('button',{name:'策略比较',exact:false}).click();const row=page.locator('.strategy-row').filter({hasText:'20分钟策略'});
  try{
    await row.getByRole('button',{name:'分析范围',exact:true}).click();const form=page.locator('#analysis-rule-form');await form.locator('[name=first_enabled]').check();await form.locator('[name=before_enabled]').check();await form.locator('[name=first_n]').fill('10');await expect(page.locator('#analysis-rule-preview')).toContainText('13:00:00');await form.getByRole('button',{name:'保存分析范围'}).click();await expect(page.locator('#analysis-editor')).not.toBeVisible();await expect(row).toContainText('最早 10 条样本');
    await page.reload();await page.getByRole('button',{name:'策略比较',exact:false}).click();await expect(row).toContainText('严格早于 13:00:00');await row.getByRole('button',{name:'分析范围',exact:true}).click();await expect(page.locator('[name=first_enabled]')).toBeChecked();await expect(page.locator('[name=before_enabled]')).toBeChecked();await page.locator('#analysis-rule-form').getByRole('button',{name:'恢复全部样本'}).click();await expect(page.locator('#analysis-rule-preview')).toContainText('全部策略样本');await page.locator('#analysis-rule-form').getByRole('button',{name:'保存分析范围'}).click();await expect(page.locator('#analysis-editor')).not.toBeVisible();
    await page.locator('#strategy-summary').getByRole('button',{name:'查看入选范围'}).first().click();await expect(page.locator('#analysis-members')).toBeVisible();await expect(page.locator('#analysis-members-content')).toContainText('服务端总计');
  }finally{
    const current=await(await page.request.get('/api/strategies')).json(),s=current.find(s=>s.id==='twenty-minute');await page.request.patch('/api/strategies/twenty-minute/analysis-rule',{headers,data:{revision:s.analysis_revision,rule:{}}});
  }
});

test('admin reviewed-file import saves reference prices and safely replays',async({page,request})=>{
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();await expect(page).toHaveURL(/\/app(?:\.html)?$/);
  const strategy='LOCAL-IMPORT-'+crypto.randomUUID(),stamp=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,19);
  const fixture=[{strategy,symbol:'300111.SZ',name:'TEST FIXTURE',buy_time:stamp,reference_price:12.34,reference_evidence:{provider:'synthetic test source'}}];
  const upload=()=>page.locator('#reviewed-file').setInputFiles({name:'reviewed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  page.on('dialog',dialog=>dialog.accept());
  const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});
  try{
    let saved=page.waitForResponse(r=>r.url().endsWith('/api/import-reviewed')&&r.request().method()==='POST');await upload();expect((await saved).ok()).toBeTruthy();
    let own=(await(await c.get('/api/records')).json()).records.filter(r=>r.strategy_name===strategy);expect(own).toHaveLength(1);expect(own[0].reference_price).toBe(12.34);expect(own[0].actual_price).toBeNull();
    saved=page.waitForResponse(r=>r.url().endsWith('/api/import-reviewed')&&r.request().method()==='POST');await upload();expect((await(await saved).json()).replayed).toBeTruthy();
    own=(await(await c.get('/api/records')).json()).records.filter(r=>r.strategy_name===strategy);expect(own).toHaveLength(1);
  }finally{
    for(const r of (await(await c.get('/api/records')).json()).records.filter(r=>r.strategy_name===strategy))await c.delete('/api/records/'+r.id,{data:{revision:r.revision}});
    await c.dispose();
  }
});
test('reviewed text previews multiple strategies and preserves manual price and original time',async({page})=>{
  const {reviewedPasteHeader}=await import('../../public/reviewed-paste.js');
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();await expect(page).toHaveURL(/\/app(?:\.html)?$/);
  const strategy='LOCAL-PASTE-'+crypto.randomUUID(),stamp=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,19);
  const text=reviewedPasteHeader+'\n'+[strategy,'300111.SZ','TEST',stamp,'83.95','用户手动提供','original time','-','-'].join('\t');
  const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});
  try{
    await page.locator('#import').click();await page.locator('#paste').fill(text);await page.locator('#preview-import').click();await expect(page.locator('#import-summary')).toContainText('核验文字共1条');await expect(page.locator('#import-preview')).toContainText('83.95');
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/import-reviewed')&&r.request().method()==='POST');await page.locator('#submit-import').click();expect((await saved).ok()).toBeTruthy();
    const rows=(await(await c.get('/api/records')).json()).records.filter(r=>r.strategy_name===strategy);expect(rows).toHaveLength(1);expect(rows[0].reference_price).toBe(83.95);expect(rows[0].actual_price).toBeNull();expect(rows[0].original_time).toBe('original time');
  }finally{
    for(const r of (await(await c.get('/api/records')).json()).records.filter(r=>r.strategy_name===strategy))await c.delete('/api/records/'+r.id,{data:{revision:r.revision}});await c.dispose();
  }
});
test('admin manages scoped read access; token reads records but cannot mutate or authenticate as admin',async({page,request})=>{
  expect((await request.get('/api/readonly/records')).status()).toBe(401);
  expect((await request.get('/api/readonly/records?token=unused')).status()).toBe(401);
  const viewer=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});await viewer.post('/api/login',{data:{username:'viewer',password:'local-test-viewer-only'}});expect((await viewer.post('/api/read-access',{data:{}})).status()).toBe(403);await viewer.dispose();
  await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill('local-test-admin-only');await page.getByRole('button',{name:'登录研究室'}).click();await expect(page).toHaveURL(/\/app(?:\.html)?$/);
  await page.getByRole('button',{name:'数据与设置'}).click();await page.locator('#create-read-token').click();await expect(page.locator('#read-token')).toHaveValue(/^read_[a-f0-9]{64}$/);
  const token=await page.locator('#read-token').inputValue(),scoped={'X-Tracker-Read-Token':token};
  try{
    const records=await request.get('/api/readonly/records',{headers:scoped});expect(records.status()).toBe(200);expect(records.headers()['cache-control']).toBe('no-store');expect(Array.isArray((await records.json()).records)).toBe(true);
    expect((await request.get('/api/readonly/close-sync',{headers:scoped})).status()).toBe(200);
    expect((await request.post('/api/readonly/records',{headers:scoped,data:{}})).status()).toBe(405);
    expect((await request.post('/api/records',{headers:{...scoped,Origin:origin},data:{}})).status()).toBe(401);
    expect((await request.get('/api/me',{headers:scoped})).status()).toBe(401);
    const rotation=page.waitForResponse(r=>r.url().endsWith('/api/read-access')&&r.request().method()==='POST');await page.locator('#create-read-token').click();await rotation;
    expect((await request.get('/api/readonly/records',{headers:scoped})).status()).toBe(401);
    const newToken=await page.locator('#read-token').inputValue();expect((await request.get('/api/readonly/records',{headers:{'X-Tracker-Read-Token':newToken}})).status()).toBe(200);
    const revocation=page.waitForResponse(r=>r.url().endsWith('/api/read-access')&&r.request().method()==='DELETE');await page.locator('#revoke-read-token').click();await revocation;
    expect((await request.get('/api/readonly/records',{headers:{'X-Tracker-Read-Token':newToken}})).status()).toBe(401);await expect(page.locator('#read-token-result')).toBeHidden();
  }finally{await page.locator('#revoke-read-token').click();}
});
test('Codex password header uses normal admin login, Origin checks and sessions',async({request})=>{
  const loginHeaders={Origin:origin,'X-Tracker-Admin-Password':'local-test-admin-only'};
  expect((await request.post('/api/login',{headers:{...loginHeaders,Origin:'https://untrusted.invalid'},data:{username:'admin'}})).status()).toBe(403);
  expect((await request.post('/api/login',{headers:loginHeaders,data:{username:'viewer'}})).status()).toBe(401);
  expect((await request.post('/api/login',{headers:{...loginHeaders,'X-Tracker-Admin-Password':'wrong-test-password'},data:{username:'admin'}})).status()).toBe(401);
  const login=await request.post('/api/login',{headers:loginHeaders,data:{username:'admin'}});expect(login.status()).toBe(200);expect((await login.json()).role).toBe('admin');
  expect((await request.get('/api/records')).status()).toBe(200);
  try{
    const request_id=crypto.randomUUID(),stamp=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,19);
    expect((await request.post('/api/records',{headers,data:{request_id,rows:[{strategy_id:'twenty-minute',symbol:'300111.SZ',buy_time:stamp,notes:'LOCAL-ADMIN-'+request_id}]}})).status()).toBe(201);
    const row=(await(await request.get('/api/records')).json()).records.find(r=>r.notes==='LOCAL-ADMIN-'+request_id);expect(row).toBeTruthy();
    expect((await request.patch('/api/records/'+row.id,{headers,data:{revision:row.revision,notes:'LOCAL-ADMIN-'+request_id+'-edited'}})).status()).toBe(200);
    expect((await request.delete('/api/records/'+row.id,{headers,data:{revision:row.revision+1}})).status()).toBe(200);
  }finally{await request.post('/api/logout',{headers,data:{}});}
  expect((await request.get('/api/records')).status()).toBe(401);
});
test('only empty strategies can be deleted; analysis rules clean up and records remain protected',async()=>{
 const c=await makeRequest.newContext({baseURL:origin,extraHTTPHeaders:headers});await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}});
 const name='LOCAL-DELETE-'+crypto.randomUUID();await c.post('/api/strategies',{data:{name}});const strategy=(await(await c.get('/api/strategies')).json()).find(s=>s.name===name);
 let record;
 try{
  await c.patch('/api/strategies/'+strategy.id+'/analysis-rule',{data:{revision:0,rule:{first_n:10,before_time:null}}});
  const stamp=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,19);await c.post('/api/records',{data:{request_id:crypto.randomUUID(),rows:[{strategy_id:strategy.id,symbol:'300111.SZ',buy_time:stamp}]}});
  record=(await(await c.get('/api/records')).json()).records.find(r=>r.strategy_id===strategy.id);expect(record).toBeTruthy();
  expect((await c.delete('/api/strategies/'+strategy.id,{data:{}})).status()).toBe(409);expect((await c.get('/api/records/'+record.id)).status()).toBe(200);
  await c.delete('/api/records/'+record.id,{data:{revision:record.revision}});record=null;
  expect((await c.delete('/api/strategies/'+strategy.id,{data:{}})).status()).toBe(200);expect((await(await c.get('/api/strategies')).json()).some(s=>s.id===strategy.id)).toBe(false);
  expect((await c.delete('/api/strategies/'+strategy.id,{data:{}})).status()).toBe(404);
 }finally{if(record)await c.delete('/api/records/'+record.id,{data:{revision:record.revision}});await c.delete('/api/strategies/'+strategy.id,{data:{}});await c.dispose();}
});

import {test, expect, type Page, type APIRequestContext} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const origin='http://127.0.0.1:8787';
const headers={Origin:origin};
const columns='time,open,high,low,close,volume,status,reason';
const validRow={time:'2026-10-20T09:30:00-04:00',open:10,high:12,low:9,close:11,volume:100,status:'available',reason:''};
const dataset=(provider:string)=>({symbol:'AMD.US',period:'1m',provider,adjustment:'none',adjustment_as_of:null,time_zone:'America/New_York',currency:'USD'});
const provider=()=>`LOCAL-VERIFICATION-${crypto.randomUUID()}`;
async function login(page:Page, role='admin') {
  expect((await page.request.post('/api/login',{headers,data:{username:role,password:`local-test-${role==='admin'?'admin':'viewer'}-only`}})).ok()).toBeTruthy();
  await page.goto('/market-data.html');
}
async function save(request:APIRequestContext,payload:any) {
  const preview=await(await request.post('/api/research-data/preview',{headers,data:payload})).json();
  expect(preview.valid).toBeTruthy();
  const result=await request.post('/api/research-data/import',{headers,data:{...payload,preview_token:preview.preview_token,expected_revision:preview.revision,request_id:crypto.randomUUID()}});
  expect(result.ok()).toBeTruthy();return result.json();
}

test('research data stays inaccessible to unauthenticated users and viewers',async({page,request})=>{
  expect((await request.get('/market-data.html',{maxRedirects:0})).status()).toBe(302);
  expect((await request.get('/api/research-data/datasets')).status()).toBe(401);
  await login(page,'viewer');
  await expect(page.locator('body')).toContainText('仅管理员');
  for(const path of ['/datasets','/bars?dataset_id=invalid','/export?dataset_id=invalid'])expect((await page.request.get('/api/research-data'+path)).status()).toBe(403);
  expect((await page.request.post('/api/research-data/preview',{headers,data:{}})).status()).toBe(403);
});

test('CSV preview is read-only, missing stays empty, import persists and range export round-trips',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await login(page);
  const source=provider(),note='Synthetic browser test data, not real market quotes.';
  await page.locator('#market-provider').fill(source);await page.locator('#market-source-note').fill(note);
  const csv=columns+'\r\n2026-10-20T09:30:00-04:00,10,12,9,11,100,available,\r\n2026-10-20T09:31:00-04:00,,,,,,missing,"test ""quoted"" reason\n<img src=x onerror=alert(1)>"';
  await page.locator('#market-paste').fill(csv);await page.locator('#market-preview').click();
  await expect(page.locator('#market-preview-summary')).toContainText('新增 2');await expect(page.locator('#market-commit')).toBeEnabled();
  const before=await(await page.request.get('/api/research-data/datasets')).json();expect(before.datasets.some((d:any)=>d.provider===source)).toBe(false);
  const missing=page.locator('#market-preview-table tbody tr').nth(1);await expect(missing.locator('td').nth(1)).toHaveText('—');await expect(missing).toContainText('test "quoted" reason');expect(await missing.locator('img').count()).toBe(0);
  await page.locator('#market-source-note').fill(note+' ');await expect(page.locator('#market-preview-section')).toBeHidden();
  await page.locator('#market-preview').click();await expect(page.locator('#market-commit')).toBeEnabled();await page.locator('#market-commit').click();
  await expect(page.locator('#market-import-message')).toContainText('导入已保存');await expect(page.locator('#market-bars-table tbody tr')).toHaveCount(2);
  await page.reload();await expect(page.locator('#market-dataset')).toContainText(source);await page.locator('#market-query').click();
  await expect(page.locator('#market-bars-table tbody tr')).toHaveCount(2);await expect(page.locator('#market-bars-table tbody tr').nth(1).locator('td').nth(4)).toHaveText('—');
  await expect(page.locator('#market-bars-table tbody')).toContainText(note);
  await page.locator('#market-browse-start').fill('2026-10-20');await page.locator('#market-browse-end').fill('2026-10-20');
  const exporting=page.waitForRequest(request=>request.url().includes('/api/research-data/export?'));const downloaded=page.waitForEvent('download');await page.locator('#market-export').click();
  const exportRequest=await exporting;expect(new URL(exportRequest.url()).searchParams.get('start')).toBe('2026-10-20');expect(new URL(exportRequest.url()).searchParams.get('end')).toBe('2026-10-20');
  const download=await downloaded,contents=await readFile((await download.path())!,'utf8');expect(contents).toContain('source_note');expect(contents).toContain('AMD.US');
  await expect(page.locator('#market-symbol option')).toHaveCount(1);await page.locator('#market-period').selectOption('1d');await page.locator('#market-paste').fill(contents);await page.locator('#market-preview').click();
  await expect(page.locator('#market-preview-summary')).toContainText('相同 2');await expect(page.locator('#market-symbol')).toHaveValue('AMD.US');await expect(page.locator('#market-period')).toHaveValue('1m');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:'/workspace/scratch/manual-market-mobile.png',fullPage:true});
  await page.locator('#market-theme').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(errors).toEqual([]);
});

test('conflicts require explicit replacement, stale preview is rejected and missing cannot overwrite prices',async({page})=>{
  await login(page);const source=provider(),base={dataset:dataset(source),source_note:'Synthetic conflict fixture.',rows:[validRow]};await save(page.request,base);
  const changed={...base,rows:[{...validRow,close:12}]};await page.locator('#market-paste').fill(JSON.stringify(changed));await page.locator('#market-preview').click();
  await expect(page.locator('#market-preview-summary')).toContainText('冲突 1');await expect(page.locator('#market-commit')).toBeDisabled();
  await expect(page.locator('#market-preview-table tbody tr').first().locator('td').nth(4)).toHaveText('11 → 12');await expect(page.locator('#market-preview-table tbody')).toContainText('原来源说明：Synthetic conflict fixture.');
  await page.locator('#market-replace').check();await expect(page.locator('#market-commit')).toBeDisabled();await page.locator('#market-replace-reason').fill('Synthetic corrected fixture.');await expect(page.locator('#market-commit')).toBeEnabled();
  await save(page.request,{...base,rows:[{...validRow,time:'2026-10-20T09:32:00-04:00'}]});
  await page.locator('#market-commit').click();await expect(page.locator('#market-import-message')).toContainText('重新预览');await expect(page.locator('#market-preview-section')).toBeHidden();
  await page.locator('#market-preview').click();await expect(page.locator('#market-preview-summary')).toContainText('冲突 1');await page.locator('#market-replace').check();await page.locator('#market-replace-reason').fill('Synthetic corrected fixture.');await page.locator('#market-commit').click();
  await expect(page.locator('#market-import-message')).toContainText('导入已保存');await expect(page.locator('#market-bars-table tbody tr').first().locator('td').nth(4)).toHaveText('12');
  await page.locator('#market-paste').fill(JSON.stringify({...base,rows:[{time:validRow.time,status:'missing',reason:'Synthetic missing fixture.'}]}));await page.locator('#market-preview').click();
  await expect(page.locator('#market-preview-errors')).toContainText('禁止提交');await expect(page.locator('#market-commit')).toBeDisabled();
});

test('invalid metadata and oversized batches stay unsubmitted; pagination preserves known rows',async({page})=>{
  await login(page);const source=provider(),base={dataset:dataset(source),source_note:'Synthetic JSON fixture.',rows:[validRow]};
  await page.locator('#market-paste').fill(JSON.stringify({...base,dataset:{...base.dataset,currency:'CNY'}}));await page.locator('#market-preview').click();await expect(page.locator('#market-import-message')).toContainText('只接受 USD');
  await page.locator('#market-paste').fill(JSON.stringify({...base,dataset:{...base.dataset,adjustment:'forward',adjustment_as_of:null}}));await page.locator('#market-preview').click();await expect(page.locator('#market-import-message')).toContainText('复权截至日期');
  await page.locator('#market-paste').fill(JSON.stringify({...base,rows:Array(501).fill(validRow)}));await page.locator('#market-preview').click();await expect(page.locator('#market-import-message')).toContainText('1 至 500');
  const rows=Array.from({length:201},(_,i)=>({...validRow,time:new Date(Date.parse('2026-10-20T13:30:00Z')+i*60000).toISOString()}));
  await page.locator('#market-paste').fill(JSON.stringify({...base,rows}));await page.locator('#market-preview').click();await expect(page.locator('#market-preview-table tbody tr')).toHaveCount(201);await page.locator('#market-commit').click();
  await expect(page.locator('#market-page-info')).toContainText('第 1 页 · 本页 200 行');await page.locator('#market-next').click();await expect(page.locator('#market-page-info')).toContainText('第 2 页 · 本页 1 行');await expect(page.locator('#market-next')).toBeDisabled();
  await page.locator('#market-prev').click();await expect(page.locator('#market-page-info')).toContainText('第 1 页 · 本页 200 行');
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'/workspace/scratch/manual-market-desktop.png',fullPage:true});
});

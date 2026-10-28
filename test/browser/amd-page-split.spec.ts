import {test,expect} from '@playwright/test';
const headers={Origin:'http://127.0.0.1:8787'};
async function login(page:any,user='admin'){expect((await page.request.post('/api/login',{headers,data:{username:user,password:`local-test-${user}-only`}})).ok()).toBeTruthy();}

test('AMD is a read-only quote page; left navigation opens a separate strategy experiment page',async({page})=>{
 await login(page);const errors:string[]=[],calls:{url:string;method:string}[]=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))calls.push({url:r.url(),method:r.method()});});
 await page.goto('/backtest');await expect(page.locator('#research-content')).toBeVisible();await expect(page.getByRole('heading',{name:'AMD 研究',exact:true})).toBeVisible();
 await expect(page.locator('#bt-form')).toHaveCount(0);await expect(page.locator('#marker-table')).toHaveCount(0);await expect(page.locator('#marker-add')).toHaveCount(0);await expect(page.locator('script[src="/amd-backtest.js"]')).toHaveCount(0);
 await expect(page.locator('nav a[href="/backtest"]')).toHaveAttribute('aria-current','page');await expect(page.locator('nav a[href="/amd-strategies"]')).toHaveText('候选策略实验');
 await expect(page.locator('#research-chart canvas').first()).toBeVisible();await expect(page.locator('#research-chart-status')).toContainText('已载入所选范围');await page.locator('[data-timeframe="5m"]').click();await expect(page.locator('[data-timeframe="5m"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#research-chart-status')).toContainText('已载入所选范围');await page.locator('#research-timezone').selectOption('Asia/Shanghai');await expect(page.locator('#research-zone-label')).toContainText('北京时间');
 await page.locator('#research-chart').click({position:{x:150,y:100}});await expect(page.locator('dialog')).toHaveCount(0);expect(calls.some(r=>r.method!=='GET')).toBeFalsy();expect(calls.some(r=>/backtests|markers|groups/.test(r.url))).toBeFalsy();
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.locator('nav a[href="/amd-strategies"]').click();await expect(page).toHaveURL(/\/amd-strategies$/);await expect(page.locator('#research-content')).toBeVisible();await expect(page.locator('#bt-form')).toBeVisible();await expect(page.locator('#bt-params')).not.toHaveValue('');await expect(page.locator('#research-chart')).toHaveCount(0);await expect(page.locator('nav a[href="/amd-strategies"]')).toHaveAttribute('aria-current','page');
 await page.locator('#bt-theme').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.locator('nav a[href="/backtest"]').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.locator('#bt-form')).toHaveCount(0);
 await page.setViewportSize({width:1440,height:1000});await expect(page.locator('#research-chart-status')).toContainText('已载入所选范围');await page.screenshot({path:'/workspace/scratch/amd-quotes-split.png',fullPage:true});
 expect(errors).toEqual([]);
});

test('all standalone page spellings retain the existing admin gate and chart CSP',async({page,request})=>{
 const paths=['/amd-strategies','/amd-strategies.html','/amd-strategies/','/amd-quotes','/amd-quotes.html','/amd-quotes/'];
 for(const path of paths)expect((await request.get(path,{maxRedirects:0})).status()).toBe(302);
 await login(page,'viewer');for(const path of paths)expect((await page.request.get(path,{maxRedirects:0})).status()).toBe(403);
 await login(page);for(const path of paths){const r=await page.request.get(path);expect(r.ok()).toBeTruthy();expect(r.headers()['content-security-policy']).toContain('sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=');}
});

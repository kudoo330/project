import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
const headers={Origin:'http://127.0.0.1:8787'};
async function login(page:any,user='admin'){expect((await page.request.post('/api/login',{headers,data:{username:user,password:`local-test-${user}-only`}})).ok()).toBeTruthy();}

test('admin can download a private quote package; anonymous/viewer and unsafe writes are denied',async({page,request})=>{
 const path='/api/research-downloads';expect((await request.get(path)).status()).toBe(401);
 await login(page,'viewer');expect((await page.request.get(path)).status()).toBe(403);
 await login(page);
 const bytes=Buffer.from([0x50,0x4b,3,4,10,20,30,40]);
 const data={filename:'synthetic-browser-market.zip',title:'Synthetic browser download fixture',sha256:createHash('sha256').update(bytes).digest('hex'),data_base64:bytes.toString('base64')};
 expect((await page.request.post(path,{headers:{Origin:'https://other.test'},data})).status()).toBe(403);
 expect((await page.request.post(path,{headers:{...headers,'Content-Type':'text/plain'},data:JSON.stringify(data)})).status()).toBe(415);
 const saved=await page.request.post(path,{headers,data});expect(saved.ok()).toBeTruthy();const file=(await saved.json()).file;
 expect((await request.get(file.url)).status()).toBe(401);
 await page.goto('/backtest');await expect(page.locator('#research-content')).toBeVisible();
 await page.locator('#research-downloads-title').click();await page.getByText('已准备的完整行情包',{exact:true}).click();
 const link=page.locator('#research-downloads a').filter({hasText:data.title});await expect(link).toBeVisible();
 const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);expect(download.suggestedFilename()).toBe(data.filename);expect(await download.failure()).toBeNull();
 const response=await page.request.get(file.url);expect(response.ok()).toBeTruthy();expect(await response.body()).toEqual(bytes);
 await login(page,'viewer');expect((await page.request.get(file.url)).status()).toBe(403);
});

import {test,expect,request} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pbkdf2Sync} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import calendar from '../../src/calendar.json' with {type:'json'};
test('cash confirmation is admin-only, audited through revision, and preserves original quotes',async()=>{
  const now=new Date(),local=new Date(now.getTime()+8*3600000).toISOString().slice(0,19);
  const asOf=local.slice(11)>='16:05:00'?local.slice(0,10):new Date(now.getTime()+8*3600000-86400000).toISOString().slice(0,10);
  const days=calendar.filter(day=>day<=asOf).slice(-3),[buyDay,priorDay,exDay]=days;
  const end=calendar[calendar.indexOf(buyDay)+10];
  test.skip(days.length!==3||!end||local.slice(0,10)>end,'The test requires three completed sessions inside the supported observation calendar');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const salt='1234567890abcdef1234567890abcdef';
  const hash=(password:string)=>'pbkdf2$100000$'+salt+'$'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex');
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-16',d1Databases:{DB:'isolated-cash-dividend-fixture'},bindings:{ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash('local-test-admin-only'),VIEWER_USERNAME:'viewer',VIEWER_PASSWORD_HASH:hash('local-test-viewer-only')}}));
  const origin=(await mf.ready).origin;
  const c=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
  const viewer=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
  let record:any;
  try{
    const db=await mf.getD1Database('DB');
    const schema=await readFile(new URL('../../migrations/0001_initial.sql',import.meta.url),'utf8');
    await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
    expect((await c.post('/api/confirm-dividend',{data:{}})).status()).toBe(401);
    await viewer.post('/api/login',{data:{username:'viewer',password:'local-test-viewer-only'}});
    expect((await viewer.post('/api/confirm-dividend',{data:{}})).status()).toBe(403);
    expect((await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}})).ok()).toBeTruthy();
    expect((await c.post('/api/confirm-dividend',{headers:{Origin:'https://invalid.test'},data:{}})).status()).toBe(403);
    const notes='LOCAL-CASH-DIVIDEND-'+crypto.randomUUID(),recordId=crypto.randomUUID(),batchId=crypto.randomUUID();
    const buyTime=buyDay+'T10:00:00';
    // Three completed sessions may exceed the normal two-calendar-day entry
    // window. Seed only this isolated D1; production input rules stay enforced.
    await db.batch([
      db.prepare('INSERT INTO batches(id,created_by,created_at,input_hash) VALUES(?,?,?,?)').bind(batchId,'local-test',now.toISOString(),notes),
      db.prepare('INSERT INTO records(id,batch_id,strategy_id,symbol,buy_time,original_time,actual_price,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(recordId,batchId,'unclassified','000999.SZ',buyTime,buyTime,39,notes,now.toISOString(),now.toISOString()),
    ]);
    record=await(await c.get('/api/records/'+recordId)).json();
    const bars=[[buyDay,40],[priorDay,30],[exDay,31]].map(([date,close])=>({date,open:close,close,high:close,low:close,volume:100}));
    const fetchedAt=new Date().toISOString();
    const quote={symbol:record.symbol,bars,secondary:bars,secondaryProvider:'腾讯',fetchedAt,evidence:{source:'LOCAL SYNTHETIC TEST ONLY'},corporateSource:{status:'available',factors:[{date:buyDay,factor:1},{date:exDay,factor:30/29.7}],qfq:bars.map((b:any)=>({...b,close:b.date<exDay?b.close-.3:b.close})),fetchedAt}};
    // Keep synthetic OHLC valid after adjusting each qfq close.
    quote.corporateSource.qfq=quote.corporateSource.qfq.map((b:any)=>({...b,open:b.close,high:b.close,low:b.close}));
    const imported=await c.post('/api/import-closes',{data:{quotes:[quote]}});expect(imported.ok()).toBeTruthy();
    record=await(await c.get('/api/records/'+record.id)).json();
    expect(JSON.parse(record.market_data).adjustment.status).toBe('pending');
    const body={record_id:record.id,revision:record.revision,date:exDay,cash_per_10:3,reason:'LOCAL TEST confirmed cash distribution'};
    expect((await c.post('/api/confirm-dividend',{data:{...body,cash_per_10:4}})).status()).toBe(400);
    expect((await(await c.get('/api/records/'+record.id)).json()).market_data).toBe(record.market_data);
    const response=await c.post('/api/confirm-dividend',{data:body});expect(response.ok()).toBeTruthy();
    const saved=await(await c.get('/api/records/'+record.id)).json();
    const data=JSON.parse(saved.market_data),old=JSON.parse(record.market_data);
    expect(saved.revision).toBe(record.revision+1);expect(saved.actual_price).toBe(39);
    expect(data.bars).toEqual(old.bars);expect(data.adjustment_source).toEqual(old.adjustment_source);
    expect(data.adjustment.verification).toBe('admin-cash-dividend');expect(data.adjustment_history.at(-1)).toEqual(old.adjustment);
    expect(data.confirmed_cash_dividends[exDay].confirmedBy).toBe('admin');
    expect(saved.tracking.window[2].value).toBeCloseTo((31/38.61-1)*100,6);
    record=saved;
    expect((await c.post('/api/confirm-dividend',{data:body})).ok()).toBeFalsy();
  }finally{
    await c.dispose();await viewer.dispose();await mf.dispose();
  }
});

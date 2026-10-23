import {test,expect,request} from '@playwright/test';
const origin='http://127.0.0.1:8787';
test('cash confirmation is admin-only, audited through revision, and preserves original quotes',async()=>{
  const c=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
  const viewer=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
  let record:any;
  try{
    expect((await c.post('/api/confirm-dividend',{data:{}})).status()).toBe(401);
    await viewer.post('/api/login',{data:{username:'viewer',password:'local-test-viewer-only'}});
    expect((await viewer.post('/api/confirm-dividend',{data:{}})).status()).toBe(403);
    expect((await c.post('/api/login',{data:{username:'admin',password:'local-test-admin-only'}})).ok()).toBeTruthy();
    expect((await c.post('/api/confirm-dividend',{headers:{Origin:'https://invalid.test'},data:{}})).status()).toBe(403);
    const notes='LOCAL-CASH-DIVIDEND-'+crypto.randomUUID();
    const buyTime='2026-10-21T10:00:00';
    expect((await c.post('/api/import-reviewed',{data:{request_id:crypto.randomUUID(),rows:[{strategy:'LOCAL-CASH-DIVIDEND',symbol:'000999.SZ',buy_time:buyTime,notes}]}})).ok()).toBeTruthy();
    record=(await(await c.get('/api/records')).json()).records.find((r:any)=>r.notes===notes);
    expect((await c.patch('/api/records/'+record.id,{data:{revision:record.revision,actual_price:39}})).ok()).toBeTruthy();
    const bars=[['2026-10-21',40],['2026-10-22',30],['2026-10-23',31]].map(([date,close])=>({date,open:close,close,high:close,low:close,volume:100}));
    const fetchedAt=new Date().toISOString();
    const quote={symbol:record.symbol,bars,secondary:bars,secondaryProvider:'腾讯',fetchedAt,evidence:{source:'LOCAL SYNTHETIC TEST ONLY'},corporateSource:{status:'available',factors:[{date:'2026-01-01',factor:1},{date:'2026-10-23',factor:30/29.7}],qfq:bars.map((b:any)=>({...b,close:b.date<'2026-10-23'?b.close-.3:b.close})),fetchedAt}};
    // Keep synthetic OHLC valid after adjusting each qfq close.
    quote.corporateSource.qfq=quote.corporateSource.qfq.map((b:any)=>({...b,open:b.close,high:b.close,low:b.close}));
    const imported=await c.post('/api/import-closes',{data:{quotes:[quote]}});expect(imported.ok()).toBeTruthy();
    record=await(await c.get('/api/records/'+record.id)).json();
    expect(JSON.parse(record.market_data).adjustment.status).toBe('pending');
    const body={record_id:record.id,revision:record.revision,date:'2026-10-23',cash_per_10:3,reason:'LOCAL TEST confirmed cash distribution'};
    expect((await c.post('/api/confirm-dividend',{data:{...body,cash_per_10:4}})).status()).toBe(400);
    expect((await(await c.get('/api/records/'+record.id)).json()).market_data).toBe(record.market_data);
    const response=await c.post('/api/confirm-dividend',{data:body});expect(response.ok()).toBeTruthy();
    const saved=await(await c.get('/api/records/'+record.id)).json();
    const data=JSON.parse(saved.market_data),old=JSON.parse(record.market_data);
    expect(saved.revision).toBe(record.revision+1);expect(saved.actual_price).toBe(39);
    expect(data.bars).toEqual(old.bars);expect(data.adjustment_source).toEqual(old.adjustment_source);
    expect(data.adjustment.verification).toBe('admin-cash-dividend');expect(data.adjustment_history.at(-1)).toEqual(old.adjustment);
    expect(data.confirmed_cash_dividends['2026-10-23'].confirmedBy).toBe('admin');
    expect(saved.tracking.window[2].value).toBeCloseTo((31/38.61-1)*100,6);
    record=saved;
    expect((await c.post('/api/confirm-dividend',{data:body})).ok()).toBeFalsy();
  }finally{
    if(record){const latest=await(await c.get('/api/records/'+record.id)).json();await c.delete('/api/records/'+record.id,{data:{revision:latest.revision}});await c.delete('/api/strategies/'+record.strategy_id,{data:{}});}
    await c.dispose();await viewer.dispose();
  }
});

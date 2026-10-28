import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {researchDataApi} from '../src/research-data';

test('research D1 preview, atomic import, conflict replacement, fill, audit and replay',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'research-api-test'}}));
  try {
    const db=await mf.getD1Database('DB');
    const schema=await readFile(new URL('../migrations/0005_research_data.sql',import.meta.url),'utf8');
    await db.batch(schema.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    const call=async(path:string,value?:any)=>{
      const url=new URL('https://research.test/api/research-data'+path);
      return researchDataApi(new Request(url,{method:value?'POST':'GET',...(value?{headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})}),{DB:db} as any,url,'admin:test');
    };
    const preview=async(value:any)=>{
      const response=await call('/preview',value);assert.equal(response.status,200);
      const body:any=await response.json();assert.equal(body.valid,true,JSON.stringify(body));return body;
    };
    const importBody=(value:any,p:any,request_id:string,extra:any={})=>({...value,preview_token:p.preview_token,expected_revision:p.revision,request_id,replace_conflicts:false,replace_reason:'',...extra});
    const dataset={symbol:'AMD.US',period:'1m',provider:'Administrator CSV',adjustment:'none',time_zone:'America/New_York',currency:'USD'};
    const input={dataset,source_note:'Independent source not verified; manual fixture',rows:[
      {time:'2020-01-06T14:30:00Z',open:'100.00',high:102,low:99,close:101,volume:0},
      {time:'2020-01-06T14:31:00Z',status:'not_entitled',reason:'Historical quote entitlement unavailable'},
    ]};
    const p=await preview(input);
    assert.equal(p.counts.insert,2);assert.equal(p.counts.missing,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_datasets').first<any>())!.n,0,'preview must not create datasets');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_import_batches').first<any>())!.n,0);
    const firstBody=importBody(input,p,'request_00000000001');
    const first=await call('/import',firstBody);assert.equal(first.status,201,await first.clone().text());
    const replay:any=await (await call('/import',firstBody)).json();assert.equal(replay.replayed,true);
    assert.equal((await call('/import',{...firstBody,source_note:'different content'})).status,409);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_import_batches').first<any>())!.n,1);
    const saved=(await db.prepare('SELECT * FROM research_market_bars ORDER BY time_key').all<any>()).results;
    assert.equal(saved[0].open,100);assert.equal(saved[0].volume,0);assert.equal(saved[0].verification,'unverified');
    assert.deepEqual([saved[1].open,saved[1].high,saved[1].low,saved[1].close,saved[1].volume],[null,null,null,null,null]);
    assert.equal(JSON.parse(saved[0].original_values_json).open,'100.00');

    const fill={...input,rows:[{...input.rows[0],time:'2020-01-06T14:31:00Z'}]};
    const fillPreview=await preview(fill);assert.equal(fillPreview.counts.fill,1);
    const concurrentPreview=await preview({...input,rows:[{...input.rows[0],close:100.5}]});
    const fillResult=await call('/import',importBody(fill,fillPreview,'request_00000000002'));assert.equal(fillResult.status,201,await fillResult.clone().text());
    const stale=await call('/import',importBody({...input,rows:[{...input.rows[0],close:100.5}]},concurrentPreview,'request_00000000003',{replace_conflicts:true,replace_reason:'Manual check'}));assert.equal(stale.status,409);
    assert.equal((await stale.json() as any).code,'stale_preview');

    const conflicting={...input,rows:[{...input.rows[0],close:100.5},{...input.rows[0],time:'2020-01-06T14:32:00Z'}]};
    const cp=await preview(conflicting);assert.equal(cp.counts.conflict,1);assert.equal(cp.counts.insert,1);
    assert.equal(cp.rows[0].previous_value.close,101);assert.equal(cp.rows[0].previous_value.source_note,input.source_note);
    assert.equal((await call('/import',importBody(conflicting,cp,'request_00000000004'))).status,409);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_bars').first<any>())!.n,2,'conflict refuses the entire batch');
    assert.equal((await call('/import',importBody(conflicting,cp,'request_00000000005',{replace_conflicts:true}))).status,400);
    const replaced=await call('/import',importBody(conflicting,cp,'request_00000000006',{replace_conflicts:true,replace_reason:'Verified against corrected provider export'}));
    assert.equal(replaced.status,201,await replaced.clone().text());
    const audit=(await db.prepare("SELECT * FROM research_market_bar_revisions WHERE action='conflict'").first<any>())!;
    assert.equal(JSON.parse(audit.previous_value).close,101);assert.equal(JSON.parse(audit.new_value).close,100.5);
    assert.equal(audit.actor,'admin:test');assert.equal(audit.replacement_reason,'Verified against corrected provider export');
    const nowMissing={...input,rows:[{time:input.rows[0].time,status:'missing',reason:'new request failed'}]};
    const mp=await preview(nowMissing);assert.equal(mp.counts.blocked,1);
    assert.equal((await call('/import',importBody(nowMissing,mp,'request_00000000007',{replace_conflicts:true,replace_reason:'Still may not erase valid data'}))).status,409);

    // The database itself rejects NULL available prices even outside the API.
    await assert.rejects(()=>db.prepare("UPDATE research_market_bars SET open=NULL WHERE status='available'").run());
    const page:any=await (await call(`/bars?dataset_id=${p.dataset_id}&start=2020-01-06&end=2020-01-06&limit=2`)).json();
    assert.equal(page.bars.length,2);assert.ok(page.next_cursor);assert.equal(page.counts.available,3);
    const next:any=await (await call(`/bars?dataset_id=${p.dataset_id}&cursor=${encodeURIComponent(page.next_cursor)}`)).json();assert.equal(next.bars.length,1);
    assert.equal(next.bars[0].source_note,input.source_note);
    const csv=await (await call(`/export?dataset_id=${p.dataset_id}`)).text();
    assert.match(csv,/symbol,period,provider,adjustment,adjustment_as_of,time_zone,currency,source_note,verification/);
    assert.match(csv,/"AMD.US","1m"/);

    // 500 rows use a fixed five-statement transaction rather than per-row SQL.
    const large={...input,dataset:{...dataset,symbol:'AMDL.US'},rows:Array.from({length:500},(_,i)=>({...input.rows[0],time:new Date(Date.parse('2020-01-07T14:30:00Z')+i*60000).toISOString()}))};
    const largePreview=await preview(large);assert.equal(largePreview.counts.insert,500);
    const largeResult=await call('/import',importBody(large,largePreview,'request_00000000008'));assert.equal(largeResult.status,201,await largeResult.clone().text());
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_bars WHERE dataset_id=?').bind(largePreview.dataset_id).first<any>())!.n,500);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_bar_revisions WHERE dataset_id=?').bind(largePreview.dataset_id).first<any>())!.n,500);

    const verbose={...large,dataset:{...large.dataset,provider:'Large audit fixture'},source_note:'来源'.repeat(1000)};
    const verbosePreview=await preview(verbose);
    assert.equal((await call('/import',importBody(verbose,verbosePreview,'request_00000000013'))).status,201);
    const verboseChanges={...verbose,rows:verbose.rows.map(row=>({...row,close:100.5}))}, verboseChangedPreview=await preview(verboseChanges);
    const oversizedAudit=await call('/import',importBody(verboseChanges,verboseChangedPreview,'request_00000000014',{replace_conflicts:true,replace_reason:'Corrected export'}));
    assert.equal(oversizedAudit.status,400);assert.match(await oversizedAudit.text(),/本批修订记录过大/);
    assert.equal((await db.prepare('SELECT revision FROM research_market_datasets WHERE id=?').bind(verbosePreview.dataset_id).first<any>())!.revision,1);

    const sameRequest={...input,dataset:{...dataset,provider:'Concurrent replay'},rows:[input.rows[0]]};
    const samePreview=await preview(sameRequest), sameBody=importBody(sameRequest,samePreview,'request_00000000009');
    const sameResponses=await Promise.all([call('/import',sameBody),call('/import',sameBody)]);
    assert.ok(sameResponses.every(response=>response.status===200||response.status===201));
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_import_batches WHERE id=?').bind(sameBody.request_id).first<any>())!.n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_bar_revisions WHERE dataset_id=?').bind(samePreview.dataset_id).first<any>())!.n,1);
    const contenders={...input,dataset:{...dataset,provider:'Concurrent distinct requests'},rows:[input.rows[0]]};
    const contenderPreview=await preview(contenders);
    const competition=await Promise.all([
      call('/import',importBody(contenders,contenderPreview,'request_00000000010')),
      call('/import',importBody(contenders,contenderPreview,'request_00000000011')),
    ]);
    assert.deepEqual(competition.map(response=>response.status).sort(),[201,409]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_import_batches WHERE dataset_id=?').bind(contenderPreview.dataset_id).first<any>())!.n,1);

    // Force an error in the final bar write; earlier dataset, batch and audit
    // writes must all roll back as part of the same D1 transaction.
    await db.prepare("CREATE TRIGGER research_test_failure BEFORE INSERT ON research_market_bars WHEN NEW.close=105 BEGIN SELECT RAISE(ABORT,'injected write failure'); END").run();
    const failure={...input,dataset:{...dataset,provider:'Rollback fixture'},rows:[{...input.rows[0],high:110,close:105}]};
    const failurePreview=await preview(failure);
    assert.equal((await call('/import',importBody(failure,failurePreview,'request_00000000012'))).status,503);
    for(const table of ['research_market_import_batches','research_market_bar_revisions','research_market_bars']) {
      assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE dataset_id=?`).bind(failurePreview.dataset_id).first<any>())!.n,0);
    }
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_market_datasets WHERE id=?').bind(failurePreview.dataset_id).first<any>())!.n,0);
    await db.prepare('DROP TRIGGER research_test_failure').run();

    // Populate an oversized fixture to verify exports never silently truncate.
    await db.prepare(`WITH RECURSIVE nums(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM nums WHERE n<5000)
      INSERT INTO research_market_bars(dataset_id,time_key,original_time,trading_date,session,open,high,low,close,volume,status,reason,original_values_json,source_note,revision,import_batch_id,updated_at)
      SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','2019-01-01','+'||n||' minutes'),'fixture','2019-01-01','regular',1,1,1,1,NULL,'available','','{}','export bound fixture',1,?,? FROM nums`).bind(largePreview.dataset_id,'request_00000000008',new Date().toISOString()).run();
    const tooLarge=await call(`/export?dataset_id=${largePreview.dataset_id}`);assert.equal(tooLarge.status,413);assert.match(await tooLarge.text(),/超过5000行/);
    assert.equal((await call(`/export?dataset_id=${largePreview.dataset_id}&start=2020-01-07&end=2020-01-07`)).status,200);
  } finally {await mf.dispose();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {normalizeMarkerTime,researchMarkersApi} from '../src/research-markers';
import {researchDataApi} from '../src/research-data';

test('marker timestamps preserve seconds and reject naive, invalid and wrong DST wall times',()=>{
  assert.equal(normalizeMarkerTime('2020-01-06T09:30:59.123-05:00'),'2020-01-06T14:30:59.123Z');
  assert.equal(normalizeMarkerTime('2020-07-06T09:30:59-04:00'),'2020-07-06T13:30:59.000Z');
  assert.equal(normalizeMarkerTime('2020-07-06T21:30:59+08:00'),'2020-07-06T13:30:59.000Z');
  for(const time of ['2020-02-30T09:30:00Z','2020-07-06T09:30:59','2020-07-06T09:30:60Z','2020-07-06T09:30:59-05:00','2020-07-06T25:30:59Z'])assert.throws(()=>normalizeMarkerTime(time));
});

test('research marker D1 CRUD, pairs, references, import previews, audit, atomicity and persistence',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-16',d1Databases:{DB:'marker-api-test'}}));
  try{
    const db=await mf.getD1Database('DB');
    for(const migration of ['0005_research_data.sql','0006_research_markers.sql']){
      const sql=await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8');
      await db.batch(sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    const env={DB:db} as any;
    const call=async(path:string,body?:any,method=body?'POST':'GET')=>{const url=new URL('https://research.test/api/research'+path);return researchMarkersApi(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),env,url,'admin:fixture');};
    let counter=0,current=0;
    const metadata=()=>({request_id:'request_marker_'+String(++counter).padStart(8,'0'),expected_revision:current});
    const mutation=async(path:string,body:any,method='POST',status=200)=>{
      const response=await call(path,{...body,...metadata()},method);assert.equal(response.status,status,await response.clone().text());
      const json:any=await response.json();if(json.ok)current=json.revision;return json;
    };
    const first:any=await mutation('/groups',{name:'Research <one>'},'POST',201),group=first.group;
    assert.equal(first.revision,1);assert.equal(group.revision,1);assert.match(group.color,/^#[A-F0-9]{6}$/i);
    const colors:any=await (await call('/groups')).json();assert.equal(colors.groups[0].color,group.color);assert.equal(colors.revision,current);
    const other:any=await mutation('/groups',{name:'Other group',color:'#112233'},'POST',201);
    const row={group_id:group.id,symbol:'AMD.US',action:'BUY',time:'2020-01-06T09:30:59-05:00',price:null,source_type:'manual_hypothesis',notes:'Research only',status:'candidate',source_note:'Manual chart annotation',pair_id:null,reference:null};
    const created:any=await mutation('/markers',row,'POST',201),marker=created.marker;
    assert.equal(marker.time,'2020-01-06T14:30:59.000Z');assert.equal(marker.original_time,row.time);assert.equal(marker.price,null);assert.equal(marker.revision,1);
    const read:any=await (await call('/markers?symbol=AMD.US&start=2020-01-06&end=2020-01-06')).json();
    assert.equal(read.markers[0].id,marker.id);assert.equal(read.markers[0].price,null);assert.equal(read.markers[0].time_zone,'UTC');assert.equal(read.counts.dates,1);assert.equal(read.counts.buy,1);
    assert.equal((await call('/markers',{...row,source_type:'strategy_signal',...metadata()})).status,400);
    assert.equal((await call('/markers',{...row,price:0,...metadata()})).status,400);
    assert.equal((await call('/markers',{...row,price:true,...metadata()})).status,400);
    const edited=await mutation('/markers/'+marker.id,{notes:'=HYPERLINK("bad")',price:'101.25'},'PATCH');assert.equal(edited.marker.price,101.25);assert.equal(edited.marker.revision,2);
    const stale=await call('/markers/'+marker.id,{notes:'stale overwrite',request_id:'request_stale_marker',expected_revision:1},'PATCH');assert.equal(stale.status,409);
    await mutation('/markers/'+marker.id,{},'DELETE');
    assert.equal((await (await call('/markers')).json() as any).markers.length,0);
    assert.equal((await (await call('/markers?include_deleted=1')).json() as any).markers[0].deleted,true);
    await mutation('/markers/'+marker.id,{deleted:false},'PATCH');

    const sell=(await mutation('/markers',{...row,action:'SELL',time:'2020-01-06T14:35:00Z',price:102},'POST',201)).marker;
    const rebuy=(await mutation('/markers',{...row,action:'REBUY',time:'2020-01-06T14:40:00Z',price:100},'POST',201)).marker;
    const pair=await mutation('/markers/pair',{sell_id:sell.id,rebuy_id:rebuy.id});
    assert.equal(pair.markers.length,2);assert.equal(pair.markers[0].pair_id,pair.markers[1].pair_id);
    assert.equal((await (await call('/markers')).json() as any).counts.paired,1);
    assert.equal((await call('/markers/'+rebuy.id,{time:'2020-01-06T14:34:00Z',...metadata()},'PATCH')).status,400);
    assert.equal((await call('/markers/'+rebuy.id,{group_id:other.group.id,...metadata()},'PATCH')).status,400);
    await mutation('/markers/unpair',{pair_id:pair.markers[0].pair_id});
    assert.equal((await (await call('/markers')).json() as any).counts.paired,0);

    const previewInput={rows:[{...row,time:'2020-01-07T14:30:00Z',original_time:'2020-01-07T14:30:00Z'},{...row,action:'SELL',time:'2020-01-07T14:32:00Z'}]};
    const countBefore=(await db.prepare('SELECT COUNT(*) n FROM research_annotations').first<any>())!.n;
    const preview:any=await (await call('/markers/preview',previewInput)).json();assert.equal(preview.valid,true,JSON.stringify(preview));assert.equal(preview.counts.insert,2);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_annotations').first<any>())!.n,countBefore);
    const importBody={...previewInput,...metadata(),preview_token:preview.preview_token};
    const imported=await call('/markers/import',importBody);assert.equal(imported.status,200,await imported.clone().text());current=(await imported.json() as any).revision;
    const replay:any=await (await call('/markers/import',importBody)).json();assert.equal(replay.replayed,true);
    assert.equal((await call('/markers/import',{...importBody,replace_reason:'changed content'})).status,409);
    const again:any=await (await call('/markers/preview',previewInput)).json();assert.equal(again.counts.unchanged,2);
    const conflictInput={rows:[{...previewInput.rows[0],id:preview.rows[0].id,price:105}]};
    const conflict:any=await (await call('/markers/preview',conflictInput)).json();assert.equal(conflict.counts.conflict,1);assert.equal(conflict.rows[0].previous_value.price,null);
    assert.equal((await call('/markers/import',{...conflictInput,...metadata(),preview_token:conflict.preview_token})).status,409);
    await mutation('/markers/import',{...conflictInput,preview_token:conflict.preview_token,replace_conflicts:true,replace_reason:'User-supplied correction'});
    const duplicate:any=await (await call('/markers/preview',{rows:[row,row]})).json();assert.equal(duplicate.valid,false);
    const audit=(await db.prepare("SELECT * FROM research_annotation_audit WHERE reason='User-supplied correction'").first<any>())!;
    assert.equal(JSON.parse(audit.previous_json).price,null);assert.equal(JSON.parse(audit.new_json).price,105);assert.equal(audit.actor,'admin:fixture');

    // Reference metadata is a snapshot; it never fills the user price field.
    const market={dataset:{symbol:'AMD.US',period:'1m',provider:'Fixture reference',adjustment:'none',time_zone:'America/New_York',currency:'USD'},source_note:'Unverified fixture',rows:[{time:'2020-01-06T14:30:00Z',open:100,high:102,low:99,close:101,volume:50}]};
    const marketCall=async(path:string,body:any)=>{const url=new URL('https://research.test/api/research-data'+path);return researchDataApi(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,url,'admin:fixture');};
    const marketPreview:any=await (await marketCall('/preview',market)).json();
    assert.equal((await marketCall('/import',{...market,request_id:'market_reference_0001',preview_token:marketPreview.preview_token,expected_revision:0})).status,201);
    const reference={dataset_id:marketPreview.dataset_id,time:market.rows[0].time,bar_revision:1};
    const linked=(await mutation('/markers',{...row,reference},'POST',201)).marker;
    assert.equal(linked.price,null);assert.equal(linked.reference.snapshot.close,101);
    assert.equal((await call('/markers',{...row,symbol:'AMDL.US',reference,...metadata()})).status,400);
    assert.equal((await call('/markers',{...row,time:'2020-01-06T14:31:00Z',reference,...metadata()})).status,400);
    assert.equal((await call('/markers',{...row,reference:{...reference,bar_revision:2},...metadata()})).status,400);
    await db.prepare('UPDATE research_market_bars SET close=100,revision=2 WHERE dataset_id=?').bind(marketPreview.dataset_id).run();
    const afterMarketEdit=await mutation('/markers/'+linked.id,{notes:'Historical snapshot preserved'},'PATCH');assert.equal(afterMarketEdit.marker.reference.snapshot.close,101);
    assert.equal((await call('/markers/'+linked.id,{symbol:'AMDL.US',...metadata()},'PATCH')).status,400);

    const csv=await (await call('/markers/export')).text();assert.match(csv,/reference_bar_revision/);assert.match(csv,/'=HYPERLINK/);
    await mutation('/groups/'+group.id,{},'DELETE');
    assert.equal((await call('/markers',{...row,...metadata()})).status,400,'archived groups reject new markers');
    assert.ok((await (await call('/markers')).json() as any).markers.length>0,'archiving never removes saved markers');
    await mutation('/groups/'+group.id,{archived:false},'PATCH');

    // Competing writes use one global CAS shared by groups and annotations.
    const simultaneous={...row,time:'2020-01-08T14:30:00Z'},same={...simultaneous,...metadata()};
    const responses=await Promise.all([call('/markers',same),call('/markers',same)]);
    assert.ok(responses.every(response=>[200,201].includes(response.status)));
    current=(await (await call('/groups')).json() as any).revision;
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_annotation_batches WHERE id=?').bind(same.request_id).first<any>())!.n,1);
    const race=await Promise.all([call('/markers',{...row,...metadata()}),call('/groups',{name:'Concurrent group',...metadata()})]);
    assert.equal(race.filter(response=>response.status===409).length,1);assert.equal(race.filter(response=>response.status===201).length,1);
    current=(await (await call('/groups')).json() as any).revision;
    // Final-statement failure rolls back global revision, batch and audit.
    await db.prepare("CREATE TRIGGER marker_test_failure BEFORE INSERT ON research_annotations WHEN NEW.price=12345 BEGIN SELECT RAISE(ABORT,'injected error'); END").run();
    const failure={...row,price:12345,...metadata()},revisionBefore=current;
    assert.equal((await call('/markers',failure)).status,503);
    assert.equal((await (await call('/groups')).json() as any).revision,revisionBefore);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_annotation_batches WHERE id=?').bind(failure.request_id).first<any>())!.n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM research_annotation_audit WHERE batch_id=?').bind(failure.request_id).first<any>())!.n,0);
    await db.prepare('DROP TRIGGER marker_test_failure').run();

    const large={rows:Array.from({length:500},(_,i)=>({...row,time:new Date(Date.parse('2020-01-09T14:30:00Z')+i*60000).toISOString()}))};
    const largePreview:any=await (await call('/markers/preview',large)).json();assert.equal(largePreview.valid,true);assert.equal(largePreview.counts.insert,500);
    await mutation('/markers/import',{...large,preview_token:largePreview.preview_token});
    const page:any=await (await call('/markers?start=2020-01-09&end=2020-01-09&limit=200')).json();assert.equal(page.markers.length,200);assert.ok(page.next_cursor);assert.equal(page.counts.total,500);
    const next:any=await (await call('/markers?start=2020-01-09&end=2020-01-09&limit=200&cursor='+encodeURIComponent(page.next_cursor))).json();assert.equal(next.markers.length,200);assert.notEqual(next.markers[0].id,page.markers[0].id);
    assert.equal((await (await call('/markers/preview',{rows:Array(501).fill(row)})).json() as any).error,'每批需要1至500条标记');
  }finally{await mf.dispose();}
});

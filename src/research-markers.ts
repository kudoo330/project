import type {Env} from './types';
import {csvCell} from './domain';
import {normalizeResearchTime,nyParts,researchDigest,validDate} from './research-data-validation';

type Group={id:string;name:string;name_key:string;color:string;archived:number;revision:number;created_at:string;updated_at:string};
type Reference={dataset_id:string;time:string;bar_revision:number;[key:string]:unknown};
type Marker={id:string;group_id:string;symbol:'AMD.US'|'AMDL.US';action:'BUY'|'SELL'|'REBUY';time:string;original_time:string;price:number|null;source_type:'manual_hypothesis'|'user_reported_trade';notes:string;status:'candidate'|'confirmed'|'invalidated';source_note:string;pair_id:string|null;reference:Reference|null;deleted:number;revision:number;created_at:string;updated_at:string};
type Change={entity_type:'marker'|'group';entity_id:string;previous:Marker|Group|null;next:Marker|Group};
type ErrorRow={row:number;field:string;message:string};
class MarkerError extends Error{constructor(message:string,public status=400,public code='invalid_input'){super(message);}}
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message:string,status=400,code='invalid_input'):never=>{throw new MarkerError(message,status,code);};
const clean=(value:unknown,label:string,max:number,required=false)=>{
  if(value===undefined||value===null){if(required)fail(`${label}不能为空`);return '';}
  if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(`${label}无效或超过${max}字`);
  const text=(value as string).trim();if(required&&!text)fail(`${label}不能为空`);return text;
};
const identifier=(value:unknown,label='ID')=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)?value:fail(`${label}无效`);
const empty=(value:unknown)=>value===undefined||value===null||value==='';
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=(value:unknown)=>researchDigest(stable(value));
const publicMarker=(marker:Marker)=>({...marker,time_zone:'UTC',deleted:!!marker.deleted});
const readMarker=(row:any):Marker=>{const {time_utc,reference_json,...rest}=row;return {...rest,time:time_utc,reference:reference_json?JSON.parse(reference_json):null};};
const markerColumns='id,group_id,symbol,action,time_utc,original_time,price,source_type,notes,status,source_note,pair_id,reference_json,deleted,revision,created_at,updated_at';
async function readBody(request:Request){
  const reader=request.body?.getReader();if(!reader)fail('缺少请求内容');
  let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {value,done}=await reader!.read();if(done)break;size+=value.byteLength;if(size>800_000){await reader!.cancel();fail('请求超过800KB，请拆分批次',413);}chunks.push(value);}}finally{reader!.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))fail('请求必须为JSON对象');return value;}catch(error){if(error instanceof MarkerError)throw error;return fail('请求必须为有效UTF-8 JSON');}
}
async function revision(db:D1Database){return (await db.prepare('SELECT revision FROM research_annotation_state WHERE id=1').first<{revision:number}>())?.revision??fail('标记数据库尚未初始化',503);}
async function groups(db:D1Database){return (await db.prepare('SELECT * FROM research_annotation_groups ORDER BY archived,name_key,id').all<Group>()).results;}
async function markersById(db:D1Database,ids:string[]){if(!ids.length)return [];return (await db.prepare(`SELECT ${markerColumns} FROM research_annotations WHERE id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all()).results.map(readMarker);}

export function normalizeMarkerTime(value:unknown){
  if(typeof value!=='string')return fail('标记时间必须带Z或明确UTC偏移');
  const match=value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if(!match||Number(match[4]??0)>59)return fail('标记时间需为有效ISO时间并带Z或偏移');
  try{normalizeResearchTime(`${match[1]}T${match[2]}:${match[3]}:00${match[6]}`,'1m');}catch(error){return fail((error as Error).message);}
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return fail('标记时间无效');return date.toISOString();
}
function normalizeMarker(raw:any,groupMap:Map<string,Group>,previous:Marker|undefined,stamp:string):Marker{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('标记需为对象');
  const data={...previous,...raw};const group_id=identifier(data.group_id,'研究分组ID'),group=groupMap.get(group_id);
  if(!group)return fail('研究分组不存在');
  if(group.archived&&(!previous||previous.group_id!==group_id))return fail('不能向已归档分组新增标记');
  if(!['AMD.US','AMDL.US'].includes(data.symbol))return fail('研究标记仅支持AMD.US和AMDL.US');
  if(!['BUY','SELL','REBUY'].includes(data.action))return fail('标记动作必须为BUY、SELL或REBUY');
  if(!['manual_hypothesis','user_reported_trade'].includes(data.source_type))return fail('只能录入人工假设或用户明确报告的成交；策略信号尚未开放');
  const time=normalizeMarkerTime(data.time),original_time=raw.original_time!==undefined?clean(raw.original_time,'原始时间',80,true):(raw.time!==undefined?raw.time:previous?.original_time??raw.time);
  if(normalizeMarkerTime(original_time)!==time)return fail('原始时间和规范时间必须指向同一时刻');
  if(data.source_type==='user_reported_trade'&&Date.parse(time)>Date.now())return fail('不能把未来时间标为已报告真实成交');
  const status=data.status??'candidate';if(!['candidate','confirmed','invalidated'].includes(status))return fail('标记状态无效');
  let price:number|null=null;
  if(!empty(data.price)){
    if((typeof data.price!=='number'&&typeof data.price!=='string')||(typeof data.price==='string'&&!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(data.price.trim())))return fail('价格需为正数或留空');
    price=Number(data.price);if(!Number.isFinite(price)||price<=0||price>1e15)return fail('价格需为有限正数或留空');
  }
  const pair_id=empty(data.pair_id)?null:identifier(data.pair_id,'配对编号');if(pair_id&&data.action==='BUY')return fail('只有SELL和REBUY可以配对');
  let reference:Reference|null=null;
  if(!empty(data.reference)){
    const r=data.reference;if(!r||typeof r!=='object'||!/^market_[a-f0-9]{64}$/.test(r.dataset_id)||!Number.isSafeInteger(r.bar_revision)||r.bar_revision<1)return fail('参考行情需有效dataset_id和单根bar_revision');
    const refTime=validDate(r.time)?r.time:normalizeResearchTime(r.time,'1m').time;
    reference={dataset_id:r.dataset_id,time:refTime,bar_revision:r.bar_revision};
  }
  if(data.deleted!==undefined&&![true,false,0,1].includes(data.deleted))return fail('删除状态必须为布尔值');
  return {id:data.id?identifier(data.id,'标记ID'):'',group_id,symbol:data.symbol,action:data.action,time,original_time,price,source_type:data.source_type,
    notes:clean(data.notes,'备注',2000),status,source_note:clean(data.source_note,'来源说明',1000),pair_id,reference,deleted:data.deleted?1:0,
    revision:previous?.revision??0,created_at:previous?.created_at??stamp,updated_at:previous?.updated_at??stamp};
}
const referenceKey=(reference:Reference|null)=>reference?`${reference.dataset_id}|${reference.time}|${reference.bar_revision}`:'';
async function attachReferences(db:D1Database,rows:Marker[],existing:Map<string,Marker>){
  const needed:Reference[]=[];
  for(const row of rows)if(row.reference){const old=existing.get(row.id)?.reference;if(old&&referenceKey(old)===referenceKey(row.reference))row.reference=old;else needed.push(row.reference);}
  const result=needed.length?(await db.prepare(`SELECT b.*,d.symbol,d.period,d.provider,d.adjustment,d.adjustment_as_of FROM research_market_bars b
    JOIN research_market_datasets d ON d.id=b.dataset_id JOIN json_each(?) j ON b.dataset_id=json_extract(j.value,'$.dataset_id') AND b.time_key=json_extract(j.value,'$.time')`).bind(JSON.stringify(needed)).all<any>()).results:[];
  const available=new Map(result.map(bar=>[`${bar.dataset_id}|${bar.time_key}|${bar.revision}`,bar]));
  for(const row of rows)if(row.reference&&!row.reference.snapshot){
    const bar=available.get(referenceKey(row.reference));if(!bar||bar.status!=='available')fail('参考行情不存在、已修订或缺价，请重新选择行情',409,'stale_reference');
    if(bar.symbol!==row.symbol)fail('参考行情标的与标记标的不一致');
    row.reference={...row.reference,snapshot:{symbol:bar.symbol,period:bar.period,provider:bar.provider,adjustment:bar.adjustment,adjustment_as_of:bar.adjustment_as_of,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,verification:bar.verification}};
  }
  for(const row of rows)if(row.reference){
    const snapshot=row.reference.snapshot as {symbol:string;period:string};
    if(snapshot.symbol!==row.symbol)fail('参考行情标的与标记标的不一致');
    const matches=snapshot.period==='1d'?nyParts(new Date(row.time)).date===row.reference.time:
      Date.parse(row.time)>=Date.parse(row.reference.time)&&Date.parse(row.time)<Date.parse(row.reference.time)+60000;
    if(!matches)fail('参考行情时间必须覆盖标记时刻；请重新选择参考行情或清空引用');
  }
}
async function validatePairs(db:D1Database,rows:Marker[],existing:Map<string,Marker>){
  const pairIds=[...new Set(rows.flatMap(row=>[row.pair_id,existing.get(row.id)?.pair_id]).filter((id):id is string=>!!id))];if(!pairIds.length)return;
  const previous=(await db.prepare(`SELECT ${markerColumns} FROM research_annotations WHERE pair_id IN(SELECT value FROM json_each(?)) AND deleted=0`).bind(JSON.stringify(pairIds)).all()).results.map(readMarker);
  const combined=new Map(previous.map(row=>[row.id,row]));for(const row of rows){if(row.deleted)combined.delete(row.id);else combined.set(row.id,row);}
  for(const pairId of pairIds){
    const members=[...combined.values()].filter(row=>row.pair_id===pairId);
    if(members.length>2||new Set(members.map(row=>row.action)).size!==members.length||members.some(row=>row.action==='BUY'))fail('每个配对编号最多包含一个SELL和一个REBUY');
    if(members.length===2){const sell=members.find(row=>row.action==='SELL')!,rebuy=members.find(row=>row.action==='REBUY')!;
      if(sell.group_id!==rebuy.group_id||sell.symbol!==rebuy.symbol)fail('配对必须是同研究分组、同股票的SELL和REBUY');
      if(sell.time>=rebuy.time)fail('卖出时间必须早于重新买回时间');
    }
  }
}
const markerContent=(marker:Marker)=>{const {revision:_revision,created_at:_created,updated_at:_updated,...content}=marker;return content;};
async function prepareMarkers(db:D1Database,rawRows:any[],stamp:string){
  if(!Array.isArray(rawRows)||!rawRows.length||rawRows.length>500)fail('每批需要1至500条标记');
  const groupMap=new Map((await groups(db)).map(group=>[group.id,group]));
  const givenIds=rawRows.filter(row=>typeof row?.id==='string').map(row=>identifier(row.id,'标记ID'));
  const existing=new Map((await markersById(db,givenIds)).map(row=>[row.id,row]));
  const errors:ErrorRow[]=[],rows:Marker[]=[];
  for(let index=0;index<rawRows.length;index++)try{
    const raw=rawRows[index],row=normalizeMarker(raw,groupMap,existing.get(raw?.id),stamp);
    if(!row.id){const identity={...markerContent(row)};delete (identity as any).id;delete (identity as any).original_time;row.id='marker_'+await digest(identity);}
    rows.push(row);
  }catch(error){errors.push({row:index+1,field:'row',message:(error as Error).message});}
  if(errors.length)return {errors,rows:[],existing};
  if(new Set(rows.map(row=>row.id)).size!==rows.length)return {errors:[{row:0,field:'id',message:'同一批不能重复录入相同标记ID或内容'}],rows:[],existing};
  const generated=rows.filter(row=>!existing.has(row.id));for(const old of await markersById(db,generated.map(row=>row.id)))existing.set(old.id,old);
  // Restore timestamps for content-derived IDs discovered after normalization.
  for(const row of rows){const old=existing.get(row.id);if(old){row.created_at=old.created_at;row.updated_at=old.updated_at;row.revision=old.revision;}}
  try{await attachReferences(db,rows,existing);await validatePairs(db,rows,existing);}catch(error){return {errors:[{row:0,field:'reference_or_pair',message:(error as Error).message}],rows:[],existing};}
  return {errors,rows,existing};
}
async function markerPreview(db:D1Database,body:any){
  const current=await revision(db),prepared=await prepareMarkers(db,body.rows,new Date().toISOString());
  if(prepared.errors.length)return {valid:false,errors:prepared.errors};
  const counts={insert:0,unchanged:0,conflict:0};
  const planned=await Promise.all(prepared.rows.map(async row=>{const old=prepared.existing.get(row.id);
    const action_plan=!old?'insert':await digest(markerContent(row))===await digest(markerContent(old))?'unchanged':'conflict';counts[action_plan]++;
    return {...publicMarker(row),action_plan,...(action_plan==='conflict'?{previous_value:publicMarker(old!)}:{})};}));
  const preview_token=await digest({revision:current,rows:prepared.rows.map(markerContent),existing:[...prepared.existing.values()].sort((a,b)=>a.id.localeCompare(b.id))});
  return {valid:true,errors:[],revision:current,preview_token,counts,rows:planned,prepared};
}
async function savedResponse(db:D1Database,id:string,hash:string){const saved=await db.prepare('SELECT input_hash,response_json FROM research_annotation_batches WHERE id=?').bind(id).first<{input_hash:string;response_json:string}>();return saved?saved.input_hash===hash?reply({...JSON.parse(saved.response_json),replayed:true}):reply({error:'请求ID已被其他内容使用',code:'request_id_conflict'},409):null;}
function writeMeta(body:any){const id=identifier(body.request_id,'请求ID');if(id.length<16)fail('请求ID至少16位');if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision<0)fail('缺少有效expected_revision，请刷新数据');return {id,expected:body.expected_revision};}
async function commit(db:D1Database,body:any,actor:string,operation:string,changes:Change[],hash:string,result:Record<string,unknown>,reason=''){
  const {id,expected}=writeMeta(body),stamp=new Date().toISOString(),next=expected+1;
  for(const change of changes){change.next.revision=(change.previous?.revision??0)+1;change.next.updated_at=stamp;}
  const exposed={...result,...(result.marker?{marker:publicMarker(result.marker as Marker)}:{}),...(result.markers?{markers:(result.markers as Marker[]).map(publicMarker)}:{})};
  const output={ok:true,replayed:false,batch_id:id,revision:next,...exposed};
  const raw=JSON.stringify(changes);if(new TextEncoder().encode(raw).byteLength>1_500_000)fail('本批修订记录过大，请拆分为较小批次');
  const gate='EXISTS(SELECT 1 FROM research_annotation_state WHERE id=1 AND revision=? AND last_import_id=?)';
  const statements=[
    db.prepare('UPDATE research_annotation_state SET revision=revision+1,last_import_id=?,updated_at=? WHERE id=1 AND revision=?').bind(id,stamp,expected),
    db.prepare(`INSERT INTO research_annotation_batches(id,input_hash,actor,operation,response_json,created_at) SELECT ?,?,?,?,?,? WHERE ${gate}`).bind(id,hash,actor,operation,JSON.stringify(output),stamp,next,id),
    db.prepare(`INSERT INTO research_annotation_audit(entity_type,entity_id,batch_id,actor,operation,previous_json,new_json,reason,revision,created_at)
      SELECT json_extract(j.value,'$.entity_type'),json_extract(j.value,'$.entity_id'),?,?,?,json_extract(j.value,'$.previous'),json_extract(j.value,'$.next'),?,?,? FROM json_each(?) j WHERE ${gate}`).bind(id,actor,operation,reason,next,stamp,raw,next,id),
    db.prepare(`INSERT INTO research_annotation_groups(id,name,name_key,color,archived,revision,created_at,updated_at)
      SELECT json_extract(j.value,'$.next.id'),json_extract(j.value,'$.next.name'),json_extract(j.value,'$.next.name_key'),json_extract(j.value,'$.next.color'),json_extract(j.value,'$.next.archived'),json_extract(j.value,'$.next.revision'),json_extract(j.value,'$.next.created_at'),json_extract(j.value,'$.next.updated_at')
      FROM json_each(?) j WHERE json_extract(j.value,'$.entity_type')='group' AND ${gate}
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,color=excluded.color,archived=excluded.archived,revision=excluded.revision,updated_at=excluded.updated_at`).bind(raw,next,id),
    db.prepare(`INSERT INTO research_annotations(${markerColumns})
      SELECT json_extract(j.value,'$.next.id'),json_extract(j.value,'$.next.group_id'),json_extract(j.value,'$.next.symbol'),json_extract(j.value,'$.next.action'),json_extract(j.value,'$.next.time'),json_extract(j.value,'$.next.original_time'),json_extract(j.value,'$.next.price'),json_extract(j.value,'$.next.source_type'),json_extract(j.value,'$.next.notes'),json_extract(j.value,'$.next.status'),json_extract(j.value,'$.next.source_note'),json_extract(j.value,'$.next.pair_id'),CASE WHEN json_type(j.value,'$.next.reference')='object' THEN json_extract(j.value,'$.next.reference') ELSE NULL END,json_extract(j.value,'$.next.deleted'),json_extract(j.value,'$.next.revision'),json_extract(j.value,'$.next.created_at'),json_extract(j.value,'$.next.updated_at')
      FROM json_each(?) j WHERE json_extract(j.value,'$.entity_type')='marker' AND ${gate}
      ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,symbol=excluded.symbol,action=excluded.action,time_utc=excluded.time_utc,original_time=excluded.original_time,price=excluded.price,source_type=excluded.source_type,notes=excluded.notes,status=excluded.status,source_note=excluded.source_note,pair_id=excluded.pair_id,reference_json=excluded.reference_json,deleted=excluded.deleted,revision=excluded.revision,updated_at=excluded.updated_at`).bind(raw,next,id),
  ];
  let executed:D1Result[];try{executed=await db.batch(statements);}catch(error){const prior=await savedResponse(db,id,hash);if(prior)return prior;throw error;}
  if(!executed[0].meta.changes)return await savedResponse(db,id,hash)??reply({error:'其他操作已修改数据，请刷新后重试',code:'stale_revision'},409);
  return reply(output,operation.endsWith('create')?201:200);
}
function markerRange(url:URL){
  const clauses=['1=1'],params:unknown[]=[];
  for(const [key,column,allowed] of [['symbol','m.symbol',['AMD.US','AMDL.US']],['group_id','m.group_id',null],['action','m.action',['BUY','SELL','REBUY']],['status','m.status',['candidate','confirmed','invalidated']]] as const){const value=url.searchParams.get(key);if(value){if(allowed&&!allowed.includes(value as never))fail(`筛选${key}无效`);if(key==='group_id')identifier(value);clauses.push(`${column}=?`);params.push(value);}}
  if(url.searchParams.get('include_deleted')!=='1')clauses.push('m.deleted=0');
  const start=url.searchParams.get('start'),end=url.searchParams.get('end');
  for(const value of [start,end])if(value&&!validDate(value))fail('筛选日期需为YYYY-MM-DD纽约日期');
  if(start&&end&&start>end)fail('开始日期不能晚于结束日期');
  // UTC bounds are widened; exact NY date filtering happens on bounded results.
  if(start){clauses.push('m.time_utc>=?');params.push(start+'T00:00:00.000Z');}
  if(end){clauses.push('m.time_utc<?');params.push(new Date(Date.parse(end+'T00:00:00Z')+2*86400000).toISOString());}
  return {where:clauses.join(' AND '),params,start,end};
}
async function listMarkers(db:D1Database,url:URL,exporting=false){
  const range=markerRange(url),current=await revision(db);
  // A bounded materialization allows DST-correct NY filtering and whole-scope
  // paired statistics. Larger research windows must be narrowed explicitly.
  const raw=(await db.prepare(`SELECT m.*,g.name AS group_name,g.color AS group_color FROM research_annotations m JOIN research_annotation_groups g ON g.id=m.group_id WHERE ${range.where} ORDER BY m.time_utc,m.id LIMIT 5001`).bind(...range.params).all<any>()).results;
  if(raw.length>5000)return reply({error:'所选范围超过5000条，请缩小日期或分组范围；没有截断结果'},413);
  const all=raw.map(row=>({...publicMarker(readMarker(row)),group_name:row.group_name,group_color:row.group_color})).filter(row=>{const date=nyParts(new Date(row.time)).date;return (!range.start||date>=range.start)&&(!range.end||date<=range.end);});
  const counts={total:all.length,buy:all.filter(row=>row.action==='BUY').length,sell:all.filter(row=>row.action==='SELL').length,rebuy:all.filter(row=>row.action==='REBUY').length,paired:0,dates:new Set(all.map(row=>nyParts(new Date(row.time)).date)).size};
  const pairs=new Map<string,number>();for(const row of all)if(row.pair_id&&!row.deleted)pairs.set(row.pair_id,(pairs.get(row.pair_id)??0)+1);counts.paired=[...pairs.values()].filter(count=>count===2).length;
  if(exporting){
    const header=['id','group_id','group_name','color','symbol','action','time','original_time','price','source_type','notes','status','source_note','pair_id','created_at','updated_at','reference_dataset_id','reference_time','reference_bar_revision'];
    const lines=[header.join(',')];for(const row of all)lines.push([row.id,row.group_id,row.group_name,row.group_color,row.symbol,row.action,row.time,row.original_time,row.price,row.source_type,row.notes,row.status,row.source_note,row.pair_id,row.created_at,row.updated_at,row.reference?.dataset_id,row.reference?.time,row.reference?.bar_revision].map(csvCell).join(','));
    return new Response('\ufeff'+lines.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="research-markers.csv"','Cache-Control':'no-store'}});
  }
  const limit=Number(url.searchParams.get('limit')??200);if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('每页支持1至200条');
  const cursor=url.searchParams.get('cursor');let after=all;
  if(cursor){const parts=cursor.split('|');if(parts.length!==2)fail('分页游标无效');normalizeMarkerTime(parts[0]);identifier(parts[1]);after=all.filter(row=>`${row.time}|${row.id}`>cursor);}
  const selected=after.slice(0,limit);return reply({markers:selected,revision:current,next_cursor:after.length>limit?`${selected[selected.length-1].time}|${selected[selected.length-1].id}`:null,counts});
}

/** Parent router must enforce admin authorization and Origin/JSON for writes. */
export async function researchMarkersApi(request:Request,env:Env,url:URL,actor:string):Promise<Response>{
  const db=env.DB,path=url.pathname.slice('/api/research'.length);
  try{
    if(request.method==='GET'&&path==='/groups')return reply({groups:await groups(db),revision:await revision(db),capabilities:{max_rows:500,max_body_bytes:800000}});
    if(request.method==='GET'&&path==='/markers')return await listMarkers(db,url);
    if(request.method==='GET'&&path==='/markers/export')return await listMarkers(db,url,true);
    if(!['POST','PATCH','DELETE'].includes(request.method))return reply({error:'接口或方法不存在'},404);
    const body=await readBody(request);
    if(path==='/markers/preview'&&request.method==='POST'){const result=await markerPreview(db,body);const {prepared:_prepared,...safe}=result;return reply(safe);}
    const meta=writeMeta(body),hash=await digest({path,method:request.method,body});const prior=await savedResponse(db,meta.id,hash);if(prior)return prior;
    if(await revision(db)!==meta.expected)return await savedResponse(db,meta.id,hash)??reply({error:'数据已变化，请刷新后重试',code:'stale_revision'},409);
    if(path==='/markers/import'&&request.method==='POST'){
      if(typeof body.preview_token!=='string')fail('请先预览导入内容');
      const checked=await markerPreview(db,body);if(!checked.valid)return reply(checked,400);
      if(checked.revision!==meta.expected||checked.preview_token!==body.preview_token)return await savedResponse(db,meta.id,hash)??reply({error:'预览已变化，请重新预览',code:'stale_preview'},409);
      if(body.replace_conflicts!==undefined&&typeof body.replace_conflicts!=='boolean')fail('替换选项必须为布尔值');
      const reason=clean(body.replace_reason,'替换依据',2000);
      if(checked.counts!.conflict&&(!body.replace_conflicts||!reason))return reply({error:'存在冲突，须明确允许替换并填写依据',code:'marker_conflict',counts:checked.counts},409);
      const prepared=checked.prepared!,changes:Change[]=[];
      for(const row of prepared.rows){const old=prepared.existing.get(row.id);if(!old||await digest(markerContent(row))!==await digest(markerContent(old)))changes.push({entity_type:'marker',entity_id:row.id,previous:old??null,next:row});}
      return await commit(db,body,actor,'markers.import',changes,hash,{counts:checked.counts},reason);
    }
    const groupMatch=path.match(/^\/groups(?:\/([A-Za-z0-9_-]+))?$/);
    if(groupMatch){
      const list=await groups(db),id=groupMatch[1]??(request.method==='POST'?'group_'+crypto.randomUUID():identifier(body.id));const old=list.find(group=>group.id===id);
      if(request.method==='POST'&&groupMatch[1])return reply({error:'接口或方法不存在'},404);
      if(request.method!=='POST'&&!old)fail('研究分组不存在',404);
      if(request.method==='POST'&&list.length>=200)fail('最多200个研究分组');
      const name=clean(body.name??old?.name,'分组名称',80,true).normalize('NFC'),name_key=name.toLocaleLowerCase('en-US');
      if(list.some(group=>group.id!==id&&group.name_key===name_key))fail('已存在同名分组',409);
      const palette=['#0F766E','#2563EB','#7C3AED','#C2410C','#BE185D','#4338CA','#15803D','#A16207'];
      const color=body.color??old?.color??palette[list.length%palette.length];if(typeof color!=='string'||!/^#[A-Fa-f0-9]{6}$/.test(color))fail('分组颜色必须为#RRGGBB');
      if(body.archived!==undefined&&![true,false,0,1].includes(body.archived))fail('归档状态必须为布尔值');
      const stamp=new Date().toISOString(),next:Group={id,name,name_key,color,archived:request.method==='DELETE'?1:body.archived===undefined?old?.archived??0:body.archived?1:0,revision:old?.revision??0,created_at:old?.created_at??stamp,updated_at:stamp};
      return await commit(db,body,actor,old?'group.update':'group.create',[{entity_type:'group',entity_id:id,previous:old??null,next}],hash,{group:next});
    }
    if(request.method==='POST'&&['/markers/pair','/markers/unpair'].includes(path)){
      let originals:Marker[];
      if(path.endsWith('/pair')){
        const sellId=identifier(body.sell_id),rebuyId=identifier(body.rebuy_id);if(sellId===rebuyId)fail('卖出和重新买回必须为不同标记');
        originals=await markersById(db,[sellId,rebuyId]);const sell=originals.find(row=>row.id===sellId),rebuy=originals.find(row=>row.id===rebuyId);
        if(!sell||!rebuy||sell.deleted||rebuy.deleted)return fail('待配对标记不存在或已删除',404);
        if(sell.action!=='SELL'||rebuy.action!=='REBUY')fail('配对动作必须分别为SELL和REBUY');
        if(sell.pair_id||rebuy.pair_id)fail('标记已有配对，请先解除原配对',409);
      }else originals=(await db.prepare(`SELECT ${markerColumns} FROM research_annotations WHERE pair_id=? AND deleted=0`).bind(identifier(body.pair_id,'配对编号')).all()).results.map(readMarker);
      if(!originals.length)fail('配对不存在',404);
      const pair_id=path.endsWith('/pair')?'pair_'+crypto.randomUUID():null;
      const next=originals.map(row=>({...row,pair_id}));await validatePairs(db,next,new Map(originals.map(row=>[row.id,row])));
      return await commit(db,body,actor,pair_id?'markers.pair':'markers.unpair',next.map((row,index)=>({entity_type:'marker',entity_id:row.id,previous:originals[index],next:row})),hash,{markers:next});
    }
    const markerMatch=path.match(/^\/markers(?:\/([A-Za-z0-9_-]+))?$/);
    if(markerMatch){
      const id=markerMatch[1]??(request.method==='POST'?'marker_'+crypto.randomUUID():identifier(body.id)),old=(await markersById(db,[id]))[0];
      if(request.method==='POST'&&markerMatch[1])return reply({error:'接口或方法不存在'},404);
      if(request.method!=='POST'&&!old)fail('标记不存在',404);
      const incoming={...old,...body,id,...(request.method==='DELETE'?{deleted:true}:{})};
      // If a timestamp is edited without an original-time field, preserve the
      // newly submitted representation, not the previous original timestamp.
      if(body.time!==undefined&&body.original_time===undefined)incoming.original_time=body.time;
      const prepared=await prepareMarkers(db,[incoming],new Date().toISOString());if(prepared.errors.length)return reply({error:'标记未通过校验',errors:prepared.errors},400);
      const next=prepared.rows[0];return await commit(db,body,actor,old?'marker.update':'marker.create',[{entity_type:'marker',entity_id:id,previous:old??null,next}],hash,{marker:next});
    }
    return reply({error:'接口或方法不存在'},404);
  }catch(error){if(error instanceof MarkerError)return reply({error:error.message,code:error.code},error.status);return reply({error:'研究标记存储暂不可用，请稍后重试',code:'research_markers_unavailable'},503);}
}

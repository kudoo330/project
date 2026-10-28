import type { Env } from './types';

const MAX_BYTES=4*1024*1024, PART_BYTES=192*1024;
type Download={id:string;filename:string;title:string;sha256:string;byte_length:number;part_count:number;actor:string;created_at:string;expires_at:string};
class InputError extends Error {}
const json=(value:unknown,status=200)=>Response.json(value,{status});
async function sha256(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function encode(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function decode(value:string){let text:string;try{text=atob(value);}catch{throw new InputError('文件编码无效');}return Uint8Array.from(text,c=>c.charCodeAt(0));}
function visible(row:Download){return {id:row.id,filename:row.filename,title:row.title,byte_length:row.byte_length,sha256:row.sha256,expires_at:row.expires_at,url:'/api/research-downloads/'+row.id};}

/** The main router authenticates admin on reads and validates Origin/JSON on writes. */
export async function researchDownloadsApi(request:Request,env:Env,url:URL,actor:string):Promise<Response>{
 try{
  const path=url.pathname.replace('/api/research-downloads',''),now=new Date().toISOString();
  if(path===''&&request.method==='GET'){
   const rows=(await env.DB.prepare('SELECT * FROM research_downloads WHERE expires_at>? ORDER BY created_at DESC,id LIMIT 20').bind(now).all<Download>()).results;
   return json({files:rows.map(visible)});
  }
  if(path===''&&request.method==='POST'){
   const maxBody=6*1024*1024;
   if(Number(request.headers.get('Content-Length')??0)>maxBody)throw new InputError('下载包请求过大');
   const reader=request.body?.getReader();if(!reader)throw new InputError('缺少下载包');
   const chunks:Uint8Array[]=[];let length=0;
   while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>maxBody){await reader.cancel();throw new InputError('下载包请求过大');}chunks.push(part.value);}
   const inputBytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){inputBytes.set(chunk,offset);offset+=chunk.length;}
   let value:any;try{value=JSON.parse(new TextDecoder().decode(inputBytes));}catch{throw new InputError('需要有效JSON下载包');}
   if(!value||!/^[_A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.zip$/.test(value.filename??''))throw new InputError('下载文件名必须为安全的ZIP文件名');
   if(typeof value.title!=='string'||!value.title.trim()||value.title.length>160)throw new InputError('请填写下载说明');
   if(!/^[a-f0-9]{64}$/.test(value.sha256??'')||typeof value.data_base64!=='string'||value.data_base64.length>Math.ceil(MAX_BYTES/3)*4)throw new InputError('下载包校验信息无效或文件超过4MB');
   const bytes=decode(value.data_base64);
   if(bytes.length<4||bytes.length>MAX_BYTES||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4)throw new InputError('只接受不超过4MB的ZIP下载包');
   const hash=await sha256(bytes);if(hash!==value.sha256)throw new InputError('文件SHA256不一致');
   const id='download_'+hash,previous=await env.DB.prepare('SELECT * FROM research_downloads WHERE id=?').bind(id).first<Download>();
   if(previous){if(previous.filename!==value.filename||previous.title!==value.title.trim())return json({error:'相同文件已使用其他下载说明'},409);if(previous.expires_at<=now)return json({error:'该下载包已过期'},410);return json({ok:true,replayed:true,file:visible(previous)});}
   const expires=new Date(Date.now()+7*86400000).toISOString(),partCount=Math.ceil(bytes.length/PART_BYTES);
   const row:Download={id,filename:value.filename,title:value.title.trim(),sha256:hash,byte_length:bytes.length,part_count:partCount,actor,created_at:now,expires_at:expires};
   const statements=[env.DB.prepare('INSERT OR IGNORE INTO research_downloads VALUES(?,?,?,?,?,?,?,?,?)').bind(id,row.filename,row.title,hash,bytes.length,partCount,actor,now,expires)];
   for(let i=0;i<partCount;i++)statements.push(env.DB.prepare('INSERT OR IGNORE INTO research_download_parts VALUES(?,?,?)').bind(id,i,encode(bytes.subarray(i*PART_BYTES,(i+1)*PART_BYTES))));
   statements.push(env.DB.prepare("INSERT OR IGNORE INTO audit(id,record_id,actor,action,previous_value,created_at) VALUES(?,?,?,?,?,?)").bind(id,id,actor,'prepare_research_download',JSON.stringify({filename:row.filename,sha256:hash,byte_length:bytes.length}),now));
   await env.DB.batch(statements);
   const saved=await env.DB.prepare('SELECT * FROM research_downloads WHERE id=?').bind(id).first<Download>();
   if(saved?.filename!==row.filename||saved.title!==row.title)return json({error:'下载包说明已在其他请求中设置'},409);
   return json({ok:true,replayed:false,file:visible(saved)},201);
  }
  if(/^\/download_[a-f0-9]{64}$/.test(path)&&request.method==='GET'){
   const row=await env.DB.prepare('SELECT * FROM research_downloads WHERE id=?').bind(path.slice(1)).first<Download>();
   if(!row)return json({error:'下载文件不存在'},404);
   if(row.expires_at<=now)return json({error:'下载文件已过期，请重新准备'},410);
   const parts=(await env.DB.prepare('SELECT part,data_base64 FROM research_download_parts WHERE download_id=? ORDER BY part').bind(row.id).all<{part:number;data_base64:string}>()).results;
   if(parts.length!==row.part_count)throw new Error('incomplete');
   const bytes=new Uint8Array(row.byte_length);let offset=0;
   for(let i=0;i<parts.length;i++){if(parts[i].part!==i)throw new Error('incomplete');const chunk=decode(parts[i].data_base64);bytes.set(chunk,offset);offset+=chunk.length;}
   if(offset!==row.byte_length||await sha256(bytes)!==row.sha256)throw new Error('checksum');
   return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${row.filename}"`,'Content-Length':String(bytes.length),'Cache-Control':'no-store','X-Content-SHA256':row.sha256}});
  }
  return json({error:'下载接口不存在'},404);
 }catch(error){return error instanceof InputError?json({error:error.message},400):json({error:'下载包暂时不可用，请稍后重试'},503);}
}

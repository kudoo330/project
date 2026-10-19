import {normalizeSymbol,shanghaiNow} from './domain';
import {compareCloses,mergeCloseWindow,collectionWindow} from './close-validation';
import type {Bar,RecordRow} from './types';
import type {CorporateSource} from './corporate-actions';
function bars(value:unknown):Bar[]{
 if(!Array.isArray(value)||!value.length||value.length>11)throw new Error('收盘证据需包含1至11个日期');
 const seen=new Set<string>();return value.map(b=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(b.date)||seen.has(b.date))throw new Error('日期错误或重复');seen.add(b.date);
  const values=['open','close','high','low','volume'].map(k=>b[k]);if(values.some(v=>typeof v!=='number'||!Number.isFinite(v))||values.slice(0,4).some(v=>v<=0)||b.low>b.high||b.open<b.low||b.open>b.high||b.close<b.low||b.close>b.high||b.volume<0)throw new Error('无效OHLC行情');
  return {date:b.date,open:b.open,close:b.close,high:b.high,low:b.low,volume:b.volume};
 });
}
export function validateCloseImport(value:any){
 const symbol=normalizeSymbol(value.symbol),primary=bars(value.bars),secondary=bars(value.secondary);
 const primaryProvider=value.primaryProvider??'东方财富';if(!['东方财富','新浪'].includes(primaryProvider))throw new Error('主来源无效');
 if(!['腾讯','新浪'].includes(value.secondaryProvider)||primaryProvider===value.secondaryProvider)throw new Error('缺少独立交叉来源');
 const fetchedAt=value.fetchedAt;if(typeof fetchedAt!=='string'||!Number.isFinite(Date.parse(fetchedAt))||Date.parse(fetchedAt)>Date.now()+60000)throw new Error('获取时间无效');
 const local=shanghaiNow(),cutoff=local.slice(11)>='16:05:00'?local.slice(0,10):shanghaiNow(new Date(Date.now()-86400000)).slice(0,10);
 if(primary.some(b=>b.date>cutoff))throw new Error('不能导入盘中或未来的收盘价');
 const result=compareCloses(primary,secondary,fetchedAt,[primaryProvider,value.secondaryProvider]);if(result.bars.length!==primary.length)throw new Error('两源收盘价未逐日匹配');
 if(!value.evidence||typeof value.evidence!=='object'||JSON.stringify(value.evidence).length>20000)throw new Error('缺少或过大的来源证据');
 const source=value.corporateSource as CorporateSource|undefined;
 if(source&&(source.status==='available'||source.status==='unavailable')){
  if(!Array.isArray(source.factors)||source.factors.length>100||source.factors.some(f=>!/^\d{4}-\d{2}-\d{2}$/.test(f.date)||!Number.isFinite(f.factor)||f.factor<=0))throw new Error('无效复权因子');
  if(source.status==='available')bars(source.qfq);
 }else if(source)throw new Error('复权证据格式错误');
 return {symbol,name:String(value.name??'').slice(0,100),...result,fetchedAt,corporateSource:source,provider:primaryProvider+' / '+value.secondaryProvider+'，Codex交叉验证补齐',evidence:value.evidence};
}
export async function importVerifiedCloses(db:D1Database,value:any,actor:string){
 if(!Array.isArray(value.quotes)||!value.quotes.length||value.quotes.length>8)throw new Error('每批补齐1至8只股票');
 const quotes=value.quotes.map(validateCloseImport),symbols=quotes.map((q:ReturnType<typeof validateCloseImport>)=>q.symbol);
 if(new Set(symbols).size!==symbols.length)throw new Error('同一批股票代码不能重复');
 const rows=(await db.prepare('SELECT * FROM records WHERE symbol IN ('+symbols.map(()=>'?').join(',')+')').bind(...symbols).all<RecordRow>()).results;
 const writes:D1PreparedStatement[]=[],ids:string[]=[];
 for(const q of quotes){
  for(const r of rows.filter(r=>r.symbol===q.symbol)){
   const allowed=new Set(collectionWindow(r));if(q.bars.some((b:Bar)=>!allowed.has(b.date)))throw new Error('报价超出该样本D0至D+10范围');
   let old:Bar[]=[];try{old=JSON.parse(r.market_data??'{}').bars??[];}catch{}
   if(q.bars.some((b:Bar)=>old.some(v=>v.date===b.date&&v.crossCheck?.status==='matched'&&Math.abs(v.close-b.close)>1e-8)))throw new Error('新证据与已核验收盘价不一致；保留原价，需人工核对');
   const saved=mergeCloseWindow(r,q),error=saved.adjustment.status==='pending'?'除权核对：'+saved.adjustment.reason:null;
   writes.push(db.prepare('UPDATE records SET market_data=?,fetched_at=?,error=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(saved),q.fetchedAt,error,new Date().toISOString(),r.id,r.revision));
   writes.push(db.prepare('INSERT INTO audit(id,record_id,actor,action,previous_value,created_at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),r.id,actor,'verified-close-import',JSON.stringify({market_data:r.market_data,fetched_at:r.fetched_at,error:r.error}),new Date().toISOString()));ids.push(r.id);
  }
 }
 if(!ids.length)throw new Error('没有匹配的买入记录');
 if(writes.length>40)throw new Error('重复策略样本过多，请拆分股票批次');
 const result=await db.batch(writes);const updated=result.filter((_:unknown,i:number)=>i%2===0).reduce((n:number,r:D1Result)=>n+r.meta.changes,0);
 return {ok:updated===ids.length,updated,matched_records:ids.length,conflicts:ids.length-updated};
}

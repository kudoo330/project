import type { Bar, Env } from './types';
import { closedBars } from './domain';
import {compareCloses} from './close-validation';
import type {CorporateSource} from './corporate-actions';
export const PROVIDER = '东方财富（不复权；成交量原始单位：手）';
const FIELD = 'fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
type QuoteData = { code: string; name: string; bars: Bar[]; fetchedAt: string; cached: boolean; provider: string; adjustment: string };
async function upstream(url: string) {
  let r:Response;
  try{r=await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });}
  catch{throw new Error('行情网络不可达或超时；已保存的旧数据不会被清空。');}
  if (!r.ok) throw new Error('行情请求失败：HTTP '+r.status);
  const j = await r.json() as { rc?:number;data?:{code:string;name:string;qtMiscType?:number;type?:number;klines?:string[];trends?:string[]} };
  if (j.rc !== 0 || !j.data) throw new Error('供应商无有效证券数据，不能确认代码或市场');
  return j.data;
}
export async function daily(env: Env, symbol: string, force=false): Promise<QuoteData> {
  const cacheKey='daily:'+symbol;
  const cached=force?null:await env.DB.prepare('SELECT data FROM market_cache WHERE key=? AND expires_at>?').bind(cacheKey,Date.now()).first<{data:string}>();
  if(cached)return {...JSON.parse(cached.data),cached:true};
  const [code,exchange]=symbol.split('.');
  const secid=(exchange==='SH'?'1':'0')+'.'+code;
  const d=await upstream('https://push2his.eastmoney.com/api/qt/stock/kline/get?'+FIELD+'&secid='+secid+'&klt=101&fqt=0&beg=20200101&end=20500101&lmt=600');
  if(d.code!==code)throw new Error('供应商代码不匹配');
  // SZ and BJ share secid market=0; verify the returned classification, never silently remap.
  if(exchange==='BJ'&&d.qtMiscType!==4 || exchange==='SZ'&&d.qtMiscType===4)throw new Error('供应商证券市场与输入后缀不一致，或北交所分类无法确认');
  const bars=(d.klines??[]).map(row=>{
    const v=row.split(',');return {date:v[0],open:Number(v[1]),close:Number(v[2]),high:Number(v[3]),low:Number(v[4]),volume:Number(v[5])};
  }).filter(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.date)&&[b.open,b.close,b.high,b.low,b.volume].every(Number.isFinite)&&b.low>0&&b.high>=b.low);
  if(!bars.length)throw new Error('没有有效日线');
  const result={code,name:d.name,bars,fetchedAt:new Date().toISOString(),cached:false,provider:PROVIDER,adjustment:'不复权；公司行动尚未自动核实'};
  await env.DB.prepare('INSERT INTO market_cache(key,data,fetched_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at').bind(cacheKey,JSON.stringify(result),Date.now(),Date.now()+300000).run();
  return result;
}
export async function minute(env:Env,symbol:string,date:string) {
  const key=`minute:${symbol}:${date}`;
  const cached=await env.DB.prepare('SELECT data FROM market_cache WHERE key=? AND expires_at>?').bind(key,Date.now()).first<{data:string}>();
  if(cached)return {...JSON.parse(cached.data),cached:true};
  const [code,market]=symbol.split('.');
  const d=await upstream('https://push2his.eastmoney.com/api/qt/stock/trends2/get?'+FIELD+'&secid='+(market==='SH'?'1':'0')+'.'+code+'&ndays=5&iscr=0');
  if(d.code!==code)throw new Error('供应商代码不匹配');
  if(market==='BJ'&&d.type!==81 || market==='SZ'&&d.type===81)throw new Error('供应商证券市场与输入后缀不一致，或北交所分类无法确认');
  const rows=(d.trends??[]).filter(row=>row.startsWith(date+' ')).map(row=>{
    const v=row.split(',');return {label:v[0],open:Number(v[1]),close:Number(v[2]),high:Number(v[3]),low:Number(v[4]),volume:Number(v[5])};
  });
  const result={rows,provider:PROVIDER,fetchedAt:new Date().toISOString(),cached:false,pricingUsable:false,intervalVerified:false,warning:'分钟区间及采样口径尚未核实；历史开盘价可能为0，不自动生成买入基准。'};
  await env.DB.prepare('INSERT INTO market_cache(key,data,fetched_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at').bind(key,JSON.stringify(result),Date.now(),Date.now()+300000).run();
  return result;
}
export {closedBars};
export async function verifiedDaily(env:Env,symbol:string,force=false){
  const primary=await daily(env,symbol,force),[code,exchange]=symbol.split('.');
  const key=exchange.toLowerCase()+code;
  const param=new URLSearchParams({param:key+',day,,,600,'});
  let response:Response;
  try{response=await fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?'+param,{signal:AbortSignal.timeout(12000)});}catch{throw new Error('腾讯交叉来源暂不可达，收盘价待核对；旧数据保留。');}
  if(!response.ok)throw new Error('腾讯交叉来源HTTP '+response.status+'，收盘价待核对');
  const json=await response.json() as {code:number;data?:Record<string,{day?:string[][]}>};
  if(json.code!==0)throw new Error('腾讯交叉来源无有效数据，收盘价待核对');
  const secondary=(json.data?.[key]?.day??[]).map(v=>({date:v[0],open:Number(v[1]),close:Number(v[2]),high:Number(v[3]),low:Number(v[4]),volume:Number(v[5])})).filter(b=>Number.isFinite(b.close)&&b.close>0);
  const checkedAt=new Date().toISOString();
  const corporateSource=await corporateFactors(symbol);
  return {...primary,...compareCloses(closedBars(primary.bars),closedBars(secondary),checkedAt),provider:'东方财富收盘价 / 腾讯不复权日线交叉核对',checkedAt,corporateSource};
}
async function corporateFactors(symbol:string):Promise<CorporateSource>{
  const [code,market]=symbol.split('.'),key=market.toLowerCase()+code,fetchedAt=new Date().toISOString();
  try{
    const [factorResponse,qfqResponse]=await Promise.all([
      fetch('https://finance.sina.com.cn/realstock/company/'+key+'/hfq.js',{signal:AbortSignal.timeout(12000)}),
      fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?'+new URLSearchParams({param:key+',day,,,600,qfq'}),{signal:AbortSignal.timeout(12000)})
    ]);
    if(!factorResponse.ok||!qfqResponse.ok)throw new Error('复权来源请求失败');
    const line=(await factorResponse.text()).split(/\r?\n/)[0];
    if(!line.startsWith('var '+key+'hfq=')||line.length>200000)throw new Error('复权因子响应格式异常');
    const raw=JSON.parse(line.slice(line.indexOf('=')+1).replace(/;\s*$/,'')) as {data:{d:string;f:string}[]};
    const factors=raw.data.map(f=>({date:f.d,factor:Number(f.f)}));
    if(!factors.length||factors.some(f=>!/^\d{4}-\d{2}-\d{2}$/.test(f.date)||!Number.isFinite(f.factor)||f.factor<=0))throw new Error('复权因子无效');
    const json=await qfqResponse.json() as {code:number;data?:Record<string,{qfqday?:string[][];day?:string[][]}>};
    if(json.code!==0)throw new Error('前复权日线无效');
    const rows=json.data?.[key]?.qfqday??json.data?.[key]?.day??[];
    const qfq=closedBars(rows.map(v=>({date:v[0],open:Number(v[1]),close:Number(v[2]),high:Number(v[3]),low:Number(v[4]),volume:Number(v[5])}))).filter(b=>b.close>0&&Number.isFinite(b.close));
    if(!qfq.length)throw new Error('缺少前复权日线');
    return {status:'available',factors,qfq,fetchedAt};
  }catch(e){return {status:'unavailable',factors:[],qfq:[],fetchedAt,error:e instanceof Error?e.message:'复权来源不可用'};}
}

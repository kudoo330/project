import type { Bar, Env } from './types';
import { closedBars } from './domain';
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
export async function daily(env: Env, symbol: string): Promise<QuoteData> {
  const cacheKey='daily:'+symbol;
  const cached=await env.DB.prepare('SELECT data FROM market_cache WHERE key=? AND expires_at>?').bind(cacheKey,Date.now()).first<{data:string}>();
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

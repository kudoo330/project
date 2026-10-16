import type { Bar } from './types';
export function shanghaiNow(now = new Date()) { return new Date(now.getTime()+8*3600000).toISOString().slice(0,19); }
export function normalizeSymbol(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase();
  // Bare codes require a directory lookup; do not infer the exchange from digits.
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(text)) throw new Error('请输入带交易所的代码，如 600519.SH；裸代码需先查询证券。');
  return text;
}
export function normalizeTime(value: unknown, now = new Date()) {
  const s = String(value ?? '').trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) throw new Error('买入日期时间格式错误');
  const full = s.length === 16 ? s+':00' : s;
  const date = new Date(full+'+08:00');
  if (!Number.isFinite(date.getTime()) || shanghaiNow(date) !== full) throw new Error('买入日期时间无效');
  if (date > now) throw new Error('不接受未来买入时间');
  if (full.slice(0,10) < shanghaiNow(new Date(now.getTime()-2*86400000)).slice(0,10)) throw new Error('当前只接受当天及前2个自然日的买入记录');
  return full;
}
export function optionalPositive(value: unknown, name: string) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) throw new Error(name+'必须为正数');
  return n;
}
export function change(price: number | null, base: number | null) { return price !== null && base !== null && price>0 && base>0 ? (price/base-1)*100 : null; }
export function extrema(values: (number|null)[]) {
  const v = values.filter((x):x is number=>x !== null);
  return { max: v.length ? Math.max(0,...v):null, min: v.length ? Math.min(0,...v):null };
}
export function summarize(values: (number|null)[]) {
  const v=values.filter((x):x is number=>x!==null);
  return { count:v.length, mean:v.length?v.reduce((a,b)=>a+b,0)/v.length:null, positive:v.length?v.filter(x=>x>0).length/v.length:null };
}
export function csvCell(value: unknown) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
}
export function closedBars(bars: Bar[], now=new Date()) {
  const local=shanghaiNow(now);
  // Publication buffer; even after this, provenance still says provider-reported close.
  return bars.filter(b=>b.date<local.slice(0,10) || b.date===local.slice(0,10)&&local.slice(11)>='16:00:00');
}
export function indicators(bars: Bar[]) {
  const last=bars.at(-1);
  const ma=(n:number)=>bars.length>=n?bars.slice(-n).reduce((s,b)=>s+b.close,0)/n:null;
  const preceding=bars.slice(-6,-1),average=preceding.reduce((s,b)=>s+b.volume,0)/5;
  return {ma5:ma(5),ma10:ma(10),ma20:ma(20),volumeRatio:last&&preceding.length===5&&average>0?last.volume/average:null,asOf:last?.date??null};
}

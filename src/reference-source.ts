import {optionalPositive} from './domain';
const hosts:Record<string,string[]>={'东方财富':['push2his.eastmoney.com','push2.eastmoney.com'],'新浪':['quotes.sina.cn'],'腾讯':['web.ifzq.gtimg.cn']};
export function minuteCloseSource(value:any,price:number|null,record:{symbol:string;buy_time:string}){
 if(!value||typeof value!=='object'||value.field!=='close'||value.interval!=='1m'||value.symbol!==record.symbol||value.source_label!==record.buy_time.replace('T',' ').slice(0,16)+':00')throw new Error('分钟收盘价证据与股票或买入分钟不一致');
 if(!['东方财富','新浪'].includes(value.provider)||price===null||!Array.isArray(value.quotes)||value.quotes.length<1||value.quotes.length>3)throw new Error('分钟收盘来源无效');
 const seen=new Set<string>();
 const quotes=value.quotes.map((q:any)=>{
  if(!hosts[q.provider]||seen.has(q.provider))throw new Error('交叉来源无效或重复');seen.add(q.provider);
  const url=new URL(q.url);if(url.protocol!=='https:'||!hosts[q.provider].includes(url.hostname)||url.username||url.password)throw new Error('来源网址无效');
  const n=optionalPositive(q.price,'分钟收盘价');if(n===null||!Number.isFinite(Date.parse(q.fetched_at)))throw new Error('来源报价或时间无效');
  return {provider:q.provider,price:n,url:q.url,fetched_at:q.fetched_at};
 });
 const primary=quotes.find((q:{provider:string})=>q.provider===value.provider);if(!primary||Math.abs(primary.price-price)>1e-8)throw new Error('参考价与首选来源报价不一致');
 return {provider:value.provider,field:'close',interval:'1m',symbol:record.symbol,source_label:value.source_label,interval_boundary_verified:false,quotes,cross_verified:quotes.some((q:{provider:string;price:number})=>q.provider!==value.provider&&Math.abs(q.price-price)<1e-8),selection_rule:'东方财富分钟收盘价优先，缺少时新浪补充；两源报价及差异保留'};
}

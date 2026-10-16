import type {Bar,RecordRow} from './types';
import {corporateAdjustment,type CorporateSource,type Adjustment} from './corporate-actions';
import {afterBuyWindow} from './observation-window';
export {afterBuyWindow};
export function compareCloses(primary:Bar[],secondary:Bar[],checkedAt:string){
  const other=new Map(secondary.map(b=>[b.date,b])),bars:Bar[]=[],validation=[];
  for(const b of primary){const second=other.get(b.date),matched=Boolean(second&&b.close>0&&second.close>0&&Math.abs(b.close-second.close)<1e-8);validation.push({date:b.date,status:matched?'matched':second?'mismatch':'secondary_missing',primaryClose:b.close,secondaryClose:second?.close??null});if(matched)bars.push({...b,crossCheck:{status:'matched',sources:['东方财富','腾讯'],checkedAt}});}
  return {bars,validation};
}
export function mergeCloseWindow<T extends {bars:Bar[];validation:{date:string;status:string}[];fetchedAt?:string;corporateSource?:CorporateSource}>(record:RecordRow,quote:T){
  const window=new Set(afterBuyWindow(record));let old:Bar[]=[];try{old=JSON.parse(record.market_data??'{}').bars??[];}catch{}
  const merged=new Map(old.map(b=>[b.date,b]));for(const bar of quote.bars)if(window.has(bar.date))merged.set(bar.date,bar);
  const bars=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const local=new Date(new Date(quote.fetchedAt??Date.now()).getTime()+8*3600000).toISOString();
  const today=local.slice(11,19)>='16:05:00'?local.slice(0,10):new Date(new Date(local).getTime()-86400000).toISOString().slice(0,10);
  const adjustment=corporateAdjustment(record,quote.bars,quote.corporateSource,local.slice(0,10),today);
  let history:Adjustment[]=[];try{const old=JSON.parse(record.market_data??'{}');history=old.adjustment_history??[];if(old.adjustment&&(old.adjustment.anchor!==adjustment.anchor||old.adjustment.status!==adjustment.status))history=[...history,old.adjustment].slice(-20);}catch{}
  const {corporateSource,...rest}=quote;
  const factorRows=corporateSource?.factors.filter(f=>f.date<=adjustment.anchor).sort((a,b)=>a.date.localeCompare(b.date))??[];
  const prior=factorRows.filter(f=>f.date<=record.buy_time.slice(0,10)).at(-1);
  let previousSource=null;try{previousSource=JSON.parse(record.market_data??'{}').adjustment_source??null;}catch{}
  const source=adjustment.frozen&&local.slice(0,10)>([...window].at(-1)??local.slice(0,10))?previousSource:corporateSource?{...corporateSource,factors:factorRows.filter(f=>f===prior||f.date>record.buy_time.slice(0,10)),qfq:corporateSource.qfq.filter(b=>(window.has(b.date)||b.date===record.buy_time.slice(0,10))&&b.date<=adjustment.anchor)}:null;
  return {...rest,bars,validation:quote.validation.filter(v=>window.has(v.date)),adjustment,adjustment_history:history,adjustment_source:source};
}

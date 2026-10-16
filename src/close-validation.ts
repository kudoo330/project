import type {Bar,RecordRow} from './types';
import dates from './calendar.json';
export function afterBuyWindow(record:RecordRow){const i=dates.indexOf(record.buy_time.slice(0,10));return i<0||record.symbol.endsWith('.BJ')?[]:dates.slice(i+1,i+11);}
export function compareCloses(primary:Bar[],secondary:Bar[],checkedAt:string){
  const other=new Map(secondary.map(b=>[b.date,b])),bars:Bar[]=[],validation=[];
  for(const b of primary){const second=other.get(b.date),matched=Boolean(second&&b.close>0&&second.close>0&&Math.abs(b.close-second.close)<1e-8);validation.push({date:b.date,status:matched?'matched':second?'mismatch':'secondary_missing',primaryClose:b.close,secondaryClose:second?.close??null});if(matched)bars.push({...b,crossCheck:{status:'matched',sources:['东方财富','腾讯'],checkedAt}});}
  return {bars,validation};
}
export function mergeCloseWindow<T extends {bars:Bar[];validation:{date:string;status:string}[]}>(record:RecordRow,quote:T){
  const window=new Set(afterBuyWindow(record));let old:Bar[]=[];try{old=JSON.parse(record.market_data??'{}').bars??[];}catch{}
  const merged=new Map(old.map(b=>[b.date,b]));for(const bar of quote.bars)if(window.has(bar.date))merged.set(bar.date,bar);
  return {...quote,bars:[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date)),validation:quote.validation.filter(v=>window.has(v.date))};
}

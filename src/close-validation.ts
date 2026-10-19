import type {Bar,RecordRow} from './types';
import {corporateAdjustment,type CorporateSource,type Adjustment} from './corporate-actions';
import {afterBuyWindow,collectionWindow} from './observation-window';
export {afterBuyWindow,collectionWindow};
export function compareCloses(primary:Bar[],secondary:Bar[],checkedAt:string,sources=['东方财富','腾讯']){
  const other=new Map(secondary.map(b=>[b.date,b])),bars:Bar[]=[],validation=[];
  for(const b of primary){const second=other.get(b.date),matched=Boolean(second&&b.close>0&&second.close>0&&Math.abs(b.close-second.close)<1e-8);validation.push({date:b.date,status:matched?'matched':second?'mismatch':'secondary_missing',primaryClose:b.close,secondaryClose:second?.close??null});if(matched)bars.push({...b,crossCheck:{status:'matched',sources,checkedAt}});}
  return {bars,validation};
}
export function mergeCloseWindow<T extends {bars:Bar[];validation:{date:string;status:string;primaryClose?:number}[];fetchedAt?:string;corporateSource?:CorporateSource}>(record:RecordRow,quote:T){
  const window=new Set(collectionWindow(record));let old:Bar[]=[];try{old=JSON.parse(record.market_data??'{}').bars??[];}catch{}
  let priorConflicts=new Set<string>();try{priorConflicts=new Set((JSON.parse(record.market_data??'{}').validation??[]).filter((v:any)=>v.status==='mismatch').map((v:any)=>v.date));}catch{}
  const oldByDate=new Map(old.map(b=>[b.date,b]));
  const validation=quote.validation.filter(v=>window.has(v.date)).map(v=>{
    const b=oldByDate.get(v.date);
    if(v.status==='secondary_missing'&&priorConflicts.has(v.date))return {...v,status:'mismatch',retainedPreviousConflict:true};
    // A missing secondary response is not new contrary price evidence. Keep the
    // historical verification only when the primary still agrees with it.
    if(v.status==='secondary_missing'&&!priorConflicts.has(v.date)&&b?.crossCheck?.status==='matched'&&v.primaryClose===b.close){
      return {...v,status:'matched',secondaryClose:b.close,checkedAt:b.crossCheck.checkedAt,retainedPreviousVerification:true};
    }
    return v;
  });
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
  return {...rest,bars,validation,adjustment,adjustment_history:history,adjustment_source:source};
}

export function verifiedCloseDates(data:{bars:Bar[];validation:{date:string;status:string}[]}){
  const invalid=new Set(data.validation.filter(v=>v.status!=='matched').map(v=>v.date));
  return new Set(data.bars.filter(b=>b.close>0&&b.crossCheck?.status==='matched'&&!invalid.has(b.date)).map(b=>b.date));
}

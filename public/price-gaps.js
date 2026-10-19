// Count missing prices only; transport errors and unknown future calendars are separate.
export function hasPriceGap(record,now=new Date()){
  const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
  const base=record.actual_price??record.reference_price??record.tracking?.rawBase??record.tracking?.base;
  if(!positive(base))return true;
  const local=new Date(now.getTime()+8*3600000).toISOString();
  const cutoff=local.slice(11,19)>='16:05:00'?local.slice(0,10):new Date(now.getTime()+8*3600000-86400000).toISOString().slice(0,10);
  return (record.tracking?.window??[]).some(day=>day.state!=='停牌'&&day.date&&day.date<=cutoff&&!positive(day.rawClose??day.close));
}

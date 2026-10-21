// Display the same calculation price used by tracking; raw prices remain in details.
export function observationPrice(day){
  if(day.state==='停牌'||typeof day.close!=='number'||!Number.isFinite(day.close)||day.close<=0)return null;
  const adjusted=typeof day.rawClose==='number'&&Math.abs(day.close-day.rawClose)>1e-8;
  return {text:`${adjusted?'复权':'收盘'} ¥${day.close.toFixed(2)}`,title:adjusted?`计算用收盘价；原始收盘价 ¥${day.rawClose.toFixed(2)}`:'计算用收盘价（与原始收盘价一致）'};
}

const DAYS={'1m':1,'5m':3,'15m':5,'30m':10,'60m':20,'1d':252};
export function defaultChartRange(rows,timeframe){
 if(!rows.length)return null;
 let last=rows.length-1;while(last>0&&rows[last]._valid===false)last--;
 const day=rows[last].trading_date;while(last+1<rows.length&&rows[last+1].trading_date===day)last++;
 let first=last,days=1;
 while(first>0){if(rows[first-1].trading_date!==rows[first].trading_date&&++days>(DAYS[timeframe]||1))break;first--;}
 return {from:first-.5,to:last+.5};
}
export function boundedChartRange(range,total){
 if(!total)return null;
 const width=Math.min(total,Math.max(Math.min(12,total),range.to-range.from));
 const from=Math.max(-.5,Math.min(total-width-.5,range.from));return {from,to:from+width};
}
export function zoomChartRange(range,total,factor){
 if(!range||!total)return null;
 const center=(range.from+range.to)/2,width=(range.to-range.from)*factor;
 return boundedChartRange({from:center-width/2,to:center+width/2},total);
}

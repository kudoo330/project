const DAYS={'1m':1,'5m':3,'15m':5,'30m':10,'60m':20,'1d':252};
export function chartRangeAtDate(rows,timeframe,date){
 if(!rows.length)return null;
 const days=[],starts=[];
 for(let i=0;i<rows.length;i++)if(rows[i].trading_date!==days.at(-1)){days.push(rows[i].trading_date);starts.push(i);}
 let anchor=days.findIndex(day=>day>=date);if(anchor<0)anchor=days.length-1;
 const count=Math.min(days.length,DAYS[timeframe]||1),first=Math.max(0,Math.min(days.length-count,anchor-Math.floor(count/2))),last=first+count;
 return {from:starts[first]-.5,to:(last<starts.length?starts[last]:rows.length)-.5};
}
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

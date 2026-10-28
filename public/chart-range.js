/** Join transport chunks into one chart; callers never expose paging as navigation. */
export function expandChartPage(page){
 if(!page.bar_columns)return page;
 const bars=page.bar_rows.map(values=>{const row=Object.fromEntries(page.bar_columns.map((key,i)=>[key,values[i]]));row.source_note=page.source_notes[row.source_note_index]||'';delete row.source_note_index;return {...row,time:page.timeframe==='1d'?row.trading_date:row.time_utc,interval_start_utc:row.time_utc,interval_end_utc:row.end_utc,timeframe:page.timeframe,source_revision:page.dataset.revision,is_final:true};});
 const {bar_columns,bar_rows,source_notes,...metadata}=page;return {...metadata,bars};
}
export async function loadChartRange(fetchPage,params,{signal,onProgress}={}){
 const query=new URLSearchParams(params);query.set('continuous','1');query.delete('cursor');
 let result=null,cursor=null;const visited=new Set(),warnings=new Set(),bars=[];
 do{
  signal?.throwIfAborted();if(cursor)query.set('cursor',cursor);
  const page=expandChartPage(await fetchPage(query,signal));signal?.throwIfAborted();
  if(result&&(result.dataset.id!==page.dataset.id||result.dataset.revision!==page.dataset.revision||result.snapshotId!==page.snapshotId))throw new Error('读取期间行情版本发生变化，请重新载入。');
  if(!result)result={...page,bars:[],coverage:{...page.coverage},range:{...page.range}};
  else for(const key of ['expected_minutes','available_minutes','missing_minutes','no_eligible_minutes','unknown_volume_minutes','trading_days','incomplete_bars','excluded_rows','unclosed_windows'])result.coverage[key]=(result.coverage[key]||0)+(page.coverage[key]||0);
  bars.push(...page.bars);for(const warning of page.warnings||[])warnings.add(warning);
  result.range.page_end=page.range.page_end;onProgress?.({through:page.range.page_end,bars:bars.length});cursor=page.next_cursor;
  if(cursor){if(visited.has(cursor)||cursor<=page.range.page_start)throw new Error('行情连续载入失败，请重试。');visited.add(cursor);}
 }while(cursor);
 const c=result.coverage;c.percent=c.expected_minutes?Math.round((c.available_minutes+c.no_eligible_minutes)/c.expected_minutes*10000)/100:null;c.price_percent=c.expected_minutes?Math.round(c.available_minutes/c.expected_minutes*10000)/100:null;c.status=!c.expected_minutes?'unassessed':c.incomplete_bars?'partial':'complete';
 result.bars=bars;result.warnings=[...warnings];result.next_cursor=null;return result;
}

import {createResearchChart} from './research-chart.js';


const $=selector=>document.querySelector(selector);
const QUALITY={available:'可用',partial:'不完整',missing:'行情缺失',not_entitled:'权限不足',request_failed:'获取失败',no_eligible_trade:'来源确认无合格成交'};
const state={datasets:[],timeframe:'1m',zone:'America/New_York',chart:null,chartData:null,chartGeneration:0,chartBusy:false,chartPages:[null],chartPage:0};
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el;};
function message(selector,text,error=false){const el=$(selector);el.textContent=text;el.classList.toggle('research-error',error);}
function displayTime(value,zone=state.zone){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date):'—';}
function dateInNY(value){if(/^\d{4}-\d{2}-\d{2}$/.test(value||''))return value;const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
function theme(){try{return localStorage.getItem('theme')==='dark'?'dark':'light';}catch{return 'light';}}
document.documentElement.dataset.theme=theme();
$('#research-theme').onclick=()=>{const value=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=value;try{localStorage.setItem('theme',value);}catch{}state.chart?.setTheme(value);};
async function api(path){const response=await fetch(path,{cache:'no-store'}),result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'读取失败'),{status:response.status});return result;
}
function populateDatasets(chooseDates=false){
  const old=$('#research-dataset').value,base=state.timeframe==='1d'?'1d':'1m',matches=state.datasets.filter(dataset=>dataset.symbol===$('#research-symbol').value&&dataset.period===base),select=$('#research-dataset');select.replaceChildren();
  if(!matches.length)select.append(new Option('此标的 / 周期暂无已载入行情',''));
  for(const dataset of matches)select.append(new Option(`${dataset.provider} · ${dataset.adjustment==='forward'?'前复权 '+dataset.adjustment_as_of:'不复权'}`,dataset.id));
  // Primary AMD minute source is Alpaca SIP; Longbridge is retained only for validation.
  const primary=base==='1m'?matches.find(d=>/^Alpaca\s*·\s*SIP/i.test(d.provider)&&d.adjustment==='none'):null;
  if(matches.some(dataset=>dataset.id===old))select.value=old;
  else if(primary)select.value=primary.id;
  if(chooseDates&&matches.length){const dataset=matches.find(d=>d.id===select.value),start=dateInNY(dataset.first_time),end=dateInNY(dataset.last_time);if(start&&end){$('#research-start').value=start;$('#research-end').value=end;}}
  $('#research-chart-title').textContent=$('#research-symbol').value.replace('.US','');
  const inventories=state.datasets.filter(d=>d.symbol===$('#research-symbol').value);$('#research-history-note').textContent=inventories.map(d=>`${d.period==='1d'?'日线':'1分钟线'}已载入 ${dateInNY(d.first_time)} 至 ${dateInNY(d.last_time)}，${d.row_count} 条（${d.provider}）`).join('；')+'。仅表示已保存的覆盖范围，窗口内缺价另行标明。';
}
function chartParams(cursor){const id=$('#research-dataset').value,start=$('#research-start').value,end=$('#research-end').value,sessions=[...document.querySelectorAll('[name=session]:checked')].map(input=>input.value);if(!start||!end||start>end)throw new Error('请选择有效的起止日期。');if(state.timeframe!=='1d'&&!sessions.length)throw new Error('请至少选择一个交易时段。');const params=new URLSearchParams({dataset_id:id,start,end,timeframe:state.timeframe,sessions:state.timeframe==='1d'?'regular':sessions.join(',')});if(cursor)params.set('cursor',cursor);return params;}
function noChart(text){state.chartBusy=false;$('#research-load').disabled=false;state.chartData=null;state.chart?.setData({bars:[],timeframe:state.timeframe,timeZone:state.zone});$('#research-chart-empty').hidden=false;$('#research-coverage').textContent='—';message('#research-chart-status',text);$('#research-source').textContent='尚无可用行情来源';$('#research-quality-message').textContent='缺失的行情继续留空；取得行情后可手动导入。';$('#research-quality-summary').textContent='数据覆盖与来源说明';$('#research-gaps-table tbody').replaceChildren();$('#research-chart-next').disabled=true;$('#research-chart-prev').disabled=true;}
async function loadChart(reset=true,targetPage=0,options={}){
  const generation=++state.chartGeneration;if(reset){state.chartPages=[null];state.chartPage=0;targetPage=0;}
  if(!$('#research-dataset').value){noChart('尚未载入此标的的行情。可通过历史行情入口补齐价格。');return;}
  let params;try{params=chartParams(state.chartPages[targetPage]);if(options.start){params.set('start',options.start);params.set('end',options.end||options.start);params.delete('cursor');}}catch(error){message('#research-chart-status',error.message,true);return;}
  state.chartBusy=true;$('#research-load').disabled=true;$('#research-chart-prev').disabled=true;$('#research-chart-next').disabled=true;message('#research-chart-status','正在读取所选日期行情…');
  try{const result=await api('/api/research/chart?'+params);if(generation!==state.chartGeneration)return;state.chartData=result;state.chartPage=targetPage;if(result.next_cursor)state.chartPages[targetPage+1]=result.next_cursor;else state.chartPages.splice(targetPage+1);
    state.chart?.setData({...result,timeZone:state.zone,resetView:true,markers:[],groups:[]});renderChartQuality(result);$('#research-chart-empty').hidden=result.bars.some(bar=>bar.open!==null&&bar.open!==undefined);
    if(options.focus)state.chart?.focusTime(options.focus);
  }catch(error){if(generation===state.chartGeneration){noChart(error.message);message('#research-chart-status',error.message,true);}}
  finally{if(generation===state.chartGeneration){state.chartBusy=false;$('#research-load').disabled=false;$('#research-chart-prev').disabled=state.chartPage===0;$('#research-chart-next').disabled=!state.chartData?.next_cursor;}}
}
function renderChartQuality(result){
  const d=result.dataset,c=result.coverage||{},range=result.range||{};
  $('#research-source').textContent=`${d.provider} · ${d.adjustment==='forward'?'前复权，截至 '+d.adjustment_as_of:'不复权'} · 版本 ${d.revision} · ${d.period==='1d'?'独立日线':'1 分钟源数据'}`;
  $('#research-coverage').textContent=typeof c.percent==='number'?c.percent.toFixed(1)+'%':'—';
  message('#research-chart-status',`当前窗口 ${range.page_start||range.start} — ${range.page_end||range.end} · ${result.bars.length} 根 K 线${result.next_cursor?' · 后续日期可继续载入':''}`);
  $('#research-quality-summary').textContent=`数据覆盖 ${typeof c.percent==='number'?c.percent.toFixed(1)+'%':'未评估'} · 缺失 ${c.missing_minutes??'—'}${state.timeframe==='1d'?' 日':' 分钟'} · 查看原因`;
  $('#research-quality-message').textContent=[...(result.warnings||[]),`来源：${d.provider}；复权方式：${d.adjustment==='forward'?'前复权 '+d.adjustment_as_of:'不复权'}。部分窗口只展示已取得的价格，不补零或延用前价。`,...new Set(result.bars.map(bar=>bar.source_note).filter(Boolean))].join('\n');
  const tbody=$('#research-gaps-table tbody');tbody.replaceChildren();const gaps=result.bars.filter(bar=>bar.status!=='available'||bar.short_window);
  for(const bar of gaps.slice(0,200)){const tr=node('tr');tr.append(node('td',state.timeframe==='1d'?bar.trading_date:displayTime(bar.time_utc)),node('td',(QUALITY[bar.status]||bar.status)+(bar.short_window?' · 短窗口':'')),node('td',bar.reason||'会话结束前的短窗口'));tbody.append(tr);}
  if(!gaps.length){const tr=node('tr'),td=node('td','当前窗口没有已知缺失。完整度仅针对所选来源与时间窗口。');td.colSpan=3;tr.append(td);tbody.append(tr);}else if(gaps.length>200){const tr=node('tr'),td=node('td',`当前列出前 200 个异常窗口，共 ${gaps.length} 个。可缩小日期范围查看。`);td.colSpan=3;tr.append(td);tbody.append(tr);}
}
$('#research-controls').onsubmit=event=>{event.preventDefault();loadChart();};
$('#research-symbol').onchange=()=>{populateDatasets();loadChart();};
$('#research-dataset').onchange=()=>loadChart();
for(const input of document.querySelectorAll('[name=session]'))input.onchange=()=>loadChart();
for(const control of document.querySelectorAll('[data-timeframe]'))control.onclick=()=>{state.timeframe=control.dataset.timeframe;for(const el of document.querySelectorAll('[data-timeframe]')){const active=el===control;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));}for(const el of document.querySelectorAll('[name=session]'))el.disabled=state.timeframe==='1d';populateDatasets();loadChart();};
$('#research-timezone').onchange=()=>{state.zone=$('#research-timezone').value;state.chart?.setTimezone(state.zone);$('#research-zone-label').textContent='图表时区：'+(state.zone==='Asia/Shanghai'?'北京时间':'美东时间');$('#research-goto-label').firstChild.textContent='定位时间（'+(state.zone==='Asia/Shanghai'?'北京':'美东')+'）';if(state.chartData)renderChartQuality(state.chartData);};
$('#research-one-year').onclick=()=>{const ds=state.datasets.find(d=>d.id===$('#research-dataset').value&&d.period==='1d')||state.datasets.find(d=>d.symbol===$('#research-symbol').value&&d.period==='1d');if(!ds){message('#research-chart-status','此标的暂无已载入日线。',true);return;}const end=dateInNY(ds.last_time),start=new Date(end+'T12:00:00Z');start.setUTCFullYear(start.getUTCFullYear()-1);start.setUTCDate(start.getUTCDate()+1);$('#research-start').value=start.toISOString().slice(0,10);$('#research-end').value=end;document.querySelector('[data-timeframe="1d"]').click();};
$('#research-reset').onclick=()=>state.chart?.reset();$('#research-chart-prev').onclick=()=>loadChart(false,state.chartPage-1);$('#research-chart-next').onclick=()=>loadChart(false,state.chartPage+1);
function localInstant(value,zone){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('请填写要定位的日期和时间。');
  const target=Date.parse(value+':00Z'),formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),candidates=[];
  for(let offset=-12;offset<=14;offset++){const candidate=target-offset*3600000;if(formatter.format(new Date(candidate)).replace(' ','T')===value)candidates.push(candidate);}
  if(candidates.length!==1)throw new Error(candidates.length?'该时间位于夏令时重复时段，请切换图表时区后定位。':'该本地时间不存在，请检查夏令时切换。');return new Date(candidates[0]).toISOString();
}
$('#research-goto-form').onsubmit=async event=>{event.preventDefault();try{const time=localInstant($('#research-goto').value,state.zone);if(!state.chart?.focusTime(time))await loadChart(true,0,{start:dateInNY(time),focus:time});message('#research-chart-status',state.chart?.focusTime(time)?'已定位到 '+displayTime(time):'此时点暂无可定位行情，价格仍保留为空。');}catch(error){message('#research-chart-status',error.message,true);}};


async function init(){try{const user=await api('/api/me');if(user.role!=='admin')throw new Error('此页面仅供管理员使用');$('#research-user').textContent=user.username+' · 管理员';$('#research-access').hidden=true;$('#research-content').hidden=false;state.chart=createResearchChart($('#research-chart'),{detailElement:$('#research-chart-detail')});state.chart.setTheme(theme());const data=await api('/api/research-data/datasets');state.datasets=data.datasets||[];populateDatasets(true);await loadChart();}catch(error){message('#research-access',error.message,true);$('#research-access').hidden=false;}}
init();

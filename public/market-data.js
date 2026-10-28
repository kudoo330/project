const $ = selector => document.querySelector(selector);
const MAX_BYTES = 800000;
const CSV_FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume', 'status', 'reason'];
const CSV_METADATA = ['symbol', 'period', 'provider', 'adjustment', 'adjustment_as_of', 'time_zone', 'currency', 'source_note', 'verification'];
const STATUS = {available:'价格有效', missing:'缺少价格', not_entitled:'权限不足', request_failed:'请求失败', no_eligible_trade:'来源确认无合格成交'};
const ACTION = {insert:'新增', fill:'补齐', unchanged:'相同，跳过', conflict:'价格冲突', blocked:'禁止覆盖有效价格'};
const state = {admin:false, busy:false, version:0, preview:null, payload:null, requestId:null, maxRows:500, datasets:[], cursor:null, pages:[null], page:0, browseVersion:0, browsing:false};

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function textValue(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
function notify(id, value, error=false) { $(id).textContent=value; $(id).classList.toggle('market-error',error); }
function readTheme() { try{return localStorage.getItem('theme') || 'light';}catch{return 'light';} }
document.documentElement.dataset.theme=readTheme();
$('#market-theme').onclick=()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('theme',theme);}catch{}};

async function api(path, payload) {
  const body=payload===undefined?undefined:JSON.stringify(payload);
  if(body && new TextEncoder().encode(body).length>MAX_BYTES)throw new Error('加上来源与请求信息后超过 800 KB，请拆分为更小批次。');
  const response=await fetch('/api/research-data'+path, payload===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body});
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('服务返回格式异常，请稍后重试。'),{status:response.status});}
  if(!response.ok) throw Object.assign(new Error(data.error || data.message || '请求失败，请重试。'),{status:response.status,data});
  return data;
}
function clearPreview(message='输入已变化，请重新预览。') {
  state.version++;state.preview=null;state.payload=null;state.requestId=null;
  $('#market-preview-section').hidden=true;$('#market-replace').checked=false;$('#market-replace-reason').value='';
  if(message)notify('#market-import-message',message);
  syncCommit();
}
function updatePeriod() {
  $('#market-time-help').textContent=$('#market-period').value==='1m'
    ?'1 分钟 time 必须是分钟开始时间，并带明确时区，例如 2026-10-27T09:30:00-04:00 或 UTC 的 Z。秒数须为 00；不同季节请使用实际美东偏移。夜盘按实际美东日历日期保留，不自动归入下一交易日。价格单位为美元。'
    :'日线 time 使用数据源标明的纽约交易日 YYYY-MM-DD，例如 2026-10-27。只导入已收盘日线，价格单位为美元。当天日线目前按美东 16:00 校验，尚未核实提前收市日期。';
  const forward=$('#market-adjustment').value==='forward';
  $('#market-adjustment-date-label').hidden=!forward;$('#market-adjustment-date').required=forward;
}
function syncCommit() {
  const preview=state.preview,counts=preview?.counts || {};
  const replacementReady=!Number(counts.conflict) || ($('#market-replace').checked && $('#market-replace-reason').value.trim().length>0);
  $('#market-commit').disabled=state.busy || !state.admin || !preview?.valid || !preview.preview_token || Number(counts.blocked)>0 || !replacementReady;
}
function busy(value) {
  state.busy=value;$('#market-inputs').disabled=value;$('#market-conflict-controls').disabled=value;
  $('#market-preview').textContent=value?'处理中…':'预览 / 校验';$('#market-commit').textContent=value?'正在处理…':'确认导入';syncCommit();
}
$('#market-form').addEventListener('input',()=>{clearPreview();updatePeriod();});
$('#market-form').addEventListener('change',event=>{if(event.target.id!=='market-file'){clearPreview();updatePeriod();}});
$('#market-replace').addEventListener('change',syncCommit);$('#market-replace-reason').addEventListener('input',syncCommit);
$('#market-paste').addEventListener('input',()=>{$('#market-file').value='';});
$('#market-clear').onclick=()=>{$('#market-paste').value='';$('#market-file').value='';clearPreview('已清空待导入内容。');};

function download(filename, body, type) {
  const url=URL.createObjectURL(body instanceof Blob?body:new Blob([body],{type}));
  const a=node('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('#market-template').onclick=()=>download('historical-market-data-template.csv','\uFEFF'+CSV_FIELDS.join(',')+'\r\n','text/csv;charset=utf-8');

function parseCSV(input) {
  const rows=[];let row=[],field='',quoted=false,afterQuote=false;
  const pushField=()=>{row.push(field);field='';afterQuote=false;};
  const pushRow=()=>{pushField();if(row.some(cell=>cell.trim()!==''))rows.push(row);row=[];};
  for(let i=0;i<input.length;i++){
    const char=input[i];
    if(quoted){if(char==='"'){if(input[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;}}else field+=char;continue;}
    if(afterQuote && char!==',' && char!=='\r' && char!=='\n')throw new Error('CSV 引号结束后只能紧接逗号或换行。');
    if(char==='"'){if(field!=='')throw new Error('CSV 引号须位于字段开头。');quoted=true;}
    else if(char===',')pushField();
    else if(char==='\n'||char==='\r'){if(char==='\r'&&input[i+1]==='\n')i++;pushRow();}
    else field+=char;
  }
  if(quoted)throw new Error('CSV 存在未闭合的引号。');
  if(field!==''||row.length||afterQuote)pushRow();
  if(rows.length<2)throw new Error('CSV 需要表头和至少一行数据。');
  const headers=rows.shift().map(x=>x.trim().toLowerCase());
  if(new Set(headers).size!==headers.length)throw new Error('CSV 表头存在重复字段。');
  const missing=CSV_FIELDS.filter(key=>!headers.includes(key));
  if(missing.length)throw new Error('CSV 缺少表头：'+missing.join(', '));
  if(headers.some(key=>![...CSV_FIELDS,...CSV_METADATA].includes(key)))throw new Error('CSV 含未识别表头，请使用模板或本站导出的 CSV。');
  const parsed=rows.map((cells,index)=>{if(cells.length!==headers.length)throw new Error(`CSV 第 ${index+2} 行字段数量与表头不一致。`);return Object.fromEntries(headers.map((key,i)=>[key,cells[i].trim()]));});
  if(headers.some(key=>CSV_METADATA.includes(key))){
    if(CSV_METADATA.some(key=>!headers.includes(key)))throw new Error('扩展 CSV 须保留本站导出的全部来源字段，避免混淆股票或复权方式。');
    for(const key of CSV_METADATA)if(parsed.some(row=>row[key]!==parsed[0][key]))throw new Error(`扩展 CSV 的 ${key} 不一致，请按相同来源信息分批导入。`);
    const metadata=parsed[0];
    if(!['unverified','manual_unverified'].includes(metadata.verification))throw new Error('本入口仅接受未独立交叉验证的用户导入数据。');
    setJSONMetadata({dataset:Object.fromEntries(CSV_METADATA.filter(key=>!['source_note','verification'].includes(key)).map(key=>[key,metadata[key]])),source_note:metadata.source_note});
  }
  return parsed;
}
function setJSONMetadata(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return;
  if(Object.hasOwn(value,'dataset')){
    const d=value.dataset;
    if(!d || typeof d!=='object' || Array.isArray(d))throw new Error('dataset 必须为对象。');
    if(Object.hasOwn(d,'currency')&&d.currency!=='USD')throw new Error('此入口只接受 USD 计价数据，不能自动换算币种。');
    if(Object.hasOwn(d,'time_zone')&&d.time_zone!=='America/New_York')throw new Error('dataset.time_zone 必须为 America/New_York；分钟时间仍需带明确 UTC 偏移。');
    for(const [key,id] of Object.entries({symbol:'market-symbol',period:'market-period',provider:'market-provider',adjustment:'market-adjustment',adjustment_as_of:'market-adjustment-date'})){
      if(Object.hasOwn(d,key)&&d[key]!==null&&typeof d[key]!=='string')throw new Error(`dataset.${key} 必须是文本。`);
      if(Object.hasOwn(d,key))$('#'+id).value=d[key]??'';
    }
  }
  if(Object.hasOwn(value,'source_note')&&typeof value.source_note!=='string')throw new Error('source_note 必须是文本。');
  if(Object.hasOwn(value,'source_note'))$('#market-source-note').value=value.source_note??'';
  updatePeriod();
}
function parseInput(input) {
  if(new TextEncoder().encode(input).length>MAX_BYTES)throw new Error('待导入内容超过 800 KB，请分批处理。');
  const source=input.replace(/^\uFEFF/,'').trim();if(!source)throw new Error('请先上传或粘贴待导入数据。');
  let rows;
  if(source.startsWith('[')||source.startsWith('{')){
    let value;try{value=JSON.parse(source);}catch{throw new Error('JSON 格式不正确，请检查逗号、引号及括号。');}
    if(Array.isArray(value))rows=value;
    else{if(!value || !Array.isArray(value.rows))throw new Error('JSON 对象须包含 rows 数组。');setJSONMetadata(value);rows=value.rows;}
  }else rows=parseCSV(source);
  if(!rows.length || rows.length>state.maxRows)throw new Error(`每批须有 1 至 ${state.maxRows} 行数据。`);
  return rows.map((row,index)=>{
    if(!row || typeof row!=='object' || Array.isArray(row))throw new Error(`第 ${index+1} 行必须是数据对象。`);
    const output={};
    for(const field of CSV_FIELDS)output[field]=row[field]??null;
    output.time=typeof output.time==='string'?output.time.trim():output.time;
    output.status=typeof output.status==='string'?(output.status.trim()||'available'):output.status??'available';
    output.reason=output.reason??'';
    for(const field of ['open','high','low','close','volume'])if(typeof output[field]==='string'&&output[field].trim()==='')output[field]=null;
    return output;
  });
}
function makePayload() {
  const rows=parseInput($('#market-paste').value);
  const dataset={symbol:$('#market-symbol').value,period:$('#market-period').value,provider:$('#market-provider').value.trim(),adjustment:$('#market-adjustment').value,time_zone:'America/New_York',currency:'USD',adjustment_as_of:$('#market-adjustment').value==='forward'?$('#market-adjustment-date').value:null};
  const source_note=$('#market-source-note').value.trim();
  if(!dataset.provider)throw new Error('请填写行情来源。');
  if(!source_note)throw new Error('请填写来源说明。');
  if(dataset.adjustment==='forward'&&!dataset.adjustment_as_of)throw new Error('前复权数据须填写复权截至日期。');
  return {dataset,source_note,rows};
}
$('#market-file').addEventListener('change',async event=>{
  const file=event.target.files?.[0];clearPreview('');if(!file)return;const version=state.version;
  try{if(file.size>MAX_BYTES)throw new Error('文件超过 800 KB，请分批处理。');const text=await file.text();if(version!==state.version)return;$('#market-paste').value=text;if(/^[\s\uFEFF]*\{/.test(text)){try{setJSONMetadata(JSON.parse(text.replace(/^\uFEFF/,'')));}catch{}}
    notify('#market-import-message',`已读取 ${file.name}，请检查来源并预览。`);
  }catch(error){notify('#market-import-message',error.message,true);$('#market-file').value='';}
});

function renderTable(selector, rows, preview=false, period='1m') {
  const table=$(selector),head=node('tr');
  const headers=[period==='1d'?'交易日（美东）':'时间（UTC / 美东）','开盘','最高','最低','收盘','成交量','状态',preview?'操作':'来源','原因'];
  for(const title of headers)head.append(node('th',title));table.querySelector('thead').replaceChildren(head);const tbody=table.querySelector('tbody');tbody.replaceChildren();
  if(!rows.length){const tr=node('tr',undefined,'market-empty'),td=node('td',preview?'本次没有预览行。':'此范围没有已保存的行情。');td.colSpan=headers.length;tr.append(td);tbody.append(tr);return;}
  for(const row of rows){const tr=node('tr'),previous=preview?row.previous_value:null;const time=row.time??row.time_key??'',timeCell=node('td',time,'market-time');
    if(period==='1m'&&time){const date=new Date(time);if(Number.isFinite(date.getTime()))timeCell.append(node('small',date.toLocaleString('zh-CN',{timeZone:'America/New_York',hour12:false})+' 美东'));}
    tr.append(timeCell);for(const key of ['open','high','low','close','volume'])tr.append(node('td',previous?textValue(previous[key])+' → '+textValue(row[key]):textValue(row[key])));
    const currentStatus=STATUS[row.status]||row.status||'状态未知';
    tr.append(node('td',previous?(STATUS[previous.status]||previous.status||'状态未知')+' → '+currentStatus:currentStatus,'market-state '+(Object.hasOwn(STATUS,row.status)?row.status:'')));
    const sourceCell=node('td',preview?(ACTION[row.action]||row.action||'待校验'):row.provider||state.datasets.find(d=>d.id===$('#market-dataset').value)?.provider||'—',preview?'market-action '+(Object.hasOwn(ACTION,row.action)?row.action:''):'market-source');
    if(previous)sourceCell.append(node('small','原来源说明：'+(previous.source_note||'—')));
    if(!preview && row.source_note)sourceCell.append(node('small',row.source_note));tr.append(sourceCell);
    tr.append(node('td',previous?'原原因：'+(previous.reason||'—')+'\n新原因：'+(row.reason||'—'):row.reason||'—','market-reason'));tbody.append(tr);
  }
}
function renderPreview(preview) {
  const counts=preview.counts||{};$('#market-preview-section').hidden=false;
  $('#market-preview-revision').textContent=preview.revision===undefined?'':'预览版本 '+preview.revision;
  $('#market-preview-summary').textContent=`新增 ${counts.insert??0} · 补齐 ${counts.fill??0} · 相同 ${counts.unchanged??0} · 冲突 ${counts.conflict??0} · 缺失 ${counts.missing??0}${counts.blocked?' · 禁止覆盖 '+counts.blocked:''}`;
  const errors=$('#market-preview-errors');errors.replaceChildren();for(const error of preview.errors||[]){const row=error.row===undefined?'':`第 ${error.row} 行：`;errors.append(node('li',row+(error.message||String(error))));}
  if(Number(counts.blocked))errors.append(node('li','部分缺失行会覆盖已有有效价格，已禁止提交。请移除这些行再预览。'));
  $('#market-conflict-controls').hidden=!Number(counts.conflict);$('#market-replace').checked=false;$('#market-replace-reason').value='';
  renderTable('#market-preview-table',preview.rows||[],true,state.payload?.dataset.period||$('#market-period').value);syncCommit();
}
$('#market-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||!state.admin)return;clearPreview('正在校验，预览不会写入行情。');
  try{const payload=makePayload(),version=state.version;busy(true);const preview=await api('/preview',payload);if(version!==state.version)return;
    state.preview=preview;state.payload=payload;state.requestId=crypto.randomUUID();renderPreview(preview);
    const blocked=Number(preview.counts?.blocked)>0;
    notify('#market-import-message',blocked?'存在禁止覆盖的行，请更正后重新预览。':preview.valid?'预览完成，核对后可确认导入。':'发现格式或数据问题，请更正后重新预览。',!preview.valid||blocked);
  }catch(error){notify('#market-import-message',error.message,true);}finally{busy(false);}
});
$('#market-commit').onclick=async()=>{
  syncCommit();if($('#market-commit').disabled)return;
  const payload={...state.payload,preview_token:state.preview.preview_token,expected_revision:state.preview.revision,request_id:state.requestId,replace_conflicts:$('#market-replace').checked,replace_reason:$('#market-replace-reason').value.trim()};
  try{busy(true);const result=await api('/import',payload);if(result.ok===false)throw new Error(result.error||'导入未成功。');const datasetId=result.dataset_id||state.preview.dataset_id;
    clearPreview('');notify('#market-import-message',result.replayed?'这批数据此前已保存，本次未重复导入。':'导入已保存，原 A 股记录保持不变。');
    try{await loadDatasets(datasetId);if(datasetId)await browse(true);}catch(error){notify('#market-library-message','导入已成功，但列表刷新失败：'+error.message,true);}
  }catch(error){if(error.status===409){clearPreview('');notify('#market-import-message',error.message+' 请重新预览后再提交。',true);}else notify('#market-import-message',error.message+' 可重试，重复请求不会重复写入。',true);}finally{busy(false);}
};

function datasetLabel(d) { return `${d.symbol} · ${d.period==='1d'?'日线':'1分钟'} · ${d.provider} · ${d.adjustment==='forward'?'前复权 '+(d.adjustment_as_of||''):'不复权'}`; }
function resetBrowse() {
  state.browseVersion++;state.cursor=null;state.pages=[null];state.page=0;state.browsing=false;
  $('#market-prev').disabled=true;$('#market-next').disabled=true;$('#market-query').disabled=!$('#market-dataset').value;$('#market-page-info').textContent='';
  const d=state.datasets.find(d=>d.id===$('#market-dataset').value);$('#market-export').disabled=!d;
  $('#market-dataset-description').textContent=d?`${datasetLabel(d)} · 已保存 ${d.row_count??'—'} 行 · 有价 ${d.available_count??'—'} 行 · 缺失 ${d.missing_count??'—'} 行。未载入的时段不计入这些行数。`:'';
  renderTable('#market-bars-table',[],false,d?.period);notify('#market-library-message',d?'选择日期后查看已保存行情。':'尚无已导入的数据集。');
}
async function loadDatasets(selectedId) {
  const result=await api('/datasets');state.datasets=result.datasets||[];state.maxRows=Math.min(500,result.capabilities?.max_rows||500);
  const select=$('#market-dataset'),old=selectedId||select.value;select.replaceChildren();
  if(!state.datasets.length)select.append(new Option('暂无已导入数据',''));
  for(const dataset of state.datasets)select.append(new Option(datasetLabel(dataset),dataset.id));
  if(state.datasets.some(d=>d.id===old))select.value=old;resetBrowse();
}
async function browse(reset=false, targetPage=0) {
  const id=$('#market-dataset').value;if(!id||state.browsing)return;
  if(reset){state.pages=[null];state.page=0;targetPage=0;}
  const start=$('#market-browse-start').value,end=$('#market-browse-end').value;
  if(start&&end&&start>end){notify('#market-library-message','开始日期不能晚于结束日期。',true);return;}
  const version=++state.browseVersion,params=new URLSearchParams({dataset_id:id,limit:'200'});
  if(start)params.set('start',start);if(end)params.set('end',end);if(state.pages[targetPage])params.set('cursor',state.pages[targetPage]);
  state.browsing=true;$('#market-query').disabled=true;$('#market-prev').disabled=true;$('#market-next').disabled=true;notify('#market-library-message','正在读取已保存行情…');
  try{const result=await api('/bars?'+params);if(version!==state.browseVersion)return;
    const d=result.dataset||state.datasets.find(d=>d.id===id),bars=result.bars||[];state.page=targetPage;state.cursor=result.next_cursor||null;if(state.cursor)state.pages[targetPage+1]=state.cursor;else state.pages.splice(targetPage+1);
    renderTable('#market-bars-table',bars,false,d?.period);$('#market-page-info').textContent=`第 ${targetPage+1} 页 · 本页 ${bars.length} 行`;
    notify('#market-library-message',bars.length?'显示所选范围内实际保存的行情；缺失记录以“—”显示价格。':'所选范围暂无已保存行情，缺口仍保留。');
  }catch(error){if(version===state.browseVersion)notify('#market-library-message',error.message,true);}finally{if(version===state.browseVersion){state.browsing=false;$('#market-query').disabled=!id;$('#market-prev').disabled=state.page===0;$('#market-next').disabled=!state.cursor;}}
}
$('#market-browse-form').onsubmit=event=>{event.preventDefault();browse(true);};
$('#market-dataset').onchange=resetBrowse;
for(const id of ['market-browse-start','market-browse-end'])$('#'+id).oninput=resetBrowse;
$('#market-prev').onclick=()=>browse(false,state.page-1);$('#market-next').onclick=()=>browse(false,state.page+1);
$('#market-reload').onclick=async()=>{try{$('#market-reload').disabled=true;await loadDatasets();}catch(error){notify('#market-library-message',error.message,true);}finally{$('#market-reload').disabled=false;}};
$('#market-export').onclick=async()=>{
  const id=$('#market-dataset').value;if(!id)return;$('#market-export').disabled=true;
  try{const params=new URLSearchParams({dataset_id:id}),start=$('#market-browse-start').value,end=$('#market-browse-end').value;
    if(start&&end&&start>end)throw new Error('开始日期不能晚于结束日期。');if(start)params.set('start',start);if(end)params.set('end',end);
    const response=await fetch('/api/research-data/export?'+params,{cache:'no-store'});
    if(!response.ok){let data;try{data=await response.json();}catch{data={};}throw new Error(data.error||'导出失败，请重试。');}
    const dataset=state.datasets.find(d=>d.id===id);download(`${dataset?.symbol||'market'}-${dataset?.period||'data'}.csv`,await response.blob(),'text/csv');
    notify('#market-library-message','CSV 已生成，包含此数据集的来源与缺失原因。');
  }catch(error){notify('#market-library-message',error.message,true);}finally{$('#market-export').disabled=!$('#market-dataset').value;}
};

async function init() {
  updatePeriod();renderTable('#market-bars-table',[]);
  try{const response=await fetch('/api/me',{cache:'no-store'});
    if(response.status===401){$('#market-access').replaceChildren(node('span','请先登录后使用此入口。 '));const a=node('a','前往登录');a.href='/';$('#market-access').append(a);return;}
    if(!response.ok)throw new Error('无法检查登录状态，请刷新重试。');const user=await response.json();
    $('#market-identity').textContent=user.username+' · '+(user.role==='admin'?'管理员':'普通用户');
    if(user.role!=='admin'){notify('#market-access','此入口仅供管理员使用。',true);return;}
    state.admin=true;$('#market-access').hidden=true;$('#market-content').hidden=false;await loadDatasets();
  }catch(error){notify(state.admin?'#market-library-message':'#market-access',error.message,true);}
}
init();

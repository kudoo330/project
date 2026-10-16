import {parseCSV} from './csv.js';
import {parseReviewedPaste} from './reviewed-paste.js';
import {chart} from './chart.js';
import {normalizeAnalysisRule,describeAnalysisRule,selectAnalysisSamples} from './analysis-scope.js';
const $=s=>document.querySelector(s),state={user:null,records:[],strategies:[],summary:[],editing:null,ruleStrategy:null,requestId:crypto.randomUUID(),importRows:[],importId:crypto.randomUUID(),csv:null};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=n=>n===null||n===undefined?'—':Number(n).toFixed(2),pct=n=>n===null||n===undefined?'—':`${n>0?'+':''}${fmt(n)}%`,today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const num=n=>n===null||n===undefined?'':String(n);
function quoteEvidence(r){try{return JSON.parse(r.market_data??'{}');}catch{return {};}}
function crossCheckText(r){const v=quoteEvidence(r).validation;if(!v)return '尚未完成逐日交叉核对';return `已通过 ${v.filter(x=>x.status==='matched').length} 个交易日；待核对 ${v.filter(x=>x.status!=='matched').length} 个交易日（D+1至D+10）`;}
// Do not open record/strategy forms before their server-backed options are loaded.
for(const id of ['add','empty-add','import','new-strategy'])$('#'+id).disabled=true;
let messageTimer;
function message(text){$('#message').textContent=text;$('#message').hidden=false;clearTimeout(messageTimer);messageTimer=setTimeout(()=>$('#message').hidden=true,9000);}
async function api(path,options={}){
  const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});let d;
  try{d=await r.json();}catch{throw new Error('服务未返回有效数据，请稍后重试');}
  if(r.status===401){location.replace('/');throw new Error('登录已过期');}
  if(!r.ok){const e=new Error(d.error||'请求失败');e.status=r.status;e.data=d;throw e;}return d;
}
const send=(url,data,method='POST')=>api(url,{method,body:JSON.stringify(data)});
const button=(text,fn,cls='secondary')=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>message(e.message)));return b;};
function strategyOptions(select,empty=false){const current=select.value;select.replaceChildren();if(empty)select.append(new Option('全部策略',''));for(const s of state.strategies.filter(s=>!s.archived||empty))select.append(new Option(s.name+(s.archived?'（已归档）':''),s.id));if(current)select.value=current;}
async function load(){const [r,s,summary,sync]=await Promise.all([api('/api/records'),api('/api/strategies'),api('/api/summary'),api('/api/close-sync')]);state.records=r.records;state.strategies=s;state.summary=summary;strategyOptions($('#filter-strategy'),true);strategyOptions($('#import-strategy'));render();renderStrategies();renderCloseSync(sync);for(const id of ['add','empty-add','import','new-strategy'])$('#'+id).disabled=false;}
function renderCloseSync(data){const target=$('#close-sync-status');if(!target)return;target.replaceChildren(el('p','北京时间每个交易日16:05开始，至23:55每10分钟查漏重试；无需保持网页打开。','muted'));const r=data.latest;if(!r){target.append(el('p','尚无后台执行记录；自动任务需部署生效后等待触发。'));}else{const label={running:'执行中',success:'本次补齐完成',partial:'部分完成 / 待重试',skipped:'本次跳过',failed:'执行失败'}[r.status]||r.status;target.append(el('p',`最近执行：${new Date(r.started_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · ${label}`),el('p',`处理${r.processed}只，成功${r.succeeded}只，失败${r.failed}只，待处理${r.remaining}只。${r.message||''}`,'fine'));}target.append(el('p',`日历覆盖至${data.schedule.calendarEnd}。${data.warning}`,'fine'));}
function filtered(){const strategy=$('#filter-strategy').value,q=$('#filter-search').value.toLowerCase(),start=$('#filter-start').value,end=$('#filter-end').value,status=$('#filter-status').value;return state.records.filter(r=>(!strategy||r.strategy_id===strategy)&&(!q||[r.symbol,r.name,r.tags,r.notes,r.batch_id,r.version].join(' ').toLowerCase().includes(q))&&(!start||r.buy_time.slice(0,10)>=start)&&(!end||r.buy_time.slice(0,10)<=end)&&(!status||r.tracking.status===status));}
function render(){
  const rows=filtered(),stats=$('#stats');stats.replaceChildren();
  const values=[['策略样本数',rows.length,`${new Set(rows.map(r=>r.symbol)).size} 只不重复股票`],['今日新增',rows.filter(r=>new Date(new Date(r.created_at).getTime()+8*3600000).toISOString().slice(0,10)===today()).length,'当前筛选范围'],['10日观察完成',rows.filter(r=>r.tracking.progress===10).length,'D+1至D+10口径已核对'],['待补价 / 异常',rows.filter(r=>r.tracking.base===null||r.error||r.tracking.status==='日历待核实').length,'缺失值不记为0']];
  values.forEach(([title,value,sub])=>{const card=el('div',undefined,'stat');card.append(el('span',title),el('strong',value),el('small',sub));stats.append(card);});
  $('#record-count').textContent=`${rows.length} 个策略样本 · ${new Set(rows.map(r=>r.symbol)).size} 只股票`;
  const headers=['策略 / 版本','股票','买入时间','价格基准',...Array.from({length:11},(_,i)=>i?'D+'+i:'D0'),'观察状态','最大上涨 / 下跌'];
  const header=el('tr');headers.forEach(h=>header.append(el('th',h)));$('#records-table thead').replaceChildren(header);const body=$('#records-table tbody');body.replaceChildren();
  for(const r of rows){const tr=el('tr'),strategy=el('td');strategy.append(el('span',r.strategy_name,'pill'),el('small',r.version||'未指定版本'));tr.append(strategy);const stock=el('td');stock.append(button(r.symbol,()=>detail(r.id),''),el('small',r.name||'名称待查询'));tr.append(stock);const t=el('td',r.buy_time.slice(0,10));t.append(el('small',r.buy_time.slice(11)+' · 上海'));tr.append(t);const price=el('td',fmt(r.tracking.base));price.append(el('small',r.tracking.baseType));tr.append(price);for(const w of r.tracking.window){const td=el('td',pct(w.value),w.value>0?'up':w.value<0?'down':'muted');td.title=`${w.date||'日期待核实'} · ${w.state}`;tr.append(td);}const status=el('td',r.tracking.status);status.append(el('small',r.error?'刷新失败，保留旧数据':r.fetched_at?'更新于 '+new Date(r.fetched_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未获取行情'));tr.append(status,el('td',pct(r.tracking.max)+' / '+pct(r.tracking.min)));body.append(tr);}
  $('#empty').hidden=rows.length>0;$('#records-table').hidden=rows.length===0;
}
for(const id of ['filter-strategy','filter-search','filter-start','filter-end','filter-status'])$('#'+id).addEventListener('input',render);
function openEditor(record=null){
  state.editing=record;state.requestId=crypto.randomUUID();const form=$('#record-form');form.reset();form.querySelector('h2').textContent=record?'修改买入记录':'记录买入';strategyOptions(form.elements.strategies);form.elements.strategies.multiple=!record;
  if(record&&!Array.from(form.elements.strategies.options).some(o=>o.value===record.strategy_id)){const s=state.strategies.find(s=>s.id===record.strategy_id);if(s)form.elements.strategies.append(new Option(s.name+'（已归档）',s.id));}
  if(record){for(const name of ['symbol','actual_price','shares','version','tags','reason','notes'])form.elements[name].value=num(record[name]);form.elements.strategies.value=record.strategy_id;form.elements.date.value=record.buy_time.slice(0,10);form.elements.time.value=record.buy_time.slice(11);}
  else{form.elements.date.value=today();form.elements.time.value='09:47:00';form.elements.strategies.selectedIndex=-1;}
  form.querySelector('.form-error').textContent='';$('#editor').showModal();
}
$('#add').onclick=()=>openEditor();$('#empty-add').onclick=()=>openEditor();
$('#record-form').addEventListener('input',()=>state.requestId=crypto.randomUUID());
async function createRows(rows,id,confirmDuplicates=false){try{return await send('/api/records',{rows,request_id:id,confirm_duplicates:confirmDuplicates});}catch(e){if(e.data?.duplicates&&confirm(e.message+'\n是否确认保留为独立样本？'))return createRows(rows,id,true);throw e;}}
$('#record-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,submit=form.querySelector('[type=submit]');submit.disabled=true;form.querySelector('.form-error').textContent='';
  try{
    const d=Object.fromEntries(new FormData(form)),strategies=[...form.elements.strategies.selectedOptions].map(o=>o.value);if(!strategies.length)throw new Error('请选择策略');
    const row={...d,buy_time:d.date+'T'+d.time};
    if(state.editing)await send('/api/records/'+state.editing.id,{...row,strategy_id:strategies[0],revision:state.editing.revision},'PATCH');
    else await createRows(strategies.map(strategy_id=>({...row,strategy_id})),state.requestId);
    $('#editor').close();await load();message(state.editing?'修改已保存':'记录已保存；可刷新行情。');
  }catch(error){form.querySelector('.form-error').textContent=error.message;}finally{submit.disabled=false;}
});
async function detail(id){
  const r=await api('/api/records/'+id),c=$('#detail-content');c.replaceChildren();const dl=el('dl');
  for(const [k,v]of [['股票',r.symbol+' '+r.name],['买入时点',r.buy_time.replace('T',' ')+' Asia/Shanghai'],['策略',state.strategies.find(s=>s.id===r.strategy_id)?.name],['原始买入价',fmt(r.tracking.rawBase)],['计算用基准',fmt(r.tracking.base)+' · '+r.tracking.baseType],['除权处理',r.tracking.adjustment?(r.tracking.adjustment.reason+' · 截至 '+r.tracking.adjustment.anchor+(r.tracking.adjustment.frozen?' · 已冻结':'')):'尚无自动核对快照'],['提交批次',r.batch_id],['理由',r.reason||'—'],['备注',r.notes||'—'],['数据来源',quoteEvidence(r).provider||'尚未取得行情'],['收盘价交叉核对',crossCheckText(r)],['最近获取',r.fetched_at?new Date(r.fetched_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未获取'],['口径核对至',r.checked_through||'尚未核对'],['状态',r.error||r.tracking.warning]])dl.append(el('dt',k),el('dd',v));c.append(dl);if(r.reference_evidence){const evidence=el('details');evidence.append(el('summary','查看买入参考价来源与原始时间'),el('pre',JSON.stringify({original_time:r.original_time,reference_price:r.reference_price,evidence:JSON.parse(r.reference_evidence)},null,2)));c.append(evidence);}if(r.tracking.adjustment){const evidence=el('details'),summary=el('summary','查看复权因子与历史快照');evidence.append(summary,el('pre',JSON.stringify({current:r.tracking.adjustment,source:quoteEvidence(r).adjustment_source,history:quoteEvidence(r).adjustment_history},null,2)));c.append(evidence);}
  const chartContainer=el('div');c.append(chartContainer);chart(chartContainer,[{name:'累计价格表现（%）',values:r.tracking.window.map(w=>w.value)}],r.tracking.window.map(w=>w.n?'D+'+w.n:'D0'));
  const table=el('table'),head=el('tr');['观察日','日期','原始收盘价','计算用收盘价','累计涨幅','状态'].forEach(s=>head.append(el('th',s)));table.append(head);r.tracking.window.forEach(w=>{const tr=el('tr');[w.n?'D+'+w.n:'D0',w.date||'—',fmt(w.rawClose),fmt(w.close),pct(w.value),w.state].forEach(s=>tr.append(el('td',s)));table.append(tr);});const wrap=el('div',undefined,'table-wrap');wrap.append(table);c.append(wrap);
  const ind=r.tracking.indicators;c.append(el('h3','近期完整日线指标'));c.append(el('p',`MA5 ${fmt(ind.ma5)} · MA10 ${fmt(ind.ma10)} · MA20 ${fmt(ind.ma20)} · 成交量 / 前5日均量 ${fmt(ind.volumeRatio)} · 截至 ${ind.asOf||'无数据'}`,'fine'));
  const minuteContainer=el('div');c.append(button('查看买入日分时（不用于自动定价）',async()=>{
    minuteContainer.textContent='正在读取分钟数据…';try{const d=await api('/api/minute?symbol='+encodeURIComponent(r.symbol)+'&date='+r.buy_time.slice(0,10));minuteContainer.replaceChildren(el('p',d.warning,'notice'));const plot=el('div');minuteContainer.append(plot);chart(plot,[{name:'供应商分时价格',values:d.rows.map(x=>x.close)}],d.rows.map(x=>x.label.slice(11)));minuteContainer.append(el('p',`来源：${d.provider} · ${d.rows.length}条 · 获取：${d.fetchedAt} · ${d.cached?'缓存':'本次请求'}`,'fine'));}catch(e){minuteContainer.textContent=e.message;}
  }),minuteContainer);
  if(state.user.role==='admin'){
    const actions=el('div',undefined,'detail-actions');actions.append(button('修改记录',()=>{$('#detail').close();openEditor(r);}),button('确认公司行动口径',async()=>{
      const date=prompt('仅在你已核对买入至指定日期没有除权除息等口径变化，或已正确调整实际基准后填写。\n确认核对至（YYYY-MM-DD）：',today());if(!date)return;
      await send('/api/records/'+r.id,{revision:r.revision,checked_through:date},'PATCH');await load();await detailReload(r.id);message('已记录你的人工核对日期。');
    }),button('删除记录',async()=>{if(!confirm('确认删除此策略样本？不会删除其他策略或同股票的其他样本。'))return;await send('/api/records/'+r.id,{revision:r.revision},'DELETE');$('#detail').close();await load();message('记录已删除');}));c.append(actions);
  }
  if(!$('#detail').open)$('#detail').showModal();
}
const detailReload=id=>detail(id);
async function refreshRecords(rows,automatic=false){
  if(!rows.length)return;const b=$('#refresh');b.disabled=true;let ok=0,failed=0;
  try{const selected=automatic?rows.slice(0,20):rows;
    for(let i=0;i<selected.length;i+=8){const d=await send('/api/refresh',{ids:selected.slice(i,i+8).map(r=>r.id)});ok+=d.results.filter(r=>r.ok).length;failed+=d.results.filter(r=>!r.ok).length;}
    await load();message(`行情更新：${ok}条成功，${failed}条失败。${automatic&&rows.length>20?'自动更新仅处理最近20条，其余请手动刷新。':''}`);
  }catch(e){message('刷新失败，已保存记录保持不变：'+e.message);}finally{b.disabled=false;}
}
$('#refresh').onclick=()=>refreshRecords(filtered());
function renderStrategies(){
  const wrap=$('#strategy-summary');wrap.replaceChildren(el('h2','D0 至 D+10 样本表现'));const table=el('table'),head=el('tr');['策略 / 样本数',...Array.from({length:11},(_,n)=>n?'D+'+n:'D0')].forEach(s=>head.append(el('th',s)));table.append(head);
  for(const group of state.summary){
    const tr=el('tr'),label=el('td',group.name);label.append(el('small',`原始 ${group.total_samples} · 入选 ${group.samples} · 排除 ${group.excluded_samples} · ${group.unique_stocks}只股票`));label.append(el('small',group.strategy_id==='analysis-all'?'分别应用各策略规则，再合并入选样本':group.rule_description));
    if(!['all','analysis-all'].includes(group.strategy_id))label.append(button('查看入选范围',()=>showAnalysisMembers(group.strategy_id)));tr.append(label);
    for(let n=0;n<11;n++){const d=group.points[n],td=el('td',pct(d.mean));td.append(el('small',`正收益 ${d.positive===null?'—':fmt(d.positive*100)+'%'} · n=${d.count}`));tr.append(td);}table.append(tr);
  }
  const scroll=el('div',undefined,'table-wrap');scroll.append(table);wrap.append(scroll);const management=$('#strategy-management');management.replaceChildren();
  for(const s of state.strategies){const row=el('div',undefined,'strategy-row'),label=el('div',s.name+(s.archived?' · 已归档':''));label.append(el('p',describeAnalysisRule(s.analysis_rule),'fine'));row.append(label);if(state.user.role==='admin'){const actions=el('div',undefined,'actions');actions.append(button('分析范围',()=>openAnalysisRule(s.id)),button('重命名',async()=>{const name=prompt('策略名称',s.name);if(!name)return;await send('/api/strategies/'+s.id,{name},'PATCH');await load();}),button(s.archived?'恢复':'归档',async()=>{await send('/api/strategies/'+s.id,{archived:!s.archived},'PATCH');await load();}));row.append(actions);}management.append(row);}
}
function openAnalysisRule(id){
  const s=state.strategies.find(s=>s.id===id),form=$('#analysis-rule-form');state.ruleStrategy=s;const r=normalizeAnalysisRule(s.analysis_rule);form.reset();$('#analysis-rule-title').textContent=s.name+' · 分析范围';form.elements.first_enabled.checked=r.first_n!==null;form.elements.first_n.value=r.first_n??10;form.elements.before_enabled.checked=r.before_time!==null;form.elements.before_time.value=r.before_time??'13:00:00';form.querySelector('.form-error').textContent='';previewAnalysisRule();$('#analysis-editor').showModal();
}
function ruleFromForm(){const f=$('#analysis-rule-form');return normalizeAnalysisRule({first_n:f.elements.first_enabled.checked?Number(f.elements.first_n.value):null,before_time:f.elements.before_enabled.checked?f.elements.before_time.value:null});}
function previewAnalysisRule(){
  const f=$('#analysis-rule-form');f.elements.first_n.disabled=!f.elements.first_enabled.checked;f.elements.before_time.disabled=!f.elements.before_enabled.checked;
  try{const r=ruleFromForm(),rows=state.records.filter(r=>r.strategy_id===state.ruleStrategy?.id),selected=selectAnalysisSamples(rows,r).selected;$('#analysis-rule-preview').textContent=`${describeAnalysisRule(r)}。当前已加载 ${rows.length} 条，预览入选 ${selected.length} 条、排除 ${rows.length-selected.length} 条。正式统计由服务端使用全部记录计算。`;}catch(e){$('#analysis-rule-preview').textContent=e.message;}
}
$('#analysis-rule-form').addEventListener('input',previewAnalysisRule);
$('#analysis-rule-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;f.querySelector('.form-error').textContent='';try{await send('/api/strategies/'+state.ruleStrategy.id+'/analysis-rule',{rule:ruleFromForm(),revision:state.ruleStrategy.analysis_revision},'PATCH');$('#analysis-editor').close();await load();message('分析范围已保存，策略统计已重算；原始记录全部保留。');}catch(e){f.querySelector('.form-error').textContent=e.message;}finally{b.disabled=false;}});
$('#analysis-reset').onclick=()=>{const f=$('#analysis-rule-form');f.elements.first_enabled.checked=false;f.elements.before_enabled.checked=false;previewAnalysisRule();};
function showAnalysisMembers(id){
  const s=state.strategies.find(s=>s.id===id),rows=state.records.filter(r=>r.strategy_id===id),{decisions}=selectAnalysisSamples(rows,s.analysis_rule),group=state.summary.find(g=>g.strategy_id===id),content=$('#analysis-members-content');content.replaceChildren(el('h2',s.name+' · 入选明细'),el('p',describeAnalysisRule(s.analysis_rule),'notice'),el('p',`服务端总计：${group.total_samples} 条原始样本，入选 ${group.samples} 条，排除 ${group.excluded_samples} 条。下表展示当前已加载的 ${rows.length} 条。`,'fine'));
  const selected=new Set(group.selected_ids),table=el('table'),head=el('tr');['股票','买入时间（上海）','价格状态','分析范围'].forEach(h=>head.append(el('th',h)));table.append(head);rows.slice().sort((a,b)=>a.buy_time.localeCompare(b.buy_time)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).forEach(r=>{const tr=el('tr');[r.symbol+' '+r.name,r.buy_time.replace('T',' '),r.tracking.baseType,selected.has(r.id)?'入选':decisions.get(r.id)==='入选'?'未入选（全量排序超出名额）':decisions.get(r.id)].forEach(v=>tr.append(el('td',v)));table.append(tr);});const scroll=el('div',undefined,'table-wrap');scroll.append(table);content.append(scroll);$('#analysis-members').showModal();
}
$('#new-strategy').onclick=async()=>{try{const name=prompt('新策略名称');if(!name)return;await send('/api/strategies',{name});await load();}catch(e){message(e.message);}};
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{document.querySelectorAll('.view').forEach(s=>s.hidden=s.id!==b.dataset.view);document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));$('#breadcrumb').textContent='研究工作台 / '+b.textContent.trim().slice(1).trim();};
for(const b of document.querySelectorAll('dialog .close'))b.onclick=()=>b.closest('dialog').close();
$('#logout').onclick=async()=>{try{await send('/api/logout',{});location.replace('/');}catch(e){message(e.message);}};
$('#theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';localStorage.setItem('theme',document.documentElement.dataset.theme);};
document.documentElement.dataset.theme=localStorage.getItem('theme')||'light';
// Import preview and field mapping. Only device preferences use local storage.
const fields={symbol:'股票代码',date:'买入日期',time:'买入时间',strategy:'策略名称',version:'策略版本',name:'股票名称',actual_price:'实际成交价',shares:'股数',reason:'买入理由',tags:'标签',notes:'备注'};
$('#import').onclick=()=>{$('#import-date').value=today();$('#importer').showModal();};
$('#csv-file').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>200000)throw new Error('CSV 请小于200KB，每批最多100行');state.csv=parseCSV(await file.text());if(state.csv.length<2)throw new Error('CSV 至少包含表头和一行数据');$('#paste').value='';const mapping=$('#mapping');mapping.replaceChildren();for(const [key,label]of Object.entries(fields)){const l=el('label',label),select=el('select');select.dataset.field=key;select.append(new Option('使用统一值 / 留空',''));state.csv[0].forEach((h,i)=>select.append(new Option(h,String(i))));const found=state.csv[0].findIndex(h=>h.trim()===label||h.trim()===key);if(found>=0)select.value=String(found);l.append(select);mapping.append(l);}$('#submit-import').disabled=true;}catch(e){message(e.message);}});
$('#paste').addEventListener('input',()=>{state.csv=null;$('#mapping').replaceChildren();$('#csv-file').value='';$('#submit-import').disabled=true;});
for(const id of ['mapping','import-date','import-time','import-strategy'])$('#'+id).addEventListener('input',()=>$('#submit-import').disabled=true);
$('#preview-import').onclick=()=>{
  try{
    state.reviewedPaste=null;
    const reviewed=parseReviewedPaste($('#paste').value);
    if(reviewed){
      state.reviewedPaste=reviewed;state.importId=crypto.randomUUID();const table=$('#import-preview');table.replaceChildren();const head=el('tr');['策略','股票','买入时间','参考价','来源'].forEach(v=>head.append(el('th',v)));table.append(head);
      for(const r of reviewed){const tr=el('tr');[r.strategy,r.symbol+' '+r.name,r.buy_time,r.reference_price??'留空',r.reference_evidence.provider].forEach(v=>tr.append(el('td',v)));table.append(tr);}
      $('#import-summary').textContent=`核验文字共${reviewed.length}条、${new Set(reviewed.map(r=>r.symbol)).size}只股票。缺少的策略会新建，参考价与成交价分开保存。`;$('#submit-import').disabled=false;return;
    }
    let raw=[];const unified=$('#import-strategy').value,date=$('#import-date').value,time=$('#import-time').value;
    if(state.csv){const mapping=Object.fromEntries([...$('#mapping').querySelectorAll('select')].map(s=>[s.dataset.field,s.value]));raw=state.csv.slice(1).map(row=>Object.fromEntries(Object.entries(mapping).filter(([,i])=>i!=='').map(([k,i])=>[k,row[Number(i)]??''])));}
    else raw=$('#paste').value.trim().split(/\r?\n/).filter(Boolean).map(line=>{const a=line.trim().split(/[\s,，]+/);return {symbol:a[0],time:a[1]||time};});
    if(!raw.length||raw.length>100)throw new Error('每次导入1至100行');
    const rows=raw.map((r,i)=>{const strategy=r.strategy?state.strategies.find(s=>s.name===r.strategy&&!s.archived)?.id:unified;const day=r.date||date,t=r.time||time,buy_time=day+'T'+t;let error='';if(!strategy)error='策略不存在或已归档';else if(!/^\d{6}\.(SH|SZ|BJ)$/.test(r.symbol?.trim().toUpperCase()))error='需要带交易所的6位代码';else if(!Number.isFinite(Date.parse(buy_time+'+08:00')))error='日期时间无效';else if(new Date(buy_time+'+08:00')>new Date())error='不能录入未来时点';else if(day<new Date(Date.now()+8*3600000-2*86400000).toISOString().slice(0,10))error='超过补录前2天范围';for(const field of ['actual_price','shares'])if(r[field]&&(!Number.isFinite(Number(r[field]))||Number(r[field])<=0))error='价格及股数必须为正数';return {...r,symbol:r.symbol?.trim().toUpperCase(),strategy_id:strategy,buy_time,error,line:i+1};});
    state.importRows=rows;state.importId=crypto.randomUUID();const table=$('#import-preview');table.replaceChildren();const head=el('tr');['行','股票','策略','买入时点','校验'].forEach(s=>head.append(el('th',s)));table.append(head);rows.forEach(r=>{const tr=el('tr');[r.line,r.symbol,state.strategies.find(s=>s.id===r.strategy_id)?.name||'—',r.buy_time,r.error||'可提交'].forEach(s=>tr.append(el('td',s)));table.append(tr);});const valid=rows.filter(r=>!r.error);$('#import-summary').textContent=`输入${rows.length}行，将创建${valid.length}个策略样本，${new Set(valid.map(r=>r.symbol)).size}只不重复股票。${rows.length-valid.length}行有错误；请修正后整批提交。`;$('#submit-import').disabled=valid.length!==rows.length;
  }catch(e){message(e.message);$('#submit-import').disabled=true;}
};
$('#submit-import').onclick=async()=>{const b=$('#submit-import');b.disabled=true;try{if(state.reviewedPaste){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(state.reviewedPaste)));const request_id='paste-'+[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');await send('/api/import-reviewed',{rows:state.reviewedPaste,request_id});}else await createRows(state.importRows.map(({error,line,...r})=>r),state.importId);$('#importer').close();await load();message('批量导入已保存');}catch(e){message(e.message);b.disabled=false;}};
$('#research-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget,b=f.querySelector('button'),d=Object.fromEntries(new FormData(f)),symbols=[...new Set(d.symbols.toUpperCase().split(/[,，\s]+/).filter(Boolean))],result=$('#research-result');b.disabled=true;result.textContent='正在查询…';
  try{
    if(symbols.length<1||symbols.length>5)throw new Error('请选择1至5只股票');if(d.start>d.end)throw new Error('开始日期不能晚于结束日期');
    const fetched=await Promise.allSettled(symbols.map(symbol=>api('/api/quote?symbol='+encodeURIComponent(symbol))));const good=[],errors=[];
    fetched.forEach((r,i)=>{if(r.status==='fulfilled')good.push({symbol:symbols[i],...r.value});else errors.push(symbols[i]+'：'+r.reason.message);});
    if(!good.length)throw new Error(errors.join('；'));const local=new Date(Date.now()+8*3600000).toISOString(),cutoff=local.slice(11,16)>='16:00'?local.slice(0,10):new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
    const selected=good.map(g=>({...g,bars:g.bars.filter(r=>r.date>=d.start&&r.date<=d.end&&r.date<=cutoff)})),union=[...new Set(selected.flatMap(g=>g.bars.map(r=>r.date)))].sort(),common=union.filter(date=>selected.every(g=>g.bars.some(r=>r.date===date)));
    if(!common.length)throw new Error('所选窗口没有共同有效收盘日期');const first=common[0],labels=union.filter(date=>date>=first),series=selected.map(g=>{const base=g.bars.find(r=>r.date===first).close,map=new Map(g.bars.map(r=>[r.date,(r.close/base-1)*100]));return {name:g.symbol+' '+g.name,values:labels.map(date=>map.get(date)??null)};});
    result.replaceChildren(el('h2','归一化日线价格观察'),el('p',`共同基准日：${first} 收盘 = 0%。未复权，尚未核实公司行动。`,'fine'));const plot=el('div');result.append(plot);chart(plot,series,labels);
    const table=el('table'),head=el('tr');['日期',...series.map(s=>s.name)].forEach(s=>head.append(el('th',s)));table.append(head);labels.forEach((date,i)=>{const tr=el('tr');[date,...series.map(s=>pct(s.values[i]))].forEach(v=>tr.append(el('td',v)));table.append(tr);});const scroll=el('div',undefined,'table-wrap');scroll.append(table);result.append(scroll);if(errors.length)result.append(el('p','部分失败：'+errors.join('；'),'notice'));result.append(el('p',selected.map(g=>`${g.symbol}：${g.provider}，${g.fetchedAt}，${g.cached?'缓存':'新请求'}`).join('；'),'fine'));
  }catch(error){result.textContent=error.message;}finally{b.disabled=false;}
});
async function init(){try{state.user=await api('/api/me');$('#identity').textContent=`${state.user.username} · ${state.user.role==='admin'?'管理员':'只读查看者'}`;document.querySelectorAll('.admin-only').forEach(n=>n.hidden=state.user.role!=='admin');$('#today').textContent=new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'});const f=$('#research-form');f.elements.end.value=today();f.elements.start.value=new Date(Date.now()+8*3600000-30*86400000).toISOString().slice(0,10);await load();if(state.user.role==='admin'&&state.records.length)await refreshRecords(state.records,true);}catch(e){message(e.message);}}
init();

$('#reviewed-file').addEventListener('change',async event=>{
  const input=event.target,file=input.files[0];if(!file)return;
  try{
    if(file.size>1500000)throw new Error('核验文件请小于1.5MB');
    const rows=JSON.parse(await file.text());if(!Array.isArray(rows)||!rows.length||rows.length>250)throw new Error('核验文件需包含1至250条记录');
    if(!confirm(`导入${rows.length}条核验记录？将保留参考价来源并创建缺少的策略；不会覆盖已有记录。`))return;
    const bytes=new TextEncoder().encode(JSON.stringify(rows));const hash=await crypto.subtle.digest('SHA-256',bytes);
    const request_id='reviewed-'+[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const result=await send('/api/import-reviewed',{rows,request_id});await load();message(`已保存${result.count}条核验记录${result.replayed?'（重复提交，未重复写入）':''}`);
  }catch(error){message(error.message);}finally{input.value='';}
});

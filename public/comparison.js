import {chart} from './chart.js';
import {$,el,api,setupTheme} from './shared-page.js';
const fmt=n=>Number(n).toFixed(2),pct=n=>n==null?'—':`${n>0?'+':''}${fmt(n)}%`,today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
setupTheme();
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
async function init(){const user=await api('/api/me');for(const id of ['admin-home','admin-research'])$('#'+id).hidden=user.role!=='admin';const f=$('#research-form');f.elements.end.value=today();f.elements.start.value=new Date(Date.now()-30*86400000).toISOString().slice(0,10);const cap=await api('/api/account/password');$('#password-capability').textContent=cap.can_change?'修改密码后，所有设备上的当前会话将退出。':'此账户使用部署环境管理密码，请联系站点管理员修改。';$('#password-form').hidden=!cap.can_change;}
$('#password-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;try{await api('/api/account/password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();location.replace('/');}catch(err){$('#account-status').textContent=err.message;}finally{b.disabled=false;}};
init().catch(e=>$('#account-status').textContent=e.message);

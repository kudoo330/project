import {$,api,setupTheme} from './shared-page.js';
setupTheme();
async function init(){const user=await api('/api/me'),admin=user.role==='admin';$('#platform-user').textContent=user.username;$('#ashare-entry').href=admin?'/app':'/compare';$('#ashare-title').textContent=admin?'A股研究工作台':'股价对比';$('#ashare-description').textContent=admin?'买入追踪、策略比较、行情研究':'历史走势、多股票比较';$('#ashare-path').textContent=admin?'/app':'/compare';$('#backtest-entry').hidden=!admin;$('#backtest-locked').hidden=admin;$('#platform-admin').hidden=!admin;$('#platform-status').textContent=admin?'左侧进入原有 A 股工作台，右侧进入 AMD 研究。':'选择股价对比，查看行情走势。';}
init().catch(error=>$('#platform-status').textContent=error.message);

import {$,api,setupTheme} from './shared-page.js';
setupTheme();
async function init(){const user=await api('/api/me'),admin=user.role==='admin';$('#platform-user').textContent=user.username;$('#backtest-entry').hidden=!admin;$('#backtest-locked').hidden=admin;$('#platform-admin').hidden=!admin;$('#platform-status').textContent=admin?'选择研究模块，或继续记录 A 股买入。':'选择股价对比，查看行情走势。';}
init().catch(error=>$('#platform-status').textContent=error.message);

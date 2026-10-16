// Run on the owner's computer. Authentication and passwords never pass through chat.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {pbkdf2Sync,randomBytes} from 'node:crypto';
import readline from 'node:readline';
const cfg='wrangler.deploy.jsonc',cli='node_modules/wrangler/bin/wrangler.js';
function run(args,input){
  const r=spawnSync(process.execPath,[cli,...args],{stdio:input===undefined?'inherit':['pipe','inherit','inherit'],input,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  if(r.error)throw r.error;if(r.status!==0)throw new Error('Cloudflare 命令未完成。请检查上方提示；已创建的资源和配置会保留。');
}
async function password(label){
  if(!process.stdin.isTTY)throw new Error('请在自己的交互终端运行本脚本');
  process.stdout.write(label+'（至少12位，不回显）：');readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{let value='';const handler=(text,key)=>{
    if(key.ctrl&&key.name==='c'){process.stdin.setRawMode(false);process.stdin.off('keypress',handler);process.stdin.pause();reject(new Error('已取消'));}
    else if(key.name==='return'){process.stdin.setRawMode(false);process.stdin.off('keypress',handler);process.stdin.pause();process.stdout.write('\n');resolve(value);}
    else if(key.name==='backspace')value=value.slice(0,-1);
    else if(text&&!key.ctrl&&!key.meta)value+=text;
  };process.stdin.on('keypress',handler);});
}
function hash(p){const salt=randomBytes(16).toString('hex');return `pbkdf2$100000$${salt}$${pbkdf2Sync(p,salt,100000,32,'sha256').toString('hex')}`;}
async function setup(){
  console.log('将在你的 Cloudflare 账号创建 / 更新网站与 D1 数据库。选择免费 Workers 方案即可；不会购买域名或设置计划任务。');
  console.log('如已登录多个 Cloudflare 账号，请先确认选择的是你要部署的账号。');
  run(['login']);run(['whoami']);
  const admin=await password('设置管理员 admin 的密码'),again=await password('再次输入管理员密码');
  if(admin.length<12||admin!==again)throw new Error('管理员密码不一致或不足12位');
  const viewer=await password('设置只读账号 viewer 的密码'),viewerAgain=await password('再次输入查看者密码');
  if(viewer.length<12||viewer!==viewerAgain||viewer===admin)throw new Error('查看者密码须至少12位，两次相同，且与管理员不同');
  const existing=existsSync(cfg);
  if(!existing){const c=JSON.parse(readFileSync('wrangler.jsonc','utf8'));c.vars.VIEWER_USERNAME='viewer';writeFileSync(cfg,JSON.stringify(c,null,2)+'\n');}
  let config=JSON.parse(readFileSync(cfg,'utf8'));
  if(config.d1_databases[0].database_id==='00000000-0000-0000-0000-000000000000'){
    run(['d1','create',config.d1_databases[0].database_name,'--binding','DB','--update-config','--config',cfg]);
  }else{
    mkdirSync('.backups',{recursive:true});const file='.backups/before-migration-'+new Date().toISOString().replaceAll(':','-')+'.sql';
    run(['d1','export','tracker','--remote','--output',file,'--config',cfg]);
  }
  run(['d1','migrations','apply','tracker','--remote','--config',cfg]);
  // First deployment stays locked until ADMIN_PASSWORD_HASH is installed.
  run(['deploy','--config',cfg]);
  run(['secret','put','ADMIN_PASSWORD_HASH','--config',cfg],hash(admin)+'\n');
  run(['secret','put','VIEWER_PASSWORD_HASH','--config',cfg],hash(viewer)+'\n');
  console.log('部署命令已完成。请打开上方实际返回的网址，分别验证 admin 和 viewer；退出后应无法读取数据。');
  console.log('数据库配置保存在 wrangler.deploy.jsonc。更新网站时保留此文件，避免另建数据库。');
}
setup().catch(e=>{console.error(e.message);process.exitCode=1;});

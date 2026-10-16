// Cloudflare Workers Builds: database migration must complete before publishing code.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const id=config.d1_databases?.find(b=>b.binding==='DB')?.database_id;
if(!id || id==='00000000-0000-0000-0000-000000000000'){
  console.error('尚未配置实际D1数据库ID。请在Cloudflare创建tracker数据库，并更新wrangler.jsonc的database_id；数据库ID不是密码或API令牌。');
  process.exit(1);
}
for(const args of [['d1','migrations','apply','tracker','--remote'],['deploy']]){
  const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:'inherit'});
  if(r.error){console.error(r.error.message);process.exit(1);}
  if(r.status!==0)process.exit(r.status??1);
}

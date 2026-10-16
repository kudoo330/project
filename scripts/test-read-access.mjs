// Real isolated D1 simulator; generated test credentials are never logged.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'read-access-'));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
try{
 await build({entryPoints:['src/read-access.ts'],outfile:join(dir,'read.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {generateReadToken,canReadWithToken,revokeReadToken}=await import(pathToFileURL(join(dir,'read.mjs')).href),db=await mf.getD1Database('DB'),now=Date.now();
 const req=(token,method='GET')=>new Request('https://test.invalid/api/readonly/records',{method,headers:{'X-Tracker-Read-Token':token}});
 assert.equal(await canReadWithToken(db,req(''),now),false);
 const first=await generateReadToken(db,'test-admin',now);assert.equal(first.expires_at,now+7*86400000);
 assert.equal(await canReadWithToken(db,req(first.token),now),true);assert.equal(await canReadWithToken(db,req(first.token,'POST'),now),false);assert.equal(await canReadWithToken(db,req(first.token),first.expires_at),false);
 const stored=await db.prepare('SELECT * FROM read_access').first();assert.notEqual(stored.token_hash,first.token);assert.match(stored.token_hash,/^[a-f0-9]{64}$/);
 const second=await generateReadToken(db,'test-admin',now);assert.equal(await canReadWithToken(db,req(first.token),now),false);assert.equal(await canReadWithToken(db,req(second.token),now),true);
 await revokeReadToken(db);assert.equal(await canReadWithToken(db,req(second.token),now),false);
 console.log('PASS: hashed-only storage; seven-day expiry; GET-only authorization; rotation; revocation; missing-token rejection');
}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}

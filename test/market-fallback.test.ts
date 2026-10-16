import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedDaily} from '../src/market';
import type {Env} from '../src/types';
const day='2026-10-15',sina={day,open:'10',close:'10.5',high:'11',low:'9',volume:'100'};
function env(){return {DB:{prepare:()=>({bind(){return this;},first:async()=>null,run:async()=>({})})}} as unknown as Env;}
test('Eastmoney transport failure falls back to Sina but still needs distinct Tencent matching close',async()=>{
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async(input,init)=>{
  requests++;const url=String(input);assert.ok((init?.headers as any)['User-Agent']);
  if(url.includes('eastmoney'))return new Response('',{status:520});
  if(url.includes('quotes.sina'))return new Response('var _data=('+JSON.stringify([sina])+')');
  if(url.includes('/hfq.js'))return new Response('var sz300111hfq='+JSON.stringify({data:[{d:'1900-01-01',f:'1'}]}));
  return Response.json({code:0,data:{sz300111:{day:[[day,'10','10.5','11','9','100']],qfqday:[[day,'10','10.5','11','9','100']]}}});
 };
 try{const q=await verifiedDaily(env(),'300111.SZ',true);assert.equal(q.bars.length,1);assert.deepEqual(q.bars[0].crossCheck?.sources,['新浪','腾讯']);assert.ok(requests<=6);}finally{globalThis.fetch=original;}
});

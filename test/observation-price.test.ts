import test from 'node:test';
import assert from 'node:assert/strict';
import {observationPrice} from '../public/observation-price.js';
test('observation price matches calculated close, distinguishes adjustment, and omits invalid or suspended prices',()=>{
 assert.equal(observationPrice({close:10.52,rawClose:10.52,state:'有效价格观察'})?.text,'收盘 ¥10.52');
 const adjusted=observationPrice({close:5.26,rawClose:10.52,state:'有效价格观察'});assert.equal(adjusted?.text,'复权 ¥5.26');assert.match(adjusted!.title,/10.52/);
 for(const close of [null,undefined,0,-1,NaN,Infinity,'10.52'])assert.equal(observationPrice({close,state:'待更新'}),null);
 assert.equal(observationPrice({close:10.52,rawClose:10.52,state:'停牌'}),null);
});

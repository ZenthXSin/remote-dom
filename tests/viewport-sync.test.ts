import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ViewportSync} from '../src/client/viewport-sync.js';
test('viewport acknowledgements cannot confirm a superseded request and remote drift clears confirmation',()=>{
 const sync=new ViewportSync(()=>{},10000);let serial=0;const send=()=>++serial;
 sync.update('wide',send);sync.update('wide',send);assert.equal(serial,1);
 sync.update('narrow',send);sync.acknowledge(1,true);sync.update('narrow',send);assert.equal(serial,2);
 sync.acknowledge(2,true);sync.update('narrow',send);assert.equal(serial,2);
 sync.observe('other-size');sync.update('narrow',send);assert.equal(serial,3);sync.reset();
});
test('missing resize acknowledgement retries and reset cancels the timeout',async()=>{
 let retries=0;const sync=new ViewportSync(()=>{retries++;},15);
 sync.update('wide',()=>1);await new Promise(r=>setTimeout(r,40));assert.equal(retries,1);
 sync.update('wide',()=>2);sync.reset();await new Promise(r=>setTimeout(r,40));assert.equal(retries,1);
});

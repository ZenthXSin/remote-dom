import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diff,snapshot} from '../src/server/diff.js';
import type {CapturedDocument} from '../src/shared/protocol.js';
const initial:CapturedDocument={root:'n1',title:'example',url:'https://example.test',scrollX:0,scrollY:0,focused:null,unsupported:[],truncated:false,nodes:[{id:'n1',kind:'element',tag:'div',children:['n2']},{id:'n2',kind:'text',text:'first'}]};
test('incremental update retains IDs and carries only changed nodes',()=>{
 const before=snapshot(initial,'document-1',4);const next=structuredClone(initial);next.nodes[1].text='streamed text';
 const patch=diff(before,next)!;assert.equal(patch.base,4);assert.equal(patch.seq,5);assert.deepEqual(patch.upsert,[next.nodes[1]]);assert.deepEqual(patch.remove,[]);
 assert.equal(diff(before,initial),null);
});
test('node removal and document metadata are delivered without stale nodes',()=>{
 const next=structuredClone(initial);next.nodes.pop();next.nodes[0].children=[];next.title='changed';
 const patch=diff(snapshot(initial,'d'),next)!;assert.deepEqual(patch.remove,['n2']);assert.equal(patch.title,'changed');
});
test('diffing a stored snapshot retains patch type and does not copy transport fields',()=>{
 const previous=snapshot(initial,'d',1);const next=structuredClone(initial);next.nodes[1].text='later';
 const patch=diff(previous,snapshot(next,'d',7))!;assert.equal(patch.type,'patch');assert.equal(patch.base,1);assert.equal(patch.seq,2);
});

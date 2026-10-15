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

test('retained streaming snapshots share unchanged records without modifying history',async()=>{
 const {advanceSnapshot}=await import('../src/server/diff.js');
 let before=snapshot(initial,'stream',0);const first=before;
 for(let i=0;i<30;i++){
  const next=structuredClone(initial);next.nodes[1].text='chunk '+i;
  const patch=diff(before,next)!;const after=advanceSnapshot(before,next,patch);
  assert.strictEqual(after.nodes[0],first.nodes[0]);
  assert.notStrictEqual(after.nodes[1],before.nodes[1]);
  assert.equal(before.nodes[1].text,i===0?'first':'chunk '+(i-1));
  assert.deepEqual(after,snapshot(next,'stream',patch.seq));before=after;
 }
 assert.equal(first.nodes[1].text,'first');
 const removed=structuredClone(initial);removed.nodes.pop();removed.nodes[0].children=[];
 const patch=diff(before,removed)!;assert.deepEqual(advanceSnapshot(before,removed,patch).nodes,removed.nodes);
});

test('direct comparison ignores property order but detects nested styles, media and removals',()=>{
 const before=snapshot({...initial,nodes:[{id:'n1',kind:'element',tag:'div',style:{color:'red',display:'block'},pseudoStyles:{before:{content:'"first"'}},children:[],media:{paused:true,currentTime:0,volume:1,muted:false,loop:false,playbackRate:1}}]},'nested');
 const reordered=structuredClone(before);reordered.nodes[0].style={display:'block',color:'red'};assert.equal(diff(before,reordered),null);
 for(const mutate of [(n:typeof before.nodes[0])=>{n.style!.color='blue';},(n:typeof before.nodes[0])=>{delete n.style!.color;},(n:typeof before.nodes[0])=>{n.pseudoStyles!.before!.content='"second"';},(n:typeof before.nodes[0])=>{n.media!.paused=false;},(n:typeof before.nodes[0])=>{n.children!.push('n2');}]){
  const next=structuredClone(before);mutate(next.nodes[0]);assert.equal(diff(before,next)!.upsert.length,1);
 }
 const next=structuredClone(before);next.focused='n1';assert.deepEqual(diff(before,next)!.upsert,[]);
});

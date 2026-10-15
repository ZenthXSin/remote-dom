import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RenderQueue,mergeUpdates} from '../src/client/render-queue.js';
import type {Snapshot,Patch,MirrorNode} from '../src/shared/protocol.js';
const node=(id:string,text=id):MirrorNode=>({id,kind:'text',text});
const snapshot={type:'snapshot',protocol:1,epoch:'a',seq:0,root:'n1',nodes:[node('n1')]} as Snapshot;
const patch=(base:number,upsert:MirrorNode[]=[],remove:string[]=[]):Patch=>({...snapshot,type:'patch',base,seq:base+1,upsert,remove});
test('slow renderer holds one update and merges contiguous revisions without losing deletion or reinsertion',()=>{
 const sent:{message:Snapshot|Patch;token:number}[]=[];let resyncs=0;
 const queue=new RenderQueue((message,token)=>sent.push({message,token}),()=>resyncs++);
 queue.push(snapshot);queue.push(patch(0,[node('n2')]));queue.push(patch(1,[],['n2']));queue.push(patch(2,[node('n2','new')]));
 assert.equal(sent.length,1);queue.done(sent[0].token);assert.equal(sent.length,2);
 const result=sent[1].message as Patch;assert.equal(result.base,0);assert.equal(result.seq,3);assert.deepEqual(result.remove,[]);assert.deepEqual(result.upsert,[node('n2','new')]);assert.equal(resyncs,0);
 queue.done(sent[0].token);assert.equal(sent.length,2);
});
test('new snapshots replace pending frames and stale renderer completion cannot release a new session',()=>{
 const sent:{message:Snapshot|Patch;token:number}[]=[];const queue=new RenderQueue((message,token)=>sent.push({message,token}),()=>{});
 queue.push(snapshot);queue.push(patch(0));queue.push({...snapshot,epoch:'b',seq:9});queue.done(sent[0].token);assert.equal(sent[1].message.epoch,'b');
 queue.reset();queue.push(snapshot);queue.push(patch(0));queue.done(sent[1].token);assert.equal(sent.length,3);queue.done(sent[2].token);assert.equal(sent.length,4);
});
test('folding patches into a pending snapshot preserves final state and rejects gaps',()=>{
 const result=mergeUpdates(snapshot,patch(0,[node('n2')],['n1'])) as Snapshot;assert.deepEqual(result.nodes,[node('n2')]);assert.equal(result.seq,1);
 assert.equal(mergeUpdates(snapshot,patch(8)),undefined);assert.equal(mergeUpdates(snapshot,{...patch(0),epoch:'b'}),undefined);
});

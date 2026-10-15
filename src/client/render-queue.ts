import type {Snapshot,Patch} from '../shared/protocol.js';
type Update=Snapshot|Patch;
// Keep one render in flight and fold only contiguous revisions. Input replies
// bypass this queue; intermediate visual states may be skipped, actions may not.
export function mergeUpdates(previous:Update,next:Update):Update|undefined {
 if(next.type==='snapshot')return next;
 if(previous.epoch!==next.epoch||previous.seq!==next.base)return;
 const records=new Map((previous.type==='snapshot'?previous.nodes:previous.upsert).map(node=>[node.id,node]));
 const removed=new Set(previous.type==='patch'?previous.remove:[]);
 for(const id of next.remove){records.delete(id);removed.add(id);}
 for(const node of next.upsert){records.set(node.id,node);removed.delete(node.id);}
 if(previous.type==='snapshot'){const {upsert,remove,base,...state}=next;return {...state,type:'snapshot',nodes:[...records.values()]};}
 return {...next,base:previous.base,upsert:[...records.values()],remove:[...removed]};
}
export class RenderQueue {
 private pending?:Update;private flight?:number;private counter=0;
 constructor(private send:(update:Update,token:number)=>void,private resync:()=>void){}
 push(update:Update){
  if(this.pending){const merged=mergeUpdates(this.pending,update);if(!merged){this.pending=undefined;this.resync();return;}this.pending=merged;}else this.pending=update;
  this.flush();
 }
 done(token:number){if(this.flight!==token)return false;this.flight=undefined;this.flush();return true;}
 reset(){this.pending=undefined;this.flight=undefined;}
 private flush(){if(this.flight!==undefined||!this.pending)return;const update=this.pending;this.pending=undefined;const token=++this.counter;this.flight=token;this.send(update,token);}
}

import type {CapturedDocument,Snapshot,Patch} from '../src/shared/protocol.js';
import {snapshot} from '../src/server/diff.js';
import {diff as after} from '../src/server/diff.js';
import {collectNodeAssets} from '../src/shared/assets.js';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const nodeCount=2000;
const style=Object.fromEntries(Array.from({length:30},(_,i)=>['style-'+i,String(i)+'px']));
const doc:any={root:'n0',title:'benchmark',url:'https://example.test',scrollX:0,scrollY:0,focused:null,unsupported:[],truncated:false,nodes:Array.from({length:nodeCount},(_,i)=>({id:'n'+i,kind:'element',tag:'p',style:{...style},attrs:{'aria-label':'Message '+i},children:[],text:'Streaming message '+i,...(i%100===0?{assetUrl:'asset:11111111-1111-4111-8111-111111111111'}:{})}))};
const previous=snapshot(doc,'test'),next=structuredClone(doc);next.nodes.at(-1).text='New chunk';assert.deepEqual(after(previous,next),before(previous,next));
const funcs={baselineDiff:()=>before(previous,next),optimizedDiff:()=>after(previous,next),baselineAssets:()=>[...new Set(Array.from(JSON.stringify(next.nodes).matchAll(/asset:([a-f0-9-]+)/g),m=>m[1]))],optimizedAssets:()=>[...collectNodeAssets(next.nodes)]};
assert.deepEqual(funcs.baselineAssets(),funcs.optimizedAssets());
for(const fn of Object.values(funcs))for(let i=0;i<5;i++)fn();
const results:Record<string,number[]>={};
for(let round=0;round<5;round++)for(const [name,fn]of Object.entries(funcs)){global.gc?.();const start=performance.now();for(let i=0;i<30;i++)fn();(results[name]??=[]).push((performance.now()-start)/30);}
console.log(JSON.stringify({nodeCount,iterationsPerRound:30,rounds:5,msPerOperation:results}));

function before(previous:Snapshot,next:CapturedDocument):Patch|null {
  const old=new Map(previous.nodes.map(n=>[n.id,JSON.stringify(n)]));
  const upsert=next.nodes.filter(n=>old.get(n.id)!==JSON.stringify(n));
  const ids=new Set(next.nodes.map(n=>n.id));
  const remove=previous.nodes.filter(n=>!ids.has(n.id)).map(n=>n.id);
  const state={persistenceError:next.persistenceError,viewportStyle:next.viewportStyle,bodyScrollsWindow:next.bodyScrollsWindow,language:next.language,inputRevision:next.inputRevision,root:next.root,title:next.title,url:next.url,scrollX:next.scrollX,scrollY:next.scrollY,focused:next.focused,unsupported:next.unsupported,truncated:next.truncated,fontFaces:next.fontFaces,windows:next.windows,filePicker:next.filePicker,downloads:next.downloads};
  const metadataChanged=Object.keys(state).some(k=>JSON.stringify(previous[k as keyof Snapshot])!==JSON.stringify(state[k as keyof typeof state]));
  if(!upsert.length&&!remove.length&&!metadataChanged)return null;
  return {type:'patch',protocol:1,epoch:previous.epoch,base:previous.seq,seq:previous.seq+1,upsert,remove,...state};
}

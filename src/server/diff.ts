import type {CapturedDocument, Snapshot, Patch} from '../shared/protocol.js';
export function snapshot(document:CapturedDocument,epoch:string,seq=0):Snapshot {
  return {type:'snapshot',protocol:1,epoch,seq,...document};
}
export function diff(previous:Snapshot,next:CapturedDocument):Patch|null {
  const old=new Map(previous.nodes.map(node=>[node.id,node]));
  const upsert:Patch['upsert']=[];
  for(const node of next.nodes){if(!sameData(old.get(node.id),node))upsert.push(node);old.delete(node.id);}
  const remove=[...old.keys()];
  const state={viewport:next.viewport,persistenceError:next.persistenceError,viewportStyle:next.viewportStyle,bodyScrollsWindow:next.bodyScrollsWindow,language:next.language,inputRevision:next.inputRevision,root:next.root,title:next.title,url:next.url,scrollX:next.scrollX,scrollY:next.scrollY,focused:next.focused,unsupported:next.unsupported,truncated:next.truncated,fontFaces:next.fontFaces,windows:next.windows,filePicker:next.filePicker,downloads:next.downloads};
  const metadataChanged=Object.keys(state).some(k=>!sameData(previous[k as keyof Snapshot],state[k as keyof typeof state]));
  if(!upsert.length&&!remove.length&&!metadataChanged)return null;
  return {type:'patch',protocol:1,epoch:previous.epoch,base:previous.seq,seq:previous.seq+1,upsert,remove,...state};
}

// Snapshots are immutable. Share unchanged records across retained revisions so
// a streaming text update does not retain another full copy of every style map.
export function advanceSnapshot(previous:Snapshot,document:CapturedDocument,patch:Patch):Snapshot {
  const changed=new Set(patch.upsert.map(node=>node.id));
  const old=new Map(previous.nodes.map(node=>[node.id,node]));
  return snapshot({...document,nodes:document.nodes.map(node=>changed.has(node.id)?node:old.get(node.id)??node)},previous.epoch,patch.seq);
}

// Protocol data is acyclic JSON. Compare it directly instead of allocating two
// serialized copies of every node and style map on every capture.
function sameData(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameData(value,b[index]));
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
  const keys=Object.keys(left);
  if(keys.length!==Object.keys(right).length)return false;
  for(const key of keys)if(!Object.hasOwn(right,key)||!sameData(left[key],right[key]))return false;
  return true;
}

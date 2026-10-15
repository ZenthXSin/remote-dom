import type {CapturedDocument, Snapshot, Patch} from '../shared/protocol.js';
export function snapshot(document:CapturedDocument,epoch:string,seq=0):Snapshot {
  return {type:'snapshot',protocol:1,epoch,seq,...document};
}
export function diff(previous:Snapshot,next:CapturedDocument):Patch|null {
  const old=new Map(previous.nodes.map(n=>[n.id,JSON.stringify(n)]));
  const upsert=next.nodes.filter(n=>old.get(n.id)!==JSON.stringify(n));
  const ids=new Set(next.nodes.map(n=>n.id));
  const remove=previous.nodes.filter(n=>!ids.has(n.id)).map(n=>n.id);
  const state={persistenceError:next.persistenceError,viewportStyle:next.viewportStyle,bodyScrollsWindow:next.bodyScrollsWindow,language:next.language,inputRevision:next.inputRevision,root:next.root,title:next.title,url:next.url,scrollX:next.scrollX,scrollY:next.scrollY,focused:next.focused,unsupported:next.unsupported,truncated:next.truncated,fontFaces:next.fontFaces,windows:next.windows,filePicker:next.filePicker,downloads:next.downloads};
  const metadataChanged=Object.keys(state).some(k=>JSON.stringify(previous[k as keyof Snapshot])!==JSON.stringify(state[k as keyof typeof state]));
  if(!upsert.length&&!remove.length&&!metadataChanged)return null;
  return {type:'patch',protocol:1,epoch:previous.epoch,base:previous.seq,seq:previous.seq+1,upsert,remove,...state};
}

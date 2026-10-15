import type {AssetBody} from './asset-source.js';
// Canvas/data URLs cannot always be re-created byte-for-byte after they change.
// Keep only a short, bounded delivery buffer, never a persistent resource cache.
export class AssetTransit {
 private entries=new Map<string,{asset:AssetBody;timer:NodeJS.Timeout}>();private bytes=0;
 constructor(private limit=4*1024*1024,private ttl=2000){}
 get size(){return this.entries.size;}
 put(id:string,asset:AssetBody){
  this.take(id);if(asset.body.length>this.limit)return;
  while(this.bytes+asset.body.length>this.limit&&this.entries.size)this.take(this.entries.keys().next().value!);
  const timer=setTimeout(()=>this.take(id),this.ttl);timer.unref();this.entries.set(id,{asset,timer});this.bytes+=asset.body.length;
 }
 take(id:string){const entry=this.entries.get(id);if(!entry)return;clearTimeout(entry.timer);this.entries.delete(id);this.bytes-=entry.asset.body.length;return entry.asset;}
 clear(){for(const id of this.entries.keys())this.take(id);}
}

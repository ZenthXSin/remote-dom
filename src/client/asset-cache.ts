const DB_NAME='remote-dom-assets-v1';
export const CACHE_CLEAR_KEY='rd-asset-cache-cleared';
const MAX_BYTES=64*1024*1024,MAX_ENTRIES=512,MAX_AGE=24*60*60*1000;
interface Entry {key:string;mime:string;body:Blob;size:number;used:number;expires:number}
function epoch(){try{return localStorage.getItem(CACHE_CLEAR_KEY)??'';}catch{return '';}}
async function open():Promise<IDBDatabase|undefined>{
 if(typeof indexedDB==='undefined')return;
 return new Promise(resolve=>{
  let done=false;const finish=(db?:IDBDatabase)=>{if(done){db?.close();return;}done=true;clearTimeout(timer);resolve(db);};
  const timer=setTimeout(()=>finish(),1500);
  try{const request=indexedDB.open(DB_NAME,1);
   request.onupgradeneeded=()=>{const db=request.result;const store=db.createObjectStore('assets',{keyPath:'key'});store.createIndex('used','used');db.createObjectStore('totals');};
   request.onerror=()=>finish();request.onblocked=()=>finish();request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('assets')||!db.objectStoreNames.contains('totals')){db.close();finish();return;}db.onversionchange=()=>db.close();finish(db);};
  }catch{finish();}
 });
}
export class AssetCache {
 async get(key:string):Promise<{mime:string;body:Blob}|undefined>{
  const marker=epoch(),db=await open();if(!db)return;
  return new Promise(resolve=>{
   let value:Entry|undefined;const transaction=db.transaction('assets','readonly');const timer=setTimeout(()=>transaction.abort(),1500);
   const request=transaction.objectStore('assets').get(key);request.onsuccess=()=>{const entry=request.result as Entry|undefined;if(entry&&entry.expires>Date.now()&&entry.body instanceof Blob&&entry.size===entry.body.size&&entry.size<=2*1024*1024)value=entry;};
   const finish=()=>{clearTimeout(timer);db.close();resolve(marker===epoch()?value:undefined);};transaction.oncomplete=finish;transaction.onabort=()=>{value=undefined;finish();};transaction.onerror=()=>{};
  });
 }
 async put(key:string,mime:string,body:Blob):Promise<void>{
  if(body.size>2*1024*1024)return;const marker=epoch(),db=await open();if(!db)return;if(marker!==epoch()){db.close();return;}
  return new Promise(resolve=>{
   const transaction=db.transaction(['assets','totals'],'readwrite'),assets=transaction.objectStore('assets'),totals=transaction.objectStore('totals');
   const timer=setTimeout(()=>transaction.abort(),2000);const finish=()=>{clearTimeout(timer);db.close();resolve();};transaction.oncomplete=finish;transaction.onabort=finish;transaction.onerror=()=>{};
   const count=totals.get('usage');count.onsuccess=()=>{const usage=count.result??{bytes:0,count:0};const previous=assets.get(key);previous.onsuccess=()=>{
    usage.bytes+=body.size-(previous.result?.size??0);usage.count+=previous.result?0:1;
    assets.put({key,mime,body,size:body.size,used:Date.now(),expires:Date.now()+MAX_AGE} satisfies Entry);
    const cursor=assets.index('used').openCursor();cursor.onsuccess=()=>{const item=cursor.result;
     if(item&&(usage.bytes>MAX_BYTES||usage.count>MAX_ENTRIES||item.value.expires<=Date.now())){usage.bytes-=item.value.size;usage.count--;item.delete();item.continue();}
     else totals.put(usage,'usage');
    };
   };};
  });
 }
}
export async function clearAssetCache():Promise<void>{
 try{localStorage.setItem(CACHE_CLEAR_KEY,crypto.randomUUID());}catch{}
 if(typeof indexedDB==='undefined')return;
 await new Promise<void>(resolve=>{const timer=setTimeout(resolve,2000);try{const request=indexedDB.deleteDatabase(DB_NAME);request.onsuccess=request.onerror=()=>{clearTimeout(timer);resolve();};}catch{clearTimeout(timer);resolve();}});
}

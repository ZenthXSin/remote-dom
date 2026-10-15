import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('client resources persist across refresh, recover after eviction, and leave no binary bodies on the server',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();let requests=0;page.on('request',r=>{if(/\/assets\//.test(r.url()))requests++;});
 const painted=async()=>{const image=page.frameLocator('#mirror').getByAltText('经授权资源通道传输的测试图片');await image.waitFor();await image.evaluate(async node=>{for(let i=0;i<100;i++){const image=node as HTMLImageElement;if(image.src.startsWith('blob:')&&image.complete&&image.naturalWidth>0)return;await new Promise(r=>setTimeout(r,50));}throw Error('Image was not painted');});};
 await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();await painted();assert.ok(requests>0);
 const session=[...app.sessions.values()][0];assert.ok(session.assets.size>0);for(const entry of session.assets.values())assert.equal('body' in entry,false);
 await page.waitForFunction(async()=>new Promise<boolean>(resolve=>{const open=indexedDB.open('remote-dom-assets-v1',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('assets'),read=tx.objectStore('assets').count();read.onsuccess=()=>resolve(read.result>0);tx.oncomplete=()=>db.close();};open.onerror=()=>resolve(false);}));
 requests=0;await page.reload();await painted();assert.equal(requests,0,'refresh must use the persistent client cache');
 // Fill the exact 64 MiB budget; the next asset must evict old entries.
 await page.evaluate(async()=>new Promise<void>((resolve,reject)=>{const request=indexedDB.open('remote-dom-assets-v1',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['assets','totals'],'readwrite'),store=tx.objectStore('assets');store.clear();const body=new Blob([new Uint8Array(2*1024*1024)]);for(let i=0;i<32;i++)store.put({key:'quota-'+i,mime:'image/png',body,size:body.size,used:Date.now()-10000+i,expires:Date.now()+60000});tx.objectStore('totals').put({bytes:64*1024*1024,count:32},'usage');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}));
 await page.reload();await painted();
 await page.waitForFunction(async()=>new Promise<boolean>(resolve=>{const request=indexedDB.open('remote-dom-assets-v1',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction('totals'),read=tx.objectStore('totals').get('usage');read.onsuccess=()=>resolve(read.result.bytes<64*1024*1024&&read.result.count<=32);tx.oncomplete=()=>db.close();};}));
 // Force the streaming fallback instead of Chromium's resource cache.
 for(const window of (session as any).windows.values())window.capture.resource=async()=>undefined;
 await page.evaluate(async()=>new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('remote-dom-assets-v1');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);}));
 requests=0;await page.reload();await painted();assert.ok(requests>0,'eviction must recover through the authenticated resource endpoint');
 for(const entry of session.assets.values())assert.equal('body' in entry,false);assert.equal((session as any).assetLoads.size,0);
 // Storage denial is not allowed to break resource delivery.
 await page.addInitScript(()=>{Object.defineProperty(indexedDB,'open',{value:()=>{throw new DOMException('Storage denied','SecurityError');}});});requests=0;await page.reload();await painted();assert.ok(requests>0);
 const firstScope=await page.evaluate(async()=> (await(await fetch('/api/state')).json()).assetCacheScope);
 await context.clearCookies();const other=await page.evaluate(async()=>{const state=await(await fetch('/api/state')).json();return {scope:state.assetCacheScope,sessions:state.sessions.length};});assert.notEqual(other.scope,firstScope);assert.equal(other.sessions,0);
 const forbidden=await page.evaluate(async ({id,asset})=>(await fetch(`/api/sessions/${id}/assets/${asset}`)).status,{id:session.id,asset:[...session.assets.keys()][0]});assert.equal(forbidden,404);
});

test('changing canvas frames survive transfer and obsolete client blobs are released',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/browser-shell');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const image=page.frameLocator('#mirror').getByAltText('Interactive drawing');await image.waitFor();const session=[...app.sessions.values()][0];const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;
 await frame.evaluate(()=>{const revoke=URL.revokeObjectURL.bind(URL);(window as any).__revoked=0;URL.revokeObjectURL=url=>{(window as any).__revoked++;revoke(url);};});
 await frame.waitForFunction(()=>{const img=document.querySelector('[alt="Interactive drawing"]') as HTMLImageElement;return img?.src.startsWith('blob:')&&img.complete&&img.naturalWidth>0;});
 let last=await image.getAttribute('src');
 for(const color of ['red','blue','yellow','purple','orange','black']){
  await session.page.evaluate(color=>{const canvas=document.getElementById('drawing') as HTMLCanvasElement,ctx=canvas.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(0,0,canvas.width,canvas.height);},color);
  for(let attempt=0;attempt<50;attempt++){const src=await image.getAttribute('src');if(src?.startsWith('blob:')&&src!==last){last=src;break;}await page.waitForTimeout(40);}
  await image.evaluate(async node=>(node as HTMLImageElement).decode());
 }
 assert.ok(await frame.evaluate(()=>(window as any).__revoked)>=5,'old canvas frames must not accumulate in client memory');
 assert.equal((session as any).inlineTransit.size,0,'delivered canvas transfer buffers must be released');
 for(const entry of session.assets.values())assert.equal('body' in entry,false);
});

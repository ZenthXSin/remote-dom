import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('stream worker parses during a blocked UI, coalesces visuals and prioritizes input acknowledgements',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();await page.goto(app.origin+'/health');await context.request.get(app.origin+'/api/state');
 const response=await context.request.post(app.origin+'/api/sessions',{headers:{Origin:app.origin},data:{url:app.fixtureOrigin}});assert.equal(response.status(),201);
 const session=app.sessions.get((await response.json()).id)!;
 const created=page.waitForEvent('worker');await page.evaluate(url=>{
  const worker=new Worker('/stream-worker.js');(window as any).streamWorker=worker;(window as any).streamMessages=[];
  worker.onmessage=e=>{(window as any).streamMessages.push(e.data);if(e.data.type==='ready')worker.postMessage({type:'connect',url});if(e.data.type==='open')worker.postMessage({type:'send',data:JSON.stringify({type:'render-flow',window:3})});};
 },app.origin.replace('http:','ws:')+`/api/sessions/${session.id}/stream`);
 const worker=await created;
 await page.waitForFunction(()=>(window as any).streamMessages.some((m:any)=>m.data?.type==='snapshot'));
 const initial=await page.evaluate(()=>(window as any).streamMessages.find((m:any)=>m.data?.type==='snapshot').data);
 for(let i=0;i<2;i++){await session.page.evaluate(i=>document.title='worker '+i,i);await session.poll(true);}
 await page.evaluate(({epoch,seq})=>(window as any).streamWorker.postMessage({type:'send',data:JSON.stringify({type:'event',epoch,eventId:100,action:'viewport',width:1000,height:700})}),initial);
 await page.waitForFunction(()=>(window as any).streamMessages.some((m:any)=>m.data?.type==='ack'&&m.data.eventId===100));
 assert.equal(await page.evaluate(()=>(window as any).streamMessages.filter((m:any)=>['snapshot','patch'].includes(m.data?.type)).length),1,'control replies bypass a held visual frame');
 await worker.evaluate('self.__name=(value)=>value');await worker.evaluate(()=>{(self as any).pongCount=0;const post=self.postMessage.bind(self);self.postMessage=(message:any)=>{if(message.data?.type==='pong')(self as any).pongCount++;post(message);};});
 const start=Date.now(),blocked=page.evaluate(()=>{const until=performance.now()+650;while(performance.now()<until){};});
 await new Promise(r=>setTimeout(r,70));for(const socket of session.sockets)session.send(socket,{type:'pong'});
 let received=false;while(Date.now()-start<450){if(await worker.evaluate(()=>(self as any).pongCount>0)){received=true;break;}await new Promise(r=>setTimeout(r,10));}
 assert.ok(received,'worker must receive and parse while the DOM thread is blocked');await blocked;
 await page.evaluate(({epoch,seq})=>(window as any).streamWorker.postMessage({type:'send',data:JSON.stringify({type:'rendered',epoch,seq})}),initial);
 await page.waitForFunction(()=>(window as any).streamMessages.some((m:any)=>m.data?.type==='patch'));
 const merged=await page.evaluate(()=>(window as any).streamMessages.find((m:any)=>m.data?.type==='patch').data);assert.equal(merged.base,initial.seq);assert.equal(merged.title,'worker 1');
 await page.evaluate(()=>(window as any).streamWorker.postMessage({type:'close'}));await page.waitForFunction(()=>(window as any).streamMessages.some((m:any)=>m.type==='closed'));
});

for(const failure of ['constructor','load'])test(`Worker ${failure} failure falls back to native WebSocket and remains interactive`,{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();
 if(failure==='constructor')await page.addInitScript('window.Worker=class {constructor(){throw new Error("Worker unavailable in test")}}');else await page.route('**/stream-worker.js',route=>route.abort());await page.goto(app.origin);await page.locator('#demo').click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('button',{name:'远端计数 +1',exact:true}).click();await mirror.getByText('1',{exact:true}).waitFor();
 assert.equal(await page.locator('#connection').getAttribute('data-transport'),'websocket');assert.equal(page.workers().length,0);
});

test('continuous typing syncs before a pause and composition stays local until confirmed',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(app.origin);await page.locator('#demo').click();
 const input=page.frameLocator('#mirror').getByPlaceholder('在这里输入中文');await input.waitFor();assert.ok(page.workers().some(w=>w.url().endsWith('/stream-worker.js')));
 const session=[...app.sessions.values()][0];await input.evaluate(e=>{let n=0;(window as any).typing=setInterval(()=>{(e as HTMLInputElement).value='typing '+ ++n;e.dispatchEvent(new Event('input',{bubbles:true}));},8);});
 let synced=false;const end=Date.now()+1200;while(Date.now()<end){if((await session.page.getByPlaceholder('在这里输入中文').inputValue()).startsWith('typing ')){synced=true;break;}await new Promise(r=>setTimeout(r,20));}
 await input.evaluate(()=>clearInterval((window as any).typing));assert.ok(synced,'typing must reach the remote page without waiting for the user to stop');await page.waitForTimeout(200);
 const before=await session.page.getByPlaceholder('在这里输入中文').inputValue();await input.evaluate(e=>{e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));(e as HTMLInputElement).value='拼音未确认';e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});await page.waitForTimeout(100);
 assert.equal(await session.page.getByPlaceholder('在这里输入中文').inputValue(),before);await input.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼音未确认'})));
 await session.page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('textarea[placeholder="在这里输入中文"]')?.value==='拼音未确认');
});

test('slow input acknowledgements coalesce typing instead of replaying a long stale queue',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(app.origin);await page.locator('#demo').click();
 const input=page.frameLocator('#mirror').getByPlaceholder('在这里输入中文');await input.waitFor();const session=[...app.sessions.values()][0];
 const original=session.submit.bind(session);let count=0;
 session.submit=async(event,peer,capture)=>{if(event.action==='input'){count++;await new Promise(r=>setTimeout(r,220));}return original(event,peer,capture);};
 await input.evaluate(e=>{let n=0;(window as any).typing=setInterval(()=>{(e as HTMLTextAreaElement).value='latest '+ ++n;e.dispatchEvent(new Event('input',{bubbles:true}));},12);});
 await page.waitForTimeout(650);await input.evaluate(e=>{clearInterval((window as any).typing);(e as HTMLTextAreaElement).value='final text';e.dispatchEvent(new Event('input',{bubbles:true}));});
 await session.page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('textarea')?.value==='final text');
 assert.ok(count<=5,`expected bounded input work, received ${count}`);assert.equal(await input.inputValue(),'final text');
});

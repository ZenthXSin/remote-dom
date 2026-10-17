import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('pages above 4 MiB keep publishing updates and can reconnect',{timeout:90000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!;
 await session.page.evaluate(()=>{document.body.replaceChildren();for(let i=0;i<90;i++){const p=document.createElement('p');p.textContent='x'.repeat(60000);document.body.append(p);}document.title='large page';});
 await session.poll(true);
 assert.equal(session.current?.title,'large page','large capture must replace the old screen');
 assert.ok(Buffer.byteLength(JSON.stringify(session.current))>4*1024*1024);
 const connect=async()=>{
  const ws=new WebSocket(app.origin.replace('http:','ws:')+`/api/sessions/${session.id}/stream`,{origin:app.origin,headers:{Cookie:cookie}});t.after(()=>ws.terminate());
  const messages:any[]=[];ws.on('message',data=>{const m=JSON.parse(data.toString());messages.push(m);if(m.type==='snapshot'||m.type==='patch')ws.send(JSON.stringify({type:'rendered',epoch:m.epoch,seq:m.seq}));});
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({type:'render-flow',window:3}));
  return {ws,messages};
 };
 const wait=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()){assert.ok(Date.now()<end,'stream update timed out');await new Promise(r=>setTimeout(r,25));}};
 const first=await connect();await wait(()=>first.messages.some(m=>m.type==='snapshot'&&m.title==='large page'));
 await session.page.evaluate(()=>{document.title='still responsive';document.querySelector('p')!.textContent='updated';});await session.poll(true);
 await wait(()=>first.messages.some(m=>m.title==='still responsive'));assert.equal(first.ws.readyState,WebSocket.OPEN);
 // Oversized documents remain bounded, and a subsequent valid page recovers.
 await (session as any).pollTask;
 const capture=(session as any).capture,original=capture.capture;
 capture.capture=async()=>({...session.current,nodes:Array.from({length:300},(_,i)=>({id:`n${i+1}`,kind:'text',text:'x'.repeat(60000)}))});
 try{await session.poll(true);assert.match((session as any).lastError,/快照/);}finally{capture.capture=original;}
 await session.poll(true);assert.equal((session as any).lastError,'');
 first.ws.close();const second=await connect();await wait(()=>second.messages.some(m=>m.type==='snapshot'&&m.title==='still responsive'));
});

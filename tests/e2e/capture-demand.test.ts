import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('capture follows viewer demand, input priority and render acknowledgements',{timeout:30000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!,internal=session as any;
 await session.poll();clearTimeout(internal.timer);internal.timer=undefined;
 let scans=0;const original=internal.capture.capture.bind(internal.capture);internal.capture.capture=async()=>{scans++;return original();};
 internal.lastViewActivity=0;
 await session.page.evaluate(()=>document.title='idle mutation');await session.poll();assert.equal(scans,0);
 session.view();await session.poll();assert.equal(session.current?.title,'idle mutation');assert.equal(scans,1);
 internal.lastViewActivity=0;await session.page.evaluate(()=>document.title='forced feedback');await session.poll(true);assert.equal(session.current?.title,'forced feedback');
 session.view();internal.queued=1;scans=0;await session.page.evaluate(()=>document.title='pending input');await session.poll();assert.equal(scans,0);internal.queued=0;await session.poll(true);assert.equal(session.current?.title,'pending input');
 const ws=new WebSocket(app.origin.replace('http:','ws:')+`/api/sessions/${session.id}/stream`,{origin:app.origin,headers:{Cookie:cookie}});t.after(()=>ws.terminate());
 const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));
 const wait=async(predicate:()=>boolean)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Stream timeout');await new Promise(r=>setTimeout(r,10));}};
 await new Promise<void>(r=>ws.once('open',r));
 // Legacy clients without flow control must continue to receive captures.
 await session.page.evaluate(()=>document.title='legacy');await session.poll();await wait(()=>messages.some(m=>m.title==='legacy'));
 ws.send(JSON.stringify({type:'render-flow',window:1}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.some(m=>m.type==='pong'));
 const legacy=messages.filter(m=>m.type==='snapshot'||m.type==='patch').at(-1);
 ws.send(JSON.stringify({type:'rendered',epoch:legacy.epoch,seq:legacy.seq}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.filter(m=>m.type==='pong').length===2);
 await session.page.evaluate(()=>document.title='fill window');await session.poll(true);await wait(()=>messages.some(m=>m.title==='fill window'));
 scans=0;await session.page.evaluate(()=>document.title='newest stalled state');await session.poll();assert.equal(scans,0,'a full render window must stop background capture');
 const frame=messages.filter(m=>m.type==='snapshot'||m.type==='patch').at(-1);
 ws.send(JSON.stringify({type:'rendered',epoch:frame.epoch,seq:frame.seq}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.filter(m=>m.type==='pong').length===3);
 await session.poll();await wait(()=>messages.some(m=>m.title==='newest stalled state'));
 await session.page.evaluate(()=>document.title='HTTP independent reader');scans=0;await session.poll();assert.equal(scans,0);
 const update=await fetch(app.origin+`/api/sessions/${session.id}/updates?epoch=${session.current!.epoch}&since=-1`,{headers:{Cookie:cookie}});assert.equal(update.status,200);await update.arrayBuffer();
 await session.poll();assert.equal(session.current?.title,'HTTP independent reader');assert.ok(scans>0,'HTTP demand must bypass a stalled WS viewer');
 internal.lastHttpViewActivity=0;await session.page.evaluate(()=>document.title='forced while stalled');await session.poll(true);assert.equal(session.current?.title,'forced while stalled');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('bounded render pipeline delivers updates before a delayed render acknowledgement',{timeout:30000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!;
 const ws=new WebSocket(app.origin.replace('http:','ws:')+`/api/sessions/${session.id}/stream`,{origin:app.origin,headers:{Cookie:cookie}});t.after(()=>ws.terminate());
 const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));
 const wait=async(predicate:()=>boolean)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Stream timeout');await new Promise(r=>setTimeout(r,5));}};
 await new Promise<void>(r=>ws.once('open',r));ws.send(JSON.stringify({type:'render-flow',window:3}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.some(m=>m.type==='pong'));
 const frames=()=>messages.filter(m=>m.type==='snapshot'||m.type==='patch'),initial=frames().at(-1);assert.ok(initial);
 const start=performance.now();const delayed=setTimeout(()=>ws.send(JSON.stringify({type:'rendered',epoch:initial.epoch,seq:initial.seq})),350);t.after(()=>clearTimeout(delayed));
 await session.page.evaluate(()=>document.title='first update');await session.poll(true);await wait(()=>frames().some(m=>m.title==='first update'));
 const latency=Math.round(performance.now()-start);console.log('delayed-ack update latency ms:',latency);assert.ok(latency<250,'a new update must not wait for the previous render acknowledgement');clearTimeout(delayed);
 for(let i=0;i<5;i++){await session.page.evaluate(i=>document.title='queued '+i,i);await session.poll(true);}
 assert.equal(frames().length,3,'the pipeline must stop at three unacknowledged frames');
 const last=frames().at(-1);ws.send(JSON.stringify({type:'rendered',epoch:'wrong',seq:last.seq}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.filter(m=>m.type==='pong').length===2);assert.equal(frames().length,3);
 ws.send(JSON.stringify({type:'rendered',epoch:last.epoch,seq:last.seq}));await wait(()=>frames().length===4);
 const catchup=frames().at(-1);assert.equal(catchup.type,'patch');assert.equal(catchup.base,last.seq);assert.equal(catchup.title,'queued 4','catch-up coalesces to the newest state even after history eviction');
 ws.send(JSON.stringify({type:'resync'}));await wait(()=>frames().length===5);assert.equal(frames().at(-1).type,'snapshot');
});

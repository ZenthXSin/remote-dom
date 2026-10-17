import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
import {unpackCapture} from '../../src/shared/capture-codec.js';

test('real Chromium compact capture preserves styles while reducing CDP transfer',{timeout:60000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!;
 await session.page.evaluate(()=>{document.body.innerHTML='<style>.row{padding:3px;border:1px solid red;color:rgb(20,30,40);display:flex;gap:2px}.row::before{content:"item";color:blue}</style>'+Array.from({length:1200},(_,i)=>`<div class="row" style="width:${100+i%60}px"><span>row ${i}</span></div>`).join('');});
 await session.poll(true);const capture=(session as any).capture;
 const plainStart=performance.now(),plain=await capture.evaluate(capture.main,'window.__remoteDom.capture()'),plainMs=Math.round(performance.now()-plainStart);
 const packedStart=performance.now(),packed=await capture.evaluate(capture.main,'window.__remoteDom.capturePacked()'),packedMs=Math.round(performance.now()-packedStart);
 assert.deepEqual(JSON.parse(JSON.stringify(unpackCapture(packed))),plain);
 const plainBytes=Buffer.byteLength(JSON.stringify(plain)),packedBytes=Buffer.byteLength(JSON.stringify(packed));
 console.log(JSON.stringify({plainBytes,packedBytes,plainMs,packedMs}));assert.ok(packedBytes<plainBytes*.5);
 await session.page.evaluate(()=>{document.querySelector('.row')!.setAttribute('style','color:rgb(90,80,70);width:333px');});await session.poll(true);
 assert.ok(session.current!.nodes.some(n=>n.style?.width==='333px'&&n.style?.color==='rgb(90,80,70)'));
});

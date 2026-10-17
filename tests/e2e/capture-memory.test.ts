import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('sustained DOM replacement keeps capture identities and retained heap bounded',{timeout:600000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!;
 await session.page.evaluate(()=>{document.body.replaceChildren();const input=document.createElement('input');input.id='draft';input.value='preserve draft';document.body.append(input,document.createElement('main'));});
 const samples:number[]=[];
 for(let i=0;i<300;i++){
  await session.page.evaluate(i=>{document.querySelector('main')!.innerHTML=Array.from({length:1200},(_,n)=>`<span style="color:rgb(${i%255},20,30)">row ${n} revision ${i}</span>`).join('');},i);
  await session.poll(true);
  assert.ok(session.current?.nodes.some(n=>n.text?.includes(`revision ${i}`)),'latest remote document is captured');
  assert.ok((session as any).capture.ids.size<2600,'detached identities are pruned');
  if(i%50===49){global.gc?.();samples.push(Math.round(process.memoryUsage().heapUsed/1024/1024));console.log(JSON.stringify({captures:i+1,heapMiB:samples.at(-1)}));}
 }
 assert.equal(await session.page.locator('#draft').inputValue(),'preserve draft');
 if(global.gc)assert.ok(samples.at(-1)!-samples[1]<40,'retained heap must plateau after warmup');
});

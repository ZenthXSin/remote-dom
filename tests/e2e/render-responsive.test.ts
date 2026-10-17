import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('large initial render yields to browser tasks and keeps ordered patches and reset usable',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript('window.__name=(value)=>value');await page.goto(app.origin+'/mirror');
 const result=await page.evaluate(async()=>{
  const channel=new MessageChannel();const rendered:number[]=[];let ticks=0,initialTicks=0;const timer=setInterval(()=>ticks++,0);
  const next=(type:string)=>new Promise<any>(resolve=>{const listener=(e:MessageEvent)=>{if(e.data.type===type){channel.port1.removeEventListener('message',listener);resolve(e.data);}};channel.port1.addEventListener('message',listener);});
  channel.port1.start();const ready=next('ready');window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
  channel.port1.addEventListener('message',e=>{if(e.data.type==='rendered'){rendered.push(e.data.seq);if(e.data.seq===0)initialTicks=ticks;}});
  const children=Array.from({length:1800},(_,i)=>'n'+(i+2));
  const nodes=[{id:'n1',kind:'element',tag:'div',children},...children.map((id,i)=>({id,kind:'element',tag:'div',children:[],attrs:{title:'row '+i},style:{display:'block',color:'rgb(12, 34, 56)',height:'2px',width:'100px','background-color':'rgb(240, 240, 240)'}}))];
  const initial={type:'snapshot',protocol:1,epoch:'test',seq:0,root:'n1',nodes,url:'https://example.test',title:'load',scrollX:0,scrollY:0};
  const finished=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='rendered'&&e.data.seq===2)resolve();}));
  channel.port1.postMessage({...initial,renderToken:1});
  channel.port1.postMessage({...initial,type:'patch',base:0,seq:1,upsert:[{...nodes[1],attrs:{title:'updated'}}],remove:[],renderToken:2});
  channel.port1.postMessage({...initial,type:'patch',base:1,seq:2,upsert:[{...nodes[0],children:children.slice(0,-1)}],remove:[children.at(-1)],renderToken:3});
  await finished;clearInterval(timer);const title=document.querySelector('[data-rd-node="n2"]')?.getAttribute('title'),count=document.querySelectorAll('[data-rd-node]').length;
  channel.port1.postMessage({type:'reset'});const reset=next('rendered');channel.port1.postMessage({...initial,nodes:[{...nodes[0],children:[]}],epoch:'new',seq:0,renderToken:4});await reset;
  return {initialTicks,rendered,title,count,resetCount:document.querySelectorAll('[data-rd-node]').length};
 });
 assert.ok(result.initialTicks>=2,'initial DOM work must yield to other browser tasks');assert.deepEqual(result.rendered,[0,1,2,0]);assert.equal(result.title,'updated');assert.equal(result.count,1800);assert.equal(result.resetCount,1);
});

test('slow WebSocket renderer receives the latest revision while input acknowledgements remain independent',{timeout:30000},async t=>{
 const {WebSocket}=await import('ws');
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const context=await browser.newContext(),page=await context.newPage();
 await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0],cookies=(await context.cookies()).map(c=>`${c.name}=${c.value}`).join('; ');
 const ws=new WebSocket(app.origin.replace('http:','ws:')+`/api/sessions/${session.id}/stream`,{origin:app.origin,headers:{Cookie:cookies}});t.after(()=>ws.terminate());
 const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));
 const wait=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected stream message');};
 await new Promise<void>(resolve=>ws.once('open',resolve));ws.send(JSON.stringify({type:'render-flow'}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.some(m=>m.type==='pong')&&messages.some(m=>m.type==='snapshot'));
 const frames=()=>messages.filter(m=>m.type==='snapshot'||m.type==='patch'),initial=frames().at(-1),initialCount=frames().length;
 for(let i=0;i<5;i++){await session.page.evaluate(i=>document.title='revision '+i,i);await session.poll(true);}
 ws.send(JSON.stringify({type:'event',epoch:initial.epoch,eventId:1,action:'viewport',width:410,height:740}));await wait(()=>messages.some(m=>m.type==='ack'&&m.eventId===1));
 assert.equal(frames().length,initialCount,'unrendered frames must not accumulate on the wire');
 ws.send(JSON.stringify({type:'rendered',epoch:'wrong',seq:initial.seq}));ws.send(JSON.stringify({type:'ping'}));await wait(()=>messages.filter(m=>m.type==='pong').length===2);assert.equal(frames().length,initialCount);
 ws.send(JSON.stringify({type:'rendered',epoch:initial.epoch,seq:initial.seq}));await wait(()=>frames().length>initialCount);assert.ok(frames().at(-1).seq>initial.seq);assert.equal(frames().at(-1).title,'revision 4');
 // Resync is also usable when a previous render acknowledgement was lost.
 ws.send(JSON.stringify({type:'resync'}));await wait(()=>frames().length>initialCount+1);assert.equal(frames().at(-1).type,'snapshot');
 const held=frames().at(-1),count=frames().length;
 await session.navigate(app.fixtureOrigin+'/browser-shell');await session.poll(true);
 ws.send(JSON.stringify({type:'rendered',epoch:held.epoch,seq:held.seq}));await wait(()=>frames().length>count);
 assert.equal(frames().at(-1).type,'snapshot');assert.notEqual(frames().at(-1).epoch,held.epoch);
});

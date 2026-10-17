import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('slow acknowledgements coalesce drag samples without delaying the final move and release',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:900,height:600}});await page.goto(app.origin+'/mirror');
 await page.evaluate(async()=>{
  const channel=new MessageChannel();(window as any).__channel=channel.port1;(window as any).__events=[];
  const ready=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='ready')resolve();if(e.data.type==='event')(window as any).__events.push(e.data);}));channel.port1.start();window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
  const rendered=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='rendered')resolve();}));
  channel.port1.postMessage({type:'snapshot',protocol:1,epoch:'drag',seq:0,root:'n1',url:'https://example.test/',title:'drag',scrollX:0,scrollY:0,nodes:[{id:'n1',kind:'element',tag:'div',children:[],style:{width:'800px',height:'200px','background-color':'gray'}}]});await rendered;
 });
 await page.mouse.move(20,30);await page.mouse.down();await page.mouse.move(500,30,{steps:30});await page.waitForTimeout(50);
 let events=await page.evaluate(()=>(window as any).__events);let moves=events.filter((e:any)=>e.key==='move');assert.equal(moves.length,1,'missing acknowledgements must not create a stale movement queue');
 await page.evaluate(id=>(window as any).__channel.postMessage({type:'ack',eventId:id,inputRevision:1}),moves[0].eventId);
 await page.waitForFunction(()=>(window as any).__events.filter((e:any)=>e.key==='move').length===2);
 events=await page.evaluate(()=>(window as any).__events);moves=events.filter((e:any)=>e.key==='move');assert.equal(moves[1].x,500,'acknowledgement releases the latest actual sample');
 await page.mouse.move(650,30,{steps:10});await page.mouse.up();
 await page.waitForFunction(()=>(window as any).__events.some((e:any)=>e.key==='up'));
 events=await page.evaluate(()=>(window as any).__events);const pointer=events.filter((e:any)=>e.action==='pointer');
 assert.equal(pointer.filter((e:any)=>e.key==='down').length,1);assert.equal(pointer.filter((e:any)=>e.key==='up').length,1);
 assert.equal(pointer.at(-2).key,'move');assert.equal(pointer.at(-2).x,650);assert.equal(pointer.at(-1).key,'up');assert.equal(pointer.at(-1).x,650);
 assert.equal(pointer.filter((e:any)=>e.key==='move').length,3);console.log(JSON.stringify({sampledPositions:40,transmittedMoves:3,releaseWaitedForAck:false}));
});

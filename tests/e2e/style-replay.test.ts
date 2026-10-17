import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('state-only patches skip unchanged inline CSS and still reset changed styles',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript('window.__name=(v)=>v');await page.goto(app.origin+'/mirror');
 const result=await page.evaluate(async()=>{
 const channel=new MessageChannel();channel.port1.start();const next=()=>new Promise<void>(resolve=>{const listener=(e:MessageEvent)=>{if(e.data.type==='rendered'){channel.port1.removeEventListener('message',listener);resolve();}};channel.port1.addEventListener('message',listener);});
 const ready=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='ready')resolve();}));window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
 const children=Array.from({length:1200},(_,i)=>({id:'n'+(i+2),kind:'element',tag:'div',children:[],attrs:{title:'row'},scrollTop:0,scrollLeft:0,style:{width:'100px',height:'2px',color:'rgb(12, 34, 56)'}}));
 const state={protocol:1,epoch:'styles',root:'n1',url:'https://example.test',title:'styles',scrollX:0,scrollY:0};let done=next();channel.port1.postMessage({...state,type:'snapshot',seq:0,nodes:[{id:'n1',kind:'element',tag:'div',children:children.map(n=>n.id)},...children]});await done;
 let reads=0;const original=CSSStyleDeclaration.prototype.getPropertyValue;CSSStyleDeclaration.prototype.getPropertyValue=function(key){reads++;return original.call(this,key);};
 const start=performance.now();done=next();channel.port1.postMessage({...state,type:'patch',base:0,seq:1,remove:[],upsert:children.map(n=>({...n,attrs:{title:'changed'}}))});await done;
 const elapsed=performance.now()-start,styleReads=reads;CSSStyleDeclaration.prototype.getPropertyValue=original;
 done=next();channel.port1.postMessage({...state,type:'patch',base:1,seq:2,remove:[],upsert:[{...children[0],style:{...children[0].style,transform:'translateX(10px)'}}]});await done;
 const translated=getComputedStyle(document.querySelector('[data-rd-node="n2"]')!).transform;
 done=next();channel.port1.postMessage({...state,type:'patch',base:2,seq:3,remove:[],upsert:[children[0]]});await done;
 return {elapsed:Math.round(elapsed),styleReads,translated,reset:getComputedStyle(document.querySelector('[data-rd-node="n2"]')!).transform};
 });console.log(JSON.stringify(result));assert.ok(result.styleReads<100,'unchanged CSS must not be read and replayed for each state update');assert.match(result.translated,/10/);assert.equal(result.reset,'none');
});

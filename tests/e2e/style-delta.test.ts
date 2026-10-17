import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('one-property updates touch only changed CSS and preserve shorthand overrides',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript('window.__name=(v)=>v');await page.goto(app.origin+'/mirror');
 const result=await page.evaluate(async()=>{
  const channel=new MessageChannel();channel.port1.start();const next=()=>new Promise<void>(resolve=>{const f=(e:MessageEvent)=>{if(e.data.type==='rendered'){channel.port1.removeEventListener('message',f);resolve();}};channel.port1.addEventListener('message',f);});
  const ready=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='ready')resolve();}));window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
  const children=Array.from({length:1200},(_,i)=>({id:'n'+(i+2),kind:'element',tag:'div',children:[],style:{width:'100px',height:'2px',color:'rgb(12, 34, 56)',display:'flex',gap:'3px','row-gap':'5px','column-gap':'7px'}}));
  const state={protocol:1,epoch:'delta',root:'n1',url:'https://example.test',title:'styles',scrollX:0,scrollY:0};let done=next();channel.port1.postMessage({...state,type:'snapshot',seq:0,nodes:[{id:'n1',kind:'element',tag:'div',children:children.map(n=>n.id)},...children]});await done;
  let reads=0,writes=0;const get=CSSStyleDeclaration.prototype.getPropertyValue,set=CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.getPropertyValue=function(key){reads++;return get.call(this,key);};CSSStyleDeclaration.prototype.setProperty=function(key,value,priority){writes++;return set.call(this,key,value,priority);};
  const start=performance.now();done=next();channel.port1.postMessage({...state,type:'patch',base:0,seq:1,remove:[],upsert:children.map(n=>({...n,style:{...n.style,transform:'translateX(1px)'}}))});await done;
  const ms=Math.round(performance.now()-start),styleReads=reads,styleWrites=writes;CSSStyleDeclaration.prototype.getPropertyValue=get;CSSStyleDeclaration.prototype.setProperty=set;
  done=next();channel.port1.postMessage({...state,type:'patch',base:1,seq:2,remove:[],upsert:[{...children[0],style:{...children[0].style,gap:'20px'}}]});await done;
  const computed=getComputedStyle(document.querySelector('[data-rd-node="n2"]')!);
  return {ms,styleReads,styleWrites,transform:computed.transform,rowGap:computed.rowGap,columnGap:computed.columnGap};
 });console.log(JSON.stringify(result));assert.ok(result.styleReads<=1250);assert.ok(result.styleWrites<=1250);assert.equal(result.transform,'none');assert.equal(result.rowGap,'5px');assert.equal(result.columnGap,'7px');
});

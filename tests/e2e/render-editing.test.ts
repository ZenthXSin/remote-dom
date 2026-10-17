import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('typing that begins between render slices survives the rest of the patch',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript('window.__name=(v)=>v');await page.goto(app.origin+'/mirror');
 const result=await page.evaluate(async()=>{
  const channel=new MessageChannel();channel.port1.start();const next=()=>new Promise<void>(resolve=>{const f=(e:MessageEvent)=>{if(e.data.type==='rendered'){channel.port1.removeEventListener('message',f);resolve();}};channel.port1.addEventListener('message',f);});
  const ready=new Promise<void>(resolve=>channel.port1.addEventListener('message',e=>{if(e.data.type==='ready')resolve();}));window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
  const children=Array.from({length:2400},(_,i)=>({id:'n'+(i+2),kind:'element',tag:'div',children:[],style:{width:'100px',height:'2px'}}));
  const editor={id:'n3000',kind:'element',tag:'div',editable:true,editableValue:'remote text',children:['n3001'],style:{width:'300px',height:'40px'}},text={id:'n3001',kind:'text',text:'remote text'};
  const state={protocol:1,epoch:'editing',root:'n1',url:'https://example.test/',title:'editing',scrollX:0,scrollY:0};let done=next();channel.port1.postMessage({...state,type:'snapshot',seq:0,nodes:[{id:'n1',kind:'element',tag:'div',children:[...children.map(n=>n.id),editor.id]},...children,editor,text]});await done;
  let typed=false,started=false,rendered=false,typedBeforeRender=false;
  const original=CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty=function(key,value,priority){
   if(!started&&key==='transform'){
    started=true;setTimeout(()=>{const field=document.querySelector<HTMLElement>('[data-rd-node="n3000"]')!;field.focus({preventScroll:true});field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));field.textContent='正在输入';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'正在输入',isComposing:true}));typed=true;typedBeforeRender=!rendered;},0);
   }
   return original.call(this,key,value,priority);
  };
  done=next();channel.port1.postMessage({...state,type:'patch',base:0,seq:1,remove:[],upsert:[...children.map(n=>({...n,style:{...n.style,transform:'translateX(1px)'}})),editor,text]});await done;rendered=true;CSSStyleDeclaration.prototype.setProperty=original;
  return {typed,typedBeforeRender,value:document.querySelector('[data-rd-node="n3000"]')!.textContent};
 });assert.equal(result.typed,true);assert.equal(result.typedBeforeRender,true);assert.equal(result.value,'正在输入');
});

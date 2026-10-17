import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('partial layout updates never turn scroll clamping into user intent',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.addInitScript('window.__name=(value)=>value');await page.goto(app.origin+'/mirror');
 const result=await page.evaluate(async()=>{
  const channel=new MessageChannel(),scrolls:unknown[]=[];
  const next=(type:string)=>new Promise<void>(resolve=>{const listener=(e:MessageEvent)=>{if(e.data.type===type){channel.port1.removeEventListener('message',listener);resolve();}};channel.port1.addEventListener('message',listener);});
  channel.port1.start();const ready=next('ready');window.postMessage({type:'initialize'},'*',[channel.port2]);await ready;
  channel.port1.addEventListener('message',e=>{if(e.data.type==='event'&&e.data.action==='scroll')scrolls.push(e.data);});
  const spacer=(id:string,width:string)=>({id,kind:'element',tag:'div',children:[],style:{width,height:'30px','flex-shrink':'0'}});
  const fillers=Array.from({length:1800},(_,i)=>({id:'n'+(i+5),kind:'element',tag:'div',children:[],style:{height:'1px',width:'100px',color:'rgb(0, 0, 0)'}}));
  const scroller={id:'n2',kind:'element',tag:'div',children:['n3','n4'],scrollLeft:500,scrollTop:0,style:{display:'flex',width:'300px',height:'70px','overflow-x':'auto','overflow-y':'hidden'}};
  const nodes=[{id:'n1',kind:'element',tag:'div',children:['n2',...fillers.map(n=>n.id)]},scroller,spacer('n3','1000px'),spacer('n4','0px'),...fillers];
  const state={protocol:1,epoch:'layout',root:'n1',url:'https://example.test',title:'layout',scrollX:0,scrollY:0};
  let done=next('rendered');channel.port1.postMessage({...state,type:'snapshot',seq:0,nodes});await done;await new Promise(r=>setTimeout(r,100));scrolls.length=0;
  // Updating these siblings in separate render slices briefly removes overflow,
  // even though the completed remote layout keeps the same scroll range.
  done=next('rendered');channel.port1.postMessage({...state,type:'patch',base:0,seq:1,remove:[],upsert:[spacer('n3','0px'),...fillers.map(n=>({...n,style:{...n.style,color:'rgb(12, 34, 56)'}})),spacer('n4','1000px')]});await done;await new Promise(r=>setTimeout(r,150));
  const node=document.querySelector('[data-rd-node="n2"]')!,left=node.scrollLeft,layoutScrolls=[...scrolls];
  node.scrollLeft=600;await new Promise(r=>setTimeout(r,150));
  return {left,scrolls:layoutScrolls,userScrolls:scrolls.length};
 });
 assert.equal(result.left,500,'a transient local reflow must not override the remote scroll position');
 assert.ok(result.userScrolls>0,'scrolling after rendering still forwards normally');
 assert.deepEqual(result.scrolls,[],'layout-only changes must not feed synthetic scroll intent back to the remote page');
});

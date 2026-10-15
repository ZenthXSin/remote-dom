import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('continuous scrolling syncs before the gesture ends and independent scrollers do not cancel each other',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/edge-menu');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Bottom menu'}).waitFor();const session=[...app.sessions.values()][0];
 await session.page.evaluate(()=>{for(const name of ['First scroller','Second scroller']){const box=document.createElement('div');box.setAttribute('aria-label',name);box.style.cssText='height:120px;width:250px;overflow:auto';const content=document.createElement('div');content.style.height='5000px';content.textContent='Scrollable content';box.append(content);document.body.prepend(box);}});await session.poll(true);
 await mirror.getByLabel('Second scroller',{exact:true}).waitFor();const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;
 await frame.evaluate(()=>{const nodes=['First scroller','Second scroller'].map(name=>document.querySelector(`[aria-label="${name}"]`)!);(window as any).__scrollTimer=setInterval(()=>{for(const node of nodes)node.scrollTop+=4;},16);});
 try{
  const started=Date.now();let positions:number[]=[];
  while(Date.now()-started<1000){positions=await session.page.evaluate(()=>['First scroller','Second scroller'].map(name=>document.querySelector(`[aria-label="${name}"]`)!.scrollTop));if(positions.every(y=>y>0))break;await page.waitForTimeout(30);}
  assert.ok(positions.every(y=>y>0),'both remote scroll positions must advance while local scrolling continues');
  console.log('continuous-scroll first remote update ms:',Date.now()-started);
 }finally{await frame.evaluate(()=>clearInterval((window as any).__scrollTimer));}
});

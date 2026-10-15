import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('page zoom, window expansion and viewport resize update remote layout',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();
 await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;
 async function layout(scale:number){
  const width=await page.locator('#mirror').evaluate((node,scale)=>Math.round((node as HTMLElement).clientWidth/scale),scale);
  for(let i=0;i<30;i++){if(await session.page.evaluate(()=>innerWidth)===width)return;await new Promise(resolve=>setTimeout(resolve,80));}
  assert.equal(await session.page.evaluate(()=>innerWidth),width);
 }
 await page.getByRole('button',{name:'放大页面',exact:true}).click();await layout(1.25);
 assert.equal(await frame.evaluate(()=>document.getElementById('mirror-root')!.style.getPropertyValue('zoom')),'1.25');
 await page.getByRole('button',{name:'恢复 100%',exact:true}).click();await layout(1);
 await page.getByRole('button',{name:'放大窗口',exact:true}).click();await layout(1);
 assert.ok(await page.locator('#mirror').evaluate(node=>(node as HTMLElement).clientWidth)>1400);
 await page.locator('#floating-ball').click();await page.getByRole('button',{name:'退出全屏',exact:true}).click();await layout(1);
 await page.setViewportSize({width:1000,height:800});await layout(1);
 await page.getByRole('button',{name:'缩小页面',exact:true}).click();await layout(.75);
 assert.equal(await frame.evaluate(()=>document.getElementById('mirror-root')!.style.getPropertyValue('zoom')),'0.75');
});

test('long pages scroll inside a bounded viewport without growing the workbench on desktop or mobile',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/scroll');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Touch scroll fixture'}).waitFor();const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;const session=[...app.sessions.values()][0];
 const dimensions=()=>page.evaluate(()=>({frame:document.getElementById('mirror')!.clientHeight,viewer:document.getElementById('viewer')!.getBoundingClientRect().height,workbench:document.documentElement.scrollHeight}));
 for(const device of [{width:1440,height:1000,maxHeight:640},{width:390,height:844,maxHeight:500}]){
  await page.setViewportSize({width:device.width,height:device.height});await page.waitForTimeout(450);const before=await dimensions();assert.ok(before.viewer<=device.maxHeight+1,`viewer remains bounded: ${JSON.stringify(before)}`);assert.ok(before.frame>250);
  await session.page.evaluate(()=>{const extra=document.createElement('div');extra.style.height='10000px';extra.textContent='Long remote content';document.body.append(extra);});await mirror.getByText('Long remote content',{exact:true}).last().waitFor();assert.deepEqual(await dimensions(),before,'remote document growth must not resize the viewport or workbench');
  await frame.evaluate(()=>window.scrollTo(0,650));for(let attempt=0;attempt<40;attempt++){if(await session.page.evaluate(()=>scrollY)>600)break;await page.waitForTimeout(80);}assert.ok(await frame.evaluate(()=>scrollY)>600);assert.ok(await session.page.evaluate(()=>scrollY)>600);assert.deepEqual(await dimensions(),before,'scrolling stays inside the frame');
 }
 await mirror.getByRole('button',{name:'Tap below the fold'}).click();await mirror.getByText('Clicked remotely',{exact:true}).waitFor();
});

test('late session creation responses preserve scrolling in an already connected page',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);await page.route('**/api/sessions',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,1600));await route.fulfill({response});});await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/scroll');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();await page.frameLocator('#mirror').getByRole('heading',{name:'Touch scroll fixture'}).waitFor();const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;await frame.evaluate(()=>scrollTo(0,700));await page.waitForFunction(()=>(document.getElementById('create') as HTMLButtonElement).disabled===false);await page.waitForTimeout(300);assert.ok(await frame.evaluate(()=>scrollY)>650,'finishing creation must not reset an already connected document');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('touch viewport, delayed scroll acknowledgement and same-document resync do not pull the user back',{timeout:60000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
  const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
  const page=await context.newPage();await page.goto(app.origin);
  await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/scroll');
  await page.getByRole('button',{name:'新建浏览器',exact:true}).tap();
  const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Touch scroll fixture'}).waitFor({timeout:20000});
  const frame=page.frames().find(frame=>frame.url().endsWith('/mirror'))!;
  const session=[...app.sessions.values()][0];
  const size=await frame.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert.equal(session.page.viewportSize()?.width,size.width,'remote browser starts with the real mobile viewport');
  await page.route('**/events',async route=>{
    const input=route.request().postDataJSON();
    if((input.events??[input.event]).some((event:any)=>event?.action==='scroll'))await new Promise(resolve=>setTimeout(resolve,550));
    await route.continue();
  });
  await frame.evaluate(()=>{
    const trace:number[]=[];(window as unknown as {scrollTrace:number[]}).scrollTrace=trace;
    document.addEventListener('scroll',()=>trace.push(scrollY));
    window.scrollTo(0,700);
  });
  // Force a full same-document snapshot while the authority still has scrollY=0.
  await page.locator('.advanced-tools').evaluate(node=>{(node as HTMLDetailsElement).open=true;});await page.getByRole('button',{name:'重新同步',exact:true}).click({force:true});
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.ok(await frame.evaluate(()=>scrollY)>650,'stale full snapshots must not erase local scroll');
  for(let i=0;i<25;i++){if(await session.page.evaluate(()=>scrollY)>650)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(await session.page.evaluate(()=>scrollY)>650,'scroll intent eventually reaches the authority');
  const box=await page.locator('#mirror').boundingBox();assert.ok(box);
  await page.locator('#mirror').scrollIntoViewIfNeeded();
  const visible=await page.locator('#mirror').boundingBox();assert.ok(visible);
  const cdp=await context.newCDPSession(frame);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:size.width/2,y:350}]});
  for(let step=1;step<=7;step++){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:size.width/2,y:350-step*30}]});
    await new Promise(resolve=>setTimeout(resolve,45));
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await new Promise(resolve=>setTimeout(resolve,900));
  const position=await frame.evaluate(()=>scrollY);const remotePosition=await session.page.evaluate(()=>scrollY);
  const movementTrace=await frame.evaluate(()=>(window as unknown as {scrollTrace:number[]}).scrollTrace);
  assert.ok(position>700,`native touch movement remains in place after delayed updates: ${JSON.stringify({position,remotePosition,movementTrace,visible})}`);
  await mirror.getByRole('button',{name:'Tap below the fold'}).tap();
  await mirror.getByText('Clicked remotely',{exact:true}).waitFor({timeout:15000});
  const trace=await frame.evaluate(()=>(window as unknown as {scrollTrace:number[]}).scrollTrace);
  assert.ok(trace.every(y=>y>400),'no jump back to the old top position during user interaction');
});

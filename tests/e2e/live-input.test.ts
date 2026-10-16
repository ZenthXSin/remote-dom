import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
import {generateDeviceProfile} from '../../src/server/device-profile.js';

for(const touch of [false,true])for(const transport of ['http','websocket'])test(`live ${touch?'touch':'mouse'} press, release and cancel over ${transport}`,{timeout:45000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'live-input-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'profile.json');
 const profile={...generateDeviceProfile()};if(touch)Object.assign(profile,{platform:'Android',device:'Pixel 7 · Android 模拟',screen:{width:412,height:915},deviceScaleFactor:2.625,isMobile:true,hasTouch:true});
 await writeFile(path,JSON.stringify({containerKey:hostname(),profile}));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',DEVICE_PROFILE_PATH:path});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1400,height:1000},isMobile:touch,hasTouch:touch,extraHTTPHeaders:transport==='http'?{'X-Engine-Http-Transport':'1'}:{}});
 const page=await context.newPage();await page.goto(app.origin);
 await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin);
 await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');const button=mirror.getByRole('button',{name:'远端计数 +1'});await button.waitFor({timeout:20000});
 const session=[...app.sessions.values()][0];
 await session.page.evaluate(()=>{
  (window as any).inputTrace=[];
  for(const type of ['pointerdown','pointermove','pointerup','touchstart','touchend','touchcancel','click','keydown','keyup'])document.addEventListener(type,event=>{
   const e=event as PointerEvent;(window as any).inputTrace.push({type,pointerType:e.pointerType,trusted:e.isTrusted,time:performance.now(),ctrl:e.ctrlKey,meta:e.metaKey,target:(e.target as Element).id,key:(event as KeyboardEvent).key,repeat:(event as KeyboardEvent).repeat,pressure:e.pressure,tiltX:e.tiltX,tiltY:e.tiltY});
  },true);
 });
 const trace=()=>session.page.evaluate(()=>(window as any).inputTrace as {type:string;pointerType:string;trusted:boolean;time:number;ctrl:boolean;meta:boolean;target:string;key:string;repeat:boolean;pressure:number;tiltX:number;tiltY:number}[]);
 const waitFor=async(type:string)=>{for(let i=0;i<60;i++){if((await trace()).some(e=>e.type===type))return;await new Promise(r=>setTimeout(r,50));}assert.fail(`Missing ${type}: ${JSON.stringify(await trace())}`);};
 await button.scrollIntoViewIfNeeded();const box=(await button.boundingBox())!;const point={x:box.x+box.width/2,y:box.y+box.height/2};
 const cdp=await context.newCDPSession(page);
 const down=async()=>{if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});else{await page.mouse.move(point.x,point.y);await page.keyboard.down('Control');await page.keyboard.down('Meta');await page.mouse.down();}};
 const up=async()=>{if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else{await page.mouse.up();await page.keyboard.up('Control');await page.keyboard.up('Meta');}};
 await down();await waitFor('pointerdown');
 assert.equal((await trace()).filter(e=>e.type==='pointerup'||e.type==='click').length,0,'press reaches remote before local release');
 await new Promise(r=>setTimeout(r,180));await up();await waitFor('click');
 let events=await trace();const press=events.find(e=>e.type==='pointerdown')!,release=events.find(e=>e.type==='pointerup')!;
 assert.equal(press.pointerType,touch?'touch':'mouse');assert.ok(press.trusted&&release.trusted);
 assert.ok(release.time-press.time>=150,'holding duration is not collapsed into an immediate click');
 assert.equal(events.filter(e=>e.type==='click').length,1,'compatibility click must not activate twice');
 if(!touch){assert.equal(press.ctrl,true);assert.equal(press.meta,true,'Meta must not be collapsed into Control');}
 await session.page.evaluate(()=>(window as any).inputTrace=[]);
 await down();await waitFor('pointerdown');
 const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;await frame.evaluate(()=>window.dispatchEvent(new Event('blur')));
 await waitFor(touch?'touchcancel':'pointerup');await up();
 await new Promise(r=>setTimeout(r,250));events=await trace();
 assert.equal(events.filter(e=>e.type==='click'&&e.target==='increment').length,0,'cancel must not activate the pressed button');
 await session.page.evaluate(()=>(window as any).inputTrace=[]);await button.focus();
 await page.keyboard.down('Control');await page.keyboard.down('Meta');await page.keyboard.down('k');
 await waitFor('keydown');
 for(let i=0;i<60&&!(await trace()).some(e=>e.type==='keydown'&&e.key==='k');i++)await new Promise(r=>setTimeout(r,50));
 events=await trace();const key=events.find(e=>e.type==='keydown'&&e.key==='k');assert.ok(key,'key down arrives before release');assert.equal(key.ctrl,true);assert.equal(key.meta,true);
 assert.equal(events.filter(e=>e.type==='keyup'&&e.key==='k').length,0);
 await page.keyboard.down('k');await page.keyboard.up('k');await page.keyboard.up('Meta');await page.keyboard.up('Control');
 for(let i=0;i<60&&!(await trace()).some(e=>e.type==='keyup'&&e.key==='k');i++)await new Promise(r=>setTimeout(r,50));
 events=await trace();assert.deepEqual(events.filter(e=>e.type==='keydown'&&e.key==='k').map(e=>e.repeat),[false,true]);
 assert.equal(events.filter(e=>e.type==='keyup'&&e.key==='k').length,1);
 await session.page.evaluate(()=>(window as any).inputTrace=[]);await page.keyboard.down('ArrowRight');await waitFor('keydown');
 await frame.evaluate(()=>window.dispatchEvent(new Event('blur')));await waitFor('keyup');await page.keyboard.up('ArrowRight');
 if(transport==='websocket'){
  await session.page.evaluate(()=>(window as any).inputTrace=[]);await down();await waitFor('pointerdown');
  for(const socket of session.sockets)socket.close(1012,'Test connection loss during press');
  await waitFor(touch?'touchcancel':'pointerup');await up();
  assert.equal((await trace()).filter(e=>e.type==='click'&&e.target==='increment').length,0);
  await page.waitForFunction(()=>document.getElementById('connection')?.textContent==='在线'&&!document.getElementById('mirror')?.inert);
  await button.scrollIntoViewIfNeeded();const fresh=(await button.boundingBox())!;point.x=fresh.x+fresh.width/2;point.y=fresh.y+fresh.height/2;
 }
 if(!touch){
  await session.page.evaluate(()=>(window as any).inputTrace=[]);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1,pointerType:'pen',force:.7,tiltX:20,tiltY:-15});
  await waitFor('pointerdown');const pen=(await trace()).find(e=>e.type==='pointerdown')!;
  assert.equal(pen.pointerType,'pen');assert.ok(Math.abs(pen.pressure-.7)<.01);assert.equal(pen.tiltX,20);assert.equal(pen.tiltY,-15);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1,pointerType:'pen'});await waitFor('pointerup');
 }else{
  await session.navigate(app.fixtureOrigin+'/drag-controls');await mirror.getByRole('heading',{name:'Drag controls'}).waitFor();
  const thumb=mirror.getByLabel('Drag thumb');await thumb.scrollIntoViewIfNeeded();const rect=(await thumb.boundingBox())!;const start={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  if(transport==='http')await page.route('**/events',async route=>{await new Promise(r=>setTimeout(r,120));await route.continue();});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  for(let x=4;x<=120;x+=4)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+x,y:start.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mirror.getByText('Dragged: 120 / released',{exact:true}).waitFor();
 }


});

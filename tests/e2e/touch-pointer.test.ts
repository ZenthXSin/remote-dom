import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
import {generateDeviceProfile} from '../../src/server/device-profile.js';

test('phone taps retain trusted touch events in a touch-enabled remote browser',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'touch-pointer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'profile.json');
 await writeFile(path,JSON.stringify({containerKey:hostname(),profile:{...generateDeviceProfile(),platform:'Android',device:'Pixel 7 · Android 模拟',screen:{width:412,height:915},deviceScaleFactor:2.625,isMobile:true,hasTouch:true}}));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',DEVICE_PROFILE_PATH:path});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();await page.goto(app.origin);
 await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/scroll');
 await page.getByRole('button',{name:'新建浏览器',exact:true}).tap();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Touch scroll fixture'}).waitFor({timeout:20000});
 const session=[...app.sessions.values()][0];
 await session.page.evaluate(()=>{
  (window as any).tapTrace=[];
  for(const name of ['pointerdown','touchstart','touchend','click'])document.addEventListener(name,event=>(window as any).tapTrace.push({type:event.type,pointerType:(event as PointerEvent).pointerType,trusted:event.isTrusted}),true);
 });
 await mirror.getByRole('button',{name:'Tap below the fold'}).tap();
 await mirror.getByText('Clicked remotely',{exact:true}).waitFor({timeout:15000});
 const trace=await session.page.evaluate(()=>(window as any).tapTrace);
 assert.ok(trace.some((e:any)=>e.type==='pointerdown'&&e.pointerType==='touch'&&e.trusted),JSON.stringify(trace));
 assert.ok(trace.some((e:any)=>e.type==='touchstart'&&e.trusted));
 assert.ok(trace.some((e:any)=>e.type==='touchend'&&e.trusted));
 assert.equal(trace.filter((e:any)=>e.type==='click').length,1);
});

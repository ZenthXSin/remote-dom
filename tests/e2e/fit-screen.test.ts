import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {createApp} from '../../src/server/app.js';import {readConfig} from '../../src/server/config.js';
test('Android fit resizes the remote viewport to the available stage in both orientations',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());const browser=await chromium.launch({executablePath:config.chromiumPath,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/api/state',async route=>{const response=await route.fetch();const state=await response.json();state.deviceProfile.platform='Android';await route.fulfill({response,json:state});});await page.goto(app.origin);await page.locator('#demo').click();await page.locator('#mirror').waitFor();await page.locator('#zoom-out').click();
 for(const size of [{width:390,height:724},{width:844,height:390},{width:1440,height:1000}]){
 await page.setViewportSize(size);await page.locator('#expand').click();await page.locator('#floating-ball').click();await page.getByRole('button',{name:'适配屏幕',exact:true}).click();await page.waitForTimeout(100);
 const stage=(await page.locator('#mirror-stage').boundingBox())!,frame=(await page.locator('#mirror').boundingBox())!;assert.equal(frame.width,stage.width);assert.equal(frame.height,stage.height);assert.equal(frame.x,stage.x);assert.equal(frame.y,stage.y);
 assert.equal(await page.frames().find(frame=>frame.url().endsWith('/mirror'))!.evaluate(()=>document.getElementById('mirror-root')!.style.getPropertyValue('zoom')),'1');
 assert.equal(await app.sessions.values().next().value?.page.evaluate(() => innerWidth), Math.round(stage.width));
 assert.deepEqual(await page.locator('#mirror').evaluate(n=>({width:(n as HTMLIFrameElement).clientWidth,height:(n as HTMLIFrameElement).clientHeight})),{width:Math.round(stage.width),height:Math.round(stage.height)});
 await page.locator('#floating-ball').click();await page.getByRole('button',{name:'退出全屏',exact:true}).click();
 }
});

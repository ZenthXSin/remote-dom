import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('expanded viewer fills mobile and desktop viewports and restores normal layout',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);t.after(()=>app.close());const browser=await chromium.launch({executablePath:config.chromiumPath,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(app.origin);
 for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1440,height:1000}]){
  await page.setViewportSize(viewport);await page.locator('#expand').click();const bounds=await page.locator('#viewer').boundingBox();assert.ok(bounds);assert.equal(bounds.x,0);assert.equal(bounds.y,0);assert.equal(bounds.width,viewport.width);assert.equal(bounds.height,viewport.height);assert.equal(await page.locator('.view-top').isVisible(),false);assert.equal(await page.locator('#floating-ball').isVisible(),true);assert.equal(await page.locator('#viewer').evaluate(node=>getComputedStyle(node).borderRadius),'0px');assert.equal(await page.locator('body').evaluate(node=>getComputedStyle(node).overflow),'hidden');
  await page.locator('#floating-ball').click();await page.getByRole('button',{name:'适配屏幕',exact:true}).click();await page.locator('#floating-ball').click();await page.getByRole('button',{name:'退出全屏',exact:true}).click();assert.equal(await page.locator('body').evaluate(node=>getComputedStyle(node).overflow),'visible');assert.ok((await page.locator('#viewer').boundingBox())!.height<=640);
 }
 await page.locator('#expand').click();await page.keyboard.press('Escape');assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('browser-expanded')),false);
});

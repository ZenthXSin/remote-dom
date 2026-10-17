import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
test('a rejected fullscreen resize retries without another click or window resize',{timeout:30000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(async()=>{await browser.close();await app.close();});
 const page=await browser.newPage({viewport:{width:1920,height:948},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.locator('#demo').click();await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];await page.waitForTimeout(500);let rejected=false;
 await page.route('**/events',async route=>{const body=route.request().postDataJSON();if(!rejected&&body.events?.some((e:any)=>e.action==='viewport')){rejected=true;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary test failure"}'});return;}await route.continue();});
 await page.locator('#expand').click();const expected=await page.locator('#mirror-stage').evaluate(e=>e.clientWidth);
 const until=Date.now()+6000;while(Date.now()<until&&await session.page.evaluate(()=>innerWidth)!==expected)await page.waitForTimeout(80);
 assert.ok(rejected);assert.equal(await session.page.evaluate(()=>innerWidth),expected,'a single failed resize must not pin the remote browser to its old narrow width');
 await session.submit({type:'event',epoch:session.current!.epoch,eventId:100001,action:'viewport',width:1100,height:760},'test-drift');
 const recovery=Date.now()+6000;while(Date.now()<recovery&&await session.page.evaluate(()=>innerWidth)!==expected)await page.waitForTimeout(80);
 assert.equal(await session.page.evaluate(()=>innerWidth),expected,'server-reported viewport drift is repaired without a local resize event');
});

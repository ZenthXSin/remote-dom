import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('floating device switch changes browser signals, preserves storage, fits viewport and restores selection',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'device-switch-'));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});
 const app=await createApp(config),browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await app.close();await rm(directory,{recursive:true,force:true});});
 const page=await browser.newPage({viewport:{width:1200,height:850},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.locator('#demo').click();
 await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];
 await session.page.evaluate(()=>{document.cookie='switch_test=retained; path=/';localStorage.setItem('switch_test','local');sessionStorage.setItem('switch_test','session');});
 await page.locator('#expand').click();
 for(const [preset,platform,touch,ua] of [['windows','Win32',false,'Windows NT'],['android','Linux armv8l',true,'Android'],['macos','MacIntel',false,'Macintosh'],['ipad','iPad',true,'iPad'],['iphone','iPhone',true,'iPhone'],['default','Linux x86_64',false,'Linux'],['linux','Linux x86_64',false,'Linux']] as const){
  await page.locator('#floating-ball').click();await page.locator('[data-view-action="device-switch-open"]').click();
  await page.locator('#device-switch-preset').selectOption(preset);await page.locator('#device-switch-submit').click();await page.locator('#device-switch-dialog').waitFor({state:'hidden'});
  const actual=await session.page.evaluate(async()=>({ua:navigator.userAgent,platform:navigator.platform,touch:navigator.maxTouchPoints,cookie:document.cookie,local:localStorage.getItem('switch_test'),session:sessionStorage.getItem('switch_test'),header:(await(await fetch('/device-headers')).json()).userAgent}));
  assert.ok(actual.ua.includes(ua));assert.equal(actual.platform,platform);assert.equal(actual.touch>0,touch);assert.equal(actual.header,actual.ua);
  assert.match(actual.cookie,/switch_test=retained/);assert.equal(actual.local,'local');assert.equal(actual.session,'session');
  const width=await page.locator('#mirror-stage').evaluate(e=>e.clientWidth);
  await page.waitForTimeout(400);assert.equal(await session.page.evaluate(()=>innerWidth),width);
 }
 const route='/api/sessions/'+session.id+'/device';
 const invalid=await page.request.post(app.origin+route,{headers:{Origin:app.origin},data:{preset:'unknown'}});assert.equal(invalid.status(),400);
 const wrongOrigin=await page.request.post(app.origin+route,{headers:{Origin:'https://invalid.example'},data:{preset:'windows'}});assert.equal(wrongOrigin.status(),403);
 const other=await browser.newContext();await other.request.get(app.origin+'/api/state');assert.equal((await other.request.post(app.origin+route,{headers:{Origin:app.origin},data:{preset:'windows'}})).status(),404);await other.close();
 await page.locator('#floating-ball').click();await page.locator('[data-view-action="expand"]').click();
 await page.locator('#destroy').click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();await page.locator('#resume-browser').click();
 await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const restored=app.sessions.get(session.id)!;assert.notEqual(restored,session);assert.equal(restored.summary().devicePreset,'linux');assert.equal(await restored.page.evaluate(()=>navigator.platform),'Linux x86_64');
});

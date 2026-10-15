import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('named grids, pointer-transparent overlays, textarea appearance and filtered SVG sprites',{timeout:45000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
  const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1450,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
  const requests:string[]=[];page.on('request',r=>requests.push(r.url()));await page.goto(app.origin);
  await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/layout-controls');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
  const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Named layout',exact:true}).waitFor();
  const session=[...app.sessions.values()][0];const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;
  const selectors=['[aria-label="Test sidebar"]','button:has-text("Sidebar action")','h1','textarea'];
  for(const selector of selectors){const local=await mirror.locator(selector).boundingBox();const remote=await session.page.locator(selector).boundingBox();assert.ok(local&&remote);const offset=await page.locator('#mirror').boundingBox();assert.ok(offset);assert.ok(Math.abs(local.x-offset.x-remote.x)<2,selector+' horizontal geometry');assert.ok(Math.abs(local.y-offset.y-remote.y)<2,selector+' vertical geometry');}
  await mirror.getByRole('button',{name:'Sidebar action',exact:true}).click();await mirror.getByText('Sidebar clicked',{exact:true}).waitFor();
  await mirror.getByRole('button',{name:'Open actions',exact:true}).click();await mirror.getByText('Actions opened',{exact:true}).waitFor();
  const input=mirror.getByRole('textbox',{name:'Message',exact:true});await input.fill('中文输入');await mirror.getByText('Remote text: 中文输入',{exact:true}).waitFor();
  assert.equal(await input.evaluate(n=>getComputedStyle(n).resize),'none');assert.equal(await input.evaluate(n=>getComputedStyle(n).outlineStyle),'none');
  await mirror.locator('svg[aria-label="External icon"] path').waitFor();await mirror.locator('svg[aria-label="Local icon"] circle').waitFor();
  assert.equal(await mirror.locator('script:not([nonce]), use, foreignObject, svg [href],svg [onload]').count(),0);
  assert.equal(await frame.evaluate(()=>typeof(window as any).svgAttack),'undefined');assert.equal(requests.some(u=>u.startsWith(app.fixtureOrigin)),false);
});

test('native popovers escape clipped ancestors; modal dialogs keep their backdrop and close remotely',{timeout:45000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1300,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);
  await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/layers');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
  const mirror=page.frameLocator('#mirror');await mirror.getByRole('button',{name:'Open menu',exact:true}).click();const menu=mirror.getByRole('button',{name:'Menu action',exact:true});await menu.waitFor();await menu.click();await mirror.getByText('Menu clicked',{exact:true}).waitFor();
  await mirror.getByRole('button',{name:'Open modal',exact:true}).click();const dialog=mirror.getByRole('dialog',{name:'Native modal',exact:true});await dialog.waitFor();assert.equal(await dialog.evaluate(n=>n.matches(':modal')),true);assert.equal(await dialog.evaluate(n=>getComputedStyle(n,'::backdrop').backgroundColor),'rgba(0, 0, 0, 0.4)');
  await dialog.getByRole('textbox',{name:'Modal message'}).fill('弹窗输入');await dialog.getByText('Remote modal: 弹窗输入',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Close modal',exact:true}).click();await dialog.waitFor({state:'hidden'});
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('closed shadow controls, pseudo content and remote copy buttons work without local target scripts',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'},permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/advanced-controls');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Advanced controls',exact:true}).waitFor();await mirror.getByRole('button',{name:'Closed action',exact:true}).click();await mirror.getByText('Closed clicked',{exact:true}).waitFor();await mirror.getByRole('textbox',{name:'Closed input'}).fill('封闭组件输入');await mirror.getByText('Closed text: 封闭组件输入',{exact:true}).waitFor();
 await mirror.locator('svg[aria-label="Late icon"] circle').waitFor();assert.equal(await mirror.locator('svg[aria-label="Late icon"] script').count(),0);
 const pseudo=mirror.getByLabel('Pseudo content');assert.equal(await pseudo.evaluate(n=>getComputedStyle(n,'::before').content),'"Before "');assert.equal(await pseudo.evaluate(n=>getComputedStyle(n,'::after').content),'" After"');
 await mirror.getByRole('button',{name:'Copy code',exact:true}).click();await mirror.getByText('Copied remotely',{exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('notice')?.textContent==='已复制到设备');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'复制的代码: const value = 42;');
 const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;assert.equal(await frame.evaluate(()=>document.querySelectorAll('script:not([nonce])').length),0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('startup alerts and script confirm/prompt dialogs can be answered without blocking the input queue',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/script-dialogs');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const startup=page.getByRole('dialog',{name:'网页提示',exact:true});await startup.waitFor();assert.equal(await startup.locator('b').count(),0);await startup.getByText('Startup alert: <b>plain text</b>',{exact:true}).waitFor();await startup.getByRole('button',{name:'确认',exact:true}).click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Native script dialogs',exact:true}).waitFor();
 await mirror.getByRole('button',{name:'Confirm action',exact:true}).click();await startup.waitFor();await startup.getByRole('button',{name:'取消',exact:true}).click();await mirror.getByText('Dismissed',{exact:true}).waitFor();
 await mirror.getByRole('button',{name:'Prompt action',exact:true}).click();const prompt=page.getByRole('dialog',{name:'网页请求输入',exact:true});await prompt.waitFor();await prompt.getByRole('textbox',{name:'提示框输入'}).fill('用户输入');await prompt.getByRole('button',{name:'确认',exact:true}).click();await mirror.getByText('Prompt: 用户输入',{exact:true}).waitFor();
});

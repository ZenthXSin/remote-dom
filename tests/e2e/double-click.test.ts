import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('native double clicks open editors and generate exactly two clicks, across HTTP, WebSocket and zoom',{timeout:45000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  for(const transport of ['http','websocket']){
    const context=await browser.newContext({viewport:{width:1400,height:1000},extraHTTPHeaders:transport==='http'?{'X-Engine-Http-Transport':'1'}:{}});
    const page=await context.newPage();await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/double-click-controls');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
    const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Native double click'}).waitFor();
    await mirror.getByRole('button',{name:'Double action',exact:true}).dblclick();await mirror.getByText('Clicks: 2; doubles: 1',{exact:true}).waitFor();
    await page.getByRole('button',{name:'放大页面',exact:true}).click();await page.waitForTimeout(400);
    await mirror.getByRole('button',{name:'Double action',exact:true}).dblclick();await mirror.getByText('Clicks: 4; doubles: 2',{exact:true}).waitFor();
    await mirror.getByRole('button',{name:'Double click to edit',exact:true}).dblclick();const input=mirror.getByRole('textbox',{name:'Double click editor'});await input.fill('双击编辑中文');await input.press('Enter');await mirror.getByText('Edited: 双击编辑中文',{exact:true}).waitFor();
    const state=await page.evaluate(async()=>await(await fetch('/api/state')).json());assert.equal(state.sessions.length,1);await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();await context.close();
  }
});

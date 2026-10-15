import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('HTTP transport mirrors real DOM and sends remote events without WebSocket',{timeout:45000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
  const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
  let sockets=0;page.on('websocket',()=>sockets++);
  await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();
  const mirror=page.frameLocator('#mirror');
  await mirror.getByRole('button',{name:'远端计数 +1'}).click();await mirror.getByText('1',{exact:true}).waitFor();
  await mirror.getByPlaceholder('在这里输入中文').fill('HTTP 传输测试');
  await mirror.getByText('远端收到：HTTP 传输测试',{exact:true}).waitFor();
  await page.locator('.advanced-tools').evaluate(node=>{(node as HTMLDetailsElement).open=true;});await page.getByRole('button',{name:'重新同步',exact:true}).click();
  await mirror.getByText('1',{exact:true}).waitFor();assert.equal(sockets,0);
  await page.getByRole('button',{name:'关闭会话',exact:true}).click();
  await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();
});

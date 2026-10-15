import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
import {prepareUpgrade} from '../../src/server/live-upgrade.js';

test('live frontend and capture update preserves browser login, native page state and input after reload',{timeout:45000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();
  const mirror=page.frameLocator('#mirror');await mirror.getByRole('button',{name:'远端计数 +1'}).click();await mirror.getByText('1',{exact:true}).waitFor();
  const session=[...app.sessions.values()][0];const browserProcess=session.browser;const pageBefore=session.page;const cookies=await session.context.cookies();const epoch=session.current!.epoch;
  const upgrade=await prepareUpgrade(config.assetDir);const result=upgrade.install(app);assert.equal(result.count,1);await result.ready;await page.reload();await mirror.getByText('1',{exact:true}).waitFor();
  assert.equal(session.browser,browserProcess);assert.equal(session.page,pageBefore);assert.deepEqual(await session.context.cookies(),cookies);assert.notEqual(session.current!.epoch,epoch);
  await mirror.getByRole('button',{name:'远端计数 +1'}).click();await mirror.getByText('2',{exact:true}).waitFor();await mirror.getByPlaceholder('在这里输入中文').fill('更新后输入');await mirror.getByText('远端收到：更新后输入',{exact:true}).waitFor();
  for(let i=0;i<3;i++){await page.reload();await mirror.getByRole('button',{name:'远端计数 +1'}).click();await mirror.getByText(String(3+i),{exact:true}).waitFor();}
});

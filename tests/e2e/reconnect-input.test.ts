import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('reconnecting after an unconfirmed input restores authoritative text and reports the uncertainty',{timeout:35000},async t=>{
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});const app=await createApp(config);t.after(()=>app.close());
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1400,height:1000}});await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();
  const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
  const input=mirror.getByPlaceholder('在这里输入中文');await input.fill('Confirmed text');await mirror.getByText('远端收到：Confirmed text',{exact:true}).waitFor();
  const session=[...app.sessions.values()][0],submit=session.submit.bind(session);let intercepted=false;
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
  session.submit=async(event,peer,captureAfter)=>{if(event.action==='input'&&event.value==='Unconfirmed text'){intercepted=true;await gate;return {type:'error',eventId:event.eventId,message:'Test input was not delivered'};}return submit(event,peer,captureAfter);};
  await input.fill('Unconfirmed text');for(let i=0;i<40&&!intercepted;i++)await page.waitForTimeout(50);assert.ok(intercepted);
  for(const socket of session.sockets)socket.close(1012,'Test lost input');
  await page.getByText('已断开',{exact:true}).waitFor();await page.getByText('在线',{exact:true}).waitFor();
  await input.evaluate(async node=>{for(let i=0;i<50;i++){if((node as HTMLTextAreaElement).value==='Confirmed text')return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Unconfirmed input kept hiding authoritative text after reconnect');});
  assert.equal(await session.page.getByPlaceholder('在这里输入中文').inputValue(),'Confirmed text');
  await page.getByText('最近操作尚未确认，请核对页面状态',{exact:true}).waitFor();release();
  await input.fill('Recovered input');await mirror.getByText('远端收到：Recovered input',{exact:true}).waitFor();
});

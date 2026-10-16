import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

const key='sk-ant-sid02-'+'synthetic_browser_test_'.repeat(4);

test('Claude tool isolates owners, masks and clears input, preserves scoped cookies, and never returns or records credentials',{timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'claude-import-'));
  const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});
  // Real browser and HTTP endpoint; only the upstream Claude site is a fixture.
  config.mode='development';config.hosts=new Set(['claude.ai']);
  const app=await createApp(config);
  const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await app.close();await rm(directory,{recursive:true,force:true});});
  const client=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
  await client.goto(app.origin);await client.locator('#address').fill(app.fixtureOrigin);await client.locator('#create').click();
  await client.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
  const session=[...app.sessions.values()][0],endpoint=app.origin+`/api/sessions/${session.id}/claude-login`;
  const assertTarget=session.policy.assert.bind(session.policy);
  t.mock.method(session.policy,'assert',async(raw:string)=>raw==='https://claude.ai/'?new URL(raw):assertTarget(raw));
  let receivedCookie=false;
  await session.context.route('https://claude.ai/**',async route=>{
    receivedCookie=(await route.request().allHeaders()).cookie?.includes('sessionKey='+key)??false;
    await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Claude fixture</title><h1>Claude session fixture</h1>'});
  });
  const other=await fetch(app.origin+'/api/state');const otherCookie=other.headers.get('set-cookie')!.split(';')[0];await other.arrayBuffer();
  const body=JSON.stringify({sessionKey:key}),ownerCookie='rd_owner='+session.owner;
  for(const [cookie,origin,status] of [['',app.origin,401],[ownerCookie,'https://foreign.example',403],[otherCookie,app.origin,404]] as const){
    const response=await fetch(endpoint,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body});assert.equal(response.status,status);assert.ok(!(await response.text()).includes(key));
  }
  for(const data of [JSON.stringify({sessionKey:'wrong'}),'{"sessionKey":"'+key,JSON.stringify({sessionKey:key,padding:'x'.repeat(6000)})]){
    const response=await fetch(endpoint,{method:'POST',headers:{Cookie:ownerCookie,Origin:app.origin,'Content-Type':'application/json'},body:data});assert.equal(response.status,400);assert.ok(!(await response.text()).includes(key));
  }
  await client.locator('.advanced-tools summary').click();await client.locator('#claude-login-open').click();
  const input=client.locator('#claude-session-key');assert.equal(await input.getAttribute('type'),'password');
  await input.fill(key);await client.locator('#claude-login-close').click();assert.equal(await input.inputValue(),'');
  await client.locator('#claude-login-open').click();await input.fill(key);await client.keyboard.press('Escape');assert.equal(await input.inputValue(),'');
  await session.startDiagnostics();
  await session.context.addCookies([{name:'unrelated',value:'keep',url:app.fixtureOrigin}]);
  await client.locator('#claude-login-open').click();await input.fill('invalid');await client.locator('#claude-login-submit').click();
  await client.locator('#claude-login-status').getByText(/请只粘贴/).waitFor();assert.equal(await input.inputValue(),'');
  await input.fill(key);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
  await client.route('**/claude-login',async route=>{await gate;await route.continue();});
  const responsePromise=client.waitForResponse(response=>response.url()===endpoint);
  await client.locator('#claude-login-submit').click();assert.equal(await input.inputValue(),'');assert.equal(await client.locator('#claude-login-submit').isDisabled(),true);
  release();const response=await responsePromise;assert.equal(response.status(),200);const result=await response.json();assert.deepEqual(result,{applied:true,navigation:'opened',persistence:'saved'});
  await client.locator('#claude-login-dialog').waitFor({state:'hidden'});
  await client.frameLocator('#mirror').getByRole('heading',{name:'Claude session fixture'}).waitFor();assert.ok(receivedCookie);
  const cookies=await session.context.cookies('https://claude.ai/'),cookie=cookies.find(c=>c.name==='sessionKey')!;
  assert.equal(cookie.value,key);assert.equal(cookie.domain,'.claude.ai');assert.equal(cookie.path,'/');assert.ok(cookie.httpOnly&&cookie.secure);assert.equal(cookie.sameSite,'Lax');
  assert.ok(!(await session.page.evaluate(()=>document.cookie)).includes(key));
  assert.equal((await session.context.cookies(app.fixtureOrigin)).find(c=>c.name==='unrelated')?.value,'keep');
  assert.ok(!(await session.context.cookies(app.fixtureOrigin)).some(c=>c.name==='sessionKey'));
  assert.equal(app.runtime.store!.read(session.owner,session.id)!.state.cookies.find(c=>c.name==='sessionKey')?.value,key);
  assert.ok(!(await readFile(join(directory,'state'))).includes(Buffer.from(key)));
  assert.ok(!JSON.stringify(await session.stopDiagnostics()).includes(key));
  const local=await client.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},text:document.body.textContent}));assert.ok(!local.includes(key));
  // The dialog also remains usable from the fullscreen menu on a phone.
  await client.setViewportSize({width:390,height:844});await client.locator('#expand').click();await client.locator('#floating-ball').click();await client.locator('#claude-login-floating').click();
  const bounds=await client.locator('#claude-login-dialog').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390);
  await input.fill(key);await client.locator('#claude-login-close').click();assert.equal(await input.inputValue(),'');
});

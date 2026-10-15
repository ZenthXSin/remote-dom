import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rename,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('failed persistence warns the user, keeps the page interactive and prevents ending it',{timeout:45000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'login-write-failure-'));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});
 const app=await createApp(config),browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await app.close();await rm(directory,{recursive:true,force:true});});
 const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();
 const frame=page.frameLocator('#mirror');await frame.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];await session.saveState();
 await rename(join(directory,'state'),join(directory,'state.saved'));await mkdir(join(directory,'state'));
 await assert.rejects(session.saveState(),/未能保存/);
 const warning=page.locator('#persistence-status');await warning.waitFor();assert.match(await warning.innerText(),/未能保存/);
 await frame.getByRole('button',{name:'远端计数 +1'}).click();await frame.getByText('1',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText(/浏览器环境未能保存/).first().waitFor();
 await page.waitForFunction(()=>!(document.getElementById('destroy') as HTMLButtonElement).disabled);
 assert.equal(app.sessions.get(session.id),session);assert.equal(await page.locator('#mirror').isVisible(),true);
 await rm(join(directory,'state'),{recursive:true});await rename(join(directory,'state.saved'),join(directory,'state'));
 await session.saveState();await warning.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();
 assert.equal(app.sessions.has(session.id),false);
});
test('saved browsers restore cookies and local storage, remain private and can be cleared',{timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'login-e2e-'));t.after(()=>rm(directory,{recursive:true,force:true}));const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});const page=await context.newPage();await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];const cookies=await session.context.cookies();await session.saveState();await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复环境',exact:true}).click();await mirror.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();await page.waitForFunction(()=>document.getElementById('connection')?.textContent==='在线');await new Promise(r=>setTimeout(r,500));const restored=app.sessions.get(session.id)!;assert.notEqual(restored,session);assert.deepEqual(await restored.context.cookies(),cookies);assert.equal(await restored.page.evaluate(()=>localStorage.getItem('remote-demo')),'remote-only');
 const other=await browser.newPage();await other.goto(app.origin);await other.waitForFunction(()=>document.getElementById('mode')?.textContent==='受控测试模式');const state=await other.evaluate(async()=>await(await fetch('/api/state')).json());assert.equal(state.savedSessions.length,0);assert.equal(await other.evaluate(async id=>(await fetch('/api/saved-browsers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})})).status,session.id),404);
 page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'清除该环境数据',exact:true}).click();await page.getByText('该环境的保存数据已清除',{exact:true}).waitFor();assert.equal(app.sessions.has(session.id),false);assert.equal(app.runtime.store!.list(session.owner).length,0);
});

test('restoring a saved page with a startup alert remains interactive instead of blocking session creation',{timeout:45000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'login-dialog-'));t.after(()=>rm(directory,{recursive:true,force:true}));const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});const app=await createApp(config);t.after(()=>app.close());const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/script-dialogs');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();const alert=page.getByRole('dialog',{name:'网页提示',exact:true});await alert.waitFor();await alert.getByRole('button',{name:'确认',exact:true}).click();const frame=page.frameLocator('#mirror');await frame.getByRole('heading',{name:'Native script dialogs'}).waitFor();await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复环境',exact:true}).click();await alert.waitFor();await alert.getByRole('button',{name:'确认',exact:true}).click();await frame.getByRole('heading',{name:'Native script dialogs'}).waitFor();await page.waitForFunction(()=>document.getElementById('connection')?.textContent==='在线');
});

test('a late restore response preserves the input and caret in the already connected browser',{timeout:35000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'login-late-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',BROWSER_STATE_DIR:directory});const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.getByRole('button',{name:'打开体验页面'}).click();const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 await page.getByRole('button',{name:'关闭会话',exact:true}).click();await page.getByText('会话已销毁，远端浏览器已关闭',{exact:true}).waitFor();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 await page.route('**/api/saved-browsers',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
 await page.getByRole('button',{name:'恢复环境',exact:true}).click();await mirror.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const input=mirror.getByPlaceholder('在这里输入中文');await input.fill('恢复中继续输入');await mirror.getByText('远端收到：恢复中继续输入',{exact:true}).waitFor();
 const handle=await input.elementHandle();assert.ok(handle);await input.evaluate(node=>(node as HTMLTextAreaElement).setSelectionRange(3,3));
 release();await page.waitForFunction(()=>!(document.getElementById('resume-browser') as HTMLButtonElement).disabled);
 assert.equal(await handle.evaluate(node=>node.isConnected),true,'restore acknowledgement must not replace the live editor');
 assert.equal(await input.inputValue(),'恢复中继续输入');assert.equal(await input.evaluate(node=>document.activeElement===node),true);
});

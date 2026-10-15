import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('generic rich editor supports native remote input, Chinese, Enter and safe SVG',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/editor');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');const editor=mirror.getByRole('textbox',{name:'Chat message'});
 await editor.waitFor();assert.equal(await editor.getAttribute('contenteditable'),'plaintext-only');
 assert.equal(await mirror.locator('svg path').count(),1);
 await editor.fill('你好 Claude，通用富文本测试');await mirror.getByText('Remote draft: 你好 Claude，通用富文本测试',{exact:true}).waitFor();
 assert.equal(await editor.innerText(),'你好 Claude，通用富文本测试');
 const session=[...app.sessions.values()][0];
 const socketReply=await session.page.evaluate(()=>new Promise<string>((resolve,reject)=>{const socket=new WebSocket(location.origin.replace('http:','ws:')+'/echo-socket');socket.onopen=()=>socket.send('你好');socket.onmessage=e=>{resolve(e.data);socket.close()};socket.onerror=()=>reject(new Error('Allowed remote WebSocket failed'));}));
 assert.equal(socketReply,'Remote socket: 你好');
 const privateSocket=await session.page.evaluate(()=>new Promise<string>(resolve=>{const socket=new WebSocket('ws://169.254.169.254/metadata');socket.onclose=e=>resolve(String(e.code));socket.onerror=()=>resolve('error');}));assert.ok(['1008','error'].includes(privateSocket));
 await editor.press('Enter');await mirror.getByText('Remote reply: 你好 Claude，通用富文本测试',{exact:true}).waitFor();
 for(let i=0;i<30&&await editor.innerText();i++)await new Promise(r=>setTimeout(r,100));assert.equal(await editor.innerText(),'');
 await editor.fill('Second message');await mirror.getByText('Remote draft: Second message',{exact:true}).waitFor();
 await mirror.getByRole('button',{name:'Send',exact:true}).click();await mirror.getByText('Remote reply: Second message',{exact:true}).waitFor();
 const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;assert.equal(await frame.evaluate(()=>typeof(window as any).__REMOTE_ONLY_MARKER),'undefined');
});
test('same-origin and cross-origin embedded pages render locally with isolated remote input',{timeout:60000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1500,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});const requests:string[]=[];page.on('request',r=>requests.push(r.url()));
 await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/frames');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Embedded pages',exact:true}).waitFor();
 const groups=mirror.getByRole('group',{name:'Embedded controls',exact:true});await groups.nth(1).waitFor();
 for(let i=0;i<2;i++){
   const group=groups.nth(i);await group.getByRole('button',{name:'Embedded click',exact:true}).click();await group.getByText('1',{exact:true}).waitFor();
   await group.getByRole('textbox',{name:'Embedded message'}).fill(`中文框架 ${i}`);await group.getByText(`Remote frame: 中文框架 ${i}`,{exact:true}).waitFor();
   await group.evaluate(node=>node.scrollTo(0,520));await new Promise(r=>setTimeout(r,500));
   await group.getByRole('button',{name:'Bottom action',exact:true}).click();await group.getByText('Bottom clicked',{exact:true}).waitFor();
 }
 const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;
 assert.equal(await frame.evaluate(()=>typeof(window as any).__FRAME_TARGET_SCRIPT),'undefined');assert.equal(await mirror.locator('iframe,script:not([nonce])').count(),0);
 assert.equal(requests.some(url=>new URL(url).port===new URL(app.fixtureOrigin).port),false);
 const remote=[...app.sessions.values()][0];assert.equal(remote.current!.unsupported.includes('iframe'),false);
});

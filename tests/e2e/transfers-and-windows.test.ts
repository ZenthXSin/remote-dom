import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('sign-in popup, file upload/download, canvas coordinates and open shadow DOM',{timeout:60000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin+'/browser-shell');await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const mirror=page.frameLocator('#mirror');await mirror.getByRole('heading',{name:'Browser capabilities',exact:true}).waitFor();
 await mirror.getByRole('button',{name:'Open sign-in window',exact:true}).click();await mirror.getByRole('heading',{name:'Sign-in window',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'切换远端窗口'}).waitFor();
 await mirror.getByRole('button',{name:'Complete test sign-in',exact:true}).click();await mirror.getByText('Signed in through popup',{exact:true}).waitFor();
 const session=[...app.sessions.values()][0];assert.equal((await session.context.cookies()).some(c=>c.name==='test-popup-auth'),true);
 await mirror.getByRole('button',{name:'Attach files',exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).waitFor();
 const picker=session.current!.filePicker!;
 const rejected=await page.evaluate(async({id,epoch,pickerId})=>{const statuses=[];for(const file of [{name:'../private',size:1,mimeType:'text/plain'},{name:'large.txt',size:17*1024*1024,mimeType:'text/plain'}]){const response=await fetch(`/api/sessions/${id}/uploads`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'begin',pickerId,epoch,files:[file]})});statuses.push(response.status);}return statuses;},{id:session.id,epoch:session.current!.epoch,pickerId:picker.id});assert.deepEqual(rejected,[400,400]);
 const choice=page.waitForEvent('filechooser');await page.getByRole('button',{name:'选择文件',exact:true}).click();
 await(await choice).setFiles([{name:'中文附件.txt',mimeType:'text/plain',buffer:Buffer.from('用户选择的远端附件')},{name:'binary.txt',mimeType:'text/plain',buffer:Buffer.alloc(40000,171)}]);await mirror.getByText('中文附件.txt, binary.txt / 用户选择的远端附件',{exact:true}).waitFor();
 assert.equal(await session.page.evaluate(async()=>{const files=(document.querySelector('input[type=file]') as HTMLInputElement).files!;const binary=new Uint8Array(await files[1].arrayBuffer());return binary.length===40000&&binary.every(byte=>byte===171)}),true,'multiple upload chunks preserve exact remote bytes');
 await mirror.getByRole('link',{name:'Download result',exact:true}).click();const downloadLink=page.getByRole('link',{name:'下载 remote-example.txt',exact:true});await downloadLink.waitFor();
 const download=await page.evaluate(async()=>{const a=document.querySelector('#downloads a') as HTMLAnchorElement;const r=await fetch(a.href);return {status:r.status,disposition:r.headers.get('content-disposition'),body:await r.text()}});
 assert.equal(download.status,200);assert.match(download.disposition!,/^attachment/);assert.equal(download.body,'Downloaded from the isolated remote browser');
 const canvas=mirror.getByAltText('Interactive drawing');await canvas.waitFor();assert.ok((await canvas.getAttribute('src'))?.startsWith('blob:'));
 await canvas.click({position:{x:20,y:30}});await mirror.getByText('Canvas point: 20, 30',{exact:true}).waitFor();
 await mirror.getByRole('button',{name:'Shadow action',exact:true}).click();await mirror.getByText('Shadow clicked',{exact:true}).waitFor();
 const other=await browser.newPage();await other.goto(app.origin);await other.waitForFunction(()=>document.getElementById('mode')?.textContent==='受控测试模式');
 const downloadId=[...session.downloads.keys()][0];const statuses=await other.evaluate(async({id,downloadId})=>{
   const upload=await fetch(`/api/sessions/${id}/uploads`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'begin'})});const download=await fetch(`/api/sessions/${id}/downloads/${downloadId}`);const window=await fetch(`/api/sessions/${id}/windows`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close'})});return [upload.status,download.status,window.status];
 },{id:session.id,downloadId});assert.deepEqual(statuses,[404,404,404]);
 const frame=page.frames().find(f=>f.url().endsWith('/mirror'))!;assert.equal(await frame.evaluate(()=>typeof(window as any).__FRAME_TARGET_SCRIPT),'undefined');assert.equal(await mirror.locator('script:not([nonce]),iframe').count(),0);
});

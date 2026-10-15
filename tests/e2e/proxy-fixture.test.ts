import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('development proxy configuration keeps the built-in fixture interactive',{timeout:45000},async t=>{
 const requested:string[]=[];
 const proxy=createServer((req,res)=>{requested.push(req.url??'');res.writeHead(403);res.end('Fixture must use its local origin');});
 proxy.on('connect',(req,socket)=>{requested.push(req.url??'');socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const port=(proxy.address() as {port:number}).port;
 t.after(()=>{proxy.closeAllConnections();return new Promise<void>(resolve=>proxy.close(()=>resolve()));});
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'development',ENGINE_HOST:'127.0.0.1',REMOTE_PROXY_SERVER:`http://127.0.0.1:${port}`});
 const app=await createApp(config);t.after(()=>app.close());
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1000}});
 await page.goto(app.origin);await page.getByRole('textbox',{name:'目标网址'}).fill(app.fixtureOrigin);
 await page.getByRole('button',{name:'新建浏览器',exact:true}).click();
 const frame=page.frameLocator('#mirror');await frame.getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 await frame.getByRole('button',{name:'远端计数 +1'}).click();await frame.getByText('1',{exact:true}).waitFor();
 assert.equal(requested.some(url=>url.startsWith(app.fixtureOrigin)),false);
});

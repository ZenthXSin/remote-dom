import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('floating composer spacer preserves editor height and wrapping without phantom scrollbars',{timeout:45000},async t=>{
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),app=await createApp(config);
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await app.close();});
 const page=await browser.newPage({viewport:{width:1400,height:1000},extraHTTPHeaders:{'X-Engine-Http-Transport':'1'}});
 await page.goto(app.origin);await page.locator('#demo').click();await page.frameLocator('#mirror').getByRole('heading',{name:'这段页面，在你的浏览器渲染。'}).waitFor();
 const session=[...app.sessions.values()][0];
 await session.page.setContent(`<!doctype html><style>*{box-sizing:border-box}body{margin:0;font:16px/22px Arial}.composer{width:600px;padding:8px;background:#eee}.scroll{height:32px;min-height:32px;max-height:384px;padding:5px 0;overflow:auto;scrollbar-width:thin}.editor{position:relative;height:22px}.editor:before{content:'';display:block;float:right;width:111px;height:22px;shape-outside:inset(calc(100% - 32px) 0 0 0)}p{margin:0}button{float:right}.clear{clear:both}</style><div class="composer"><div class="scroll" role="group" aria-label="Composer scroll"><div class="editor" contenteditable="true" aria-label="Composer"><p>Type a message</p></div></div></div><div class="clear">Below editor</div>`);
 const editor=page.frameLocator('#mirror').getByLabel('Composer',{exact:true}),scroll=page.frameLocator('#mirror').getByRole('group',{name:'Composer scroll'});
 await editor.waitFor();
 const measure=(node:Element)=>{const e=node as HTMLElement;return {clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth};};
 const expected=await session.page.getByRole('group',{name:'Composer scroll'}).evaluate(measure);
 assert.deepEqual(await scroll.evaluate(measure),expected,'replayed pseudo-element must not add a second line or force either scrollbar');
 assert.equal(await editor.evaluate(e=>getComputedStyle(e,'::before').cssFloat),'right');
 assert.equal(await editor.evaluate(e=>getComputedStyle(e,'::before').shapeOutside),await session.page.getByLabel('Composer',{exact:true}).evaluate(e=>getComputedStyle(e,'::before').shapeOutside));
 assert.equal(await scroll.evaluate(e=>getComputedStyle(e).scrollbarWidth),'thin');
 await editor.fill('Hello from the mirrored editor');
 await session.page.waitForFunction(()=>document.querySelector('[contenteditable]')?.textContent==='Hello from the mirrored editor');
 // Dynamic removal must reset omitted defaults instead of leaving a stale float.
 await session.page.addStyleTag({content:'.editor:before{float:none;shape-outside:none;width:0;height:0}.scroll{scrollbar-width:auto}'});
 const until=Date.now()+5000;
 while(await editor.evaluate(e=>getComputedStyle(e,'::before').cssFloat)!=='none'&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
 assert.equal(await editor.evaluate(e=>getComputedStyle(e,'::before').cssFloat),'none');
 assert.equal(await editor.evaluate(e=>getComputedStyle(e,'::before').shapeOutside),'none');
});

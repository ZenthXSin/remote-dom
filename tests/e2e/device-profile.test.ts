import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('all sessions use fixed container parameters across navigation, resize and application restart',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rd-container-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',DEVICE_PROFILE_PATH:join(dir,'profile.json')});
 let app=await createApp(config);t.after(()=>app.close());
 const stateResponse=await fetch(app.origin+'/api/state');
 const cookie=stateResponse.headers.get('set-cookie')!.split(';')[0];
 const state=await stateResponse.json();assert.deepEqual(state.deviceProfile,app.deviceProfile);
 async function create(){const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin,viewport:{width:980,height:650}})});assert.equal(response.status,201);return app.sessions.get((await response.json()).id)!;}
 const first=await create();
 async function observed(){return first.page.evaluate(()=>({screen:{width:screen.width,height:screen.height},dpr:devicePixelRatio,locale:navigator.language,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,dark:matchMedia('(prefers-color-scheme: dark)').matches,touch:navigator.maxTouchPoints,ua:navigator.userAgent,platform:navigator.platform,cpu:navigator.hardwareConcurrency,memory:(navigator as Navigator&{deviceMemory?:number}).deviceMemory}));}
 const before=await observed();const p=app.deviceProfile;
 assert.deepEqual(before.screen,p.screen);assert.equal(before.dpr,p.deviceScaleFactor);assert.equal(before.locale,p.locale);
 assert.equal(before.timezone,p.timezoneId);assert.equal(before.dark,p.colorScheme==='dark');assert.equal(before.touch,0);
 const headers=await first.page.evaluate(async()=>await(await fetch('/device-headers')).json());
 assert.equal(headers.userAgent,before.ua);assert.ok(headers.language.startsWith(p.locale));assert.equal(headers.platform,'"Linux"');
 const worker=await first.page.evaluate(()=>new Promise<{locale:string;timezone:string;cpu:number;ua:string}>(resolve=>{
   const url=URL.createObjectURL(new Blob([`postMessage({locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cpu:navigator.hardwareConcurrency,ua:navigator.userAgent})`],{type:'text/javascript'}));
   const w=new Worker(url);w.onmessage=e=>{resolve(e.data);w.terminate();URL.revokeObjectURL(url);};
 }));
 assert.deepEqual(worker,{locale:before.locale,timezone:before.timezone,cpu:before.cpu,ua:before.ua});
 const second=await create();assert.equal(second.deviceProfile,first.deviceProfile);
 assert.deepEqual(await second.page.evaluate(()=>({screen:{width:screen.width,height:screen.height},dpr:devicePixelRatio,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})),{screen:before.screen,dpr:before.dpr,timezone:before.timezone});
 await second.close();app.sessions.delete(second.id);
 const epoch=first.current!.epoch;
 assert.equal((await first.submit({type:'event',action:'viewport',epoch,eventId:1,width:420,height:720},randomUUID())).type,'ack');
 assert.equal(await first.page.evaluate(()=>innerWidth),420);assert.deepEqual(await observed(),before);
 await first.navigation('reload');assert.deepEqual(await observed(),before);
 await first.navigate(app.fixtureOrigin+'/second');assert.deepEqual(await observed(),before);
 assert.equal(await first.page.evaluate(()=>innerWidth),420);
 // Check the user-visible profile view, including mobile visibility, without opening another remote browser.
 const browser=await chromium.launch({executablePath:config.chromiumPath,headless:true,chromiumSandbox:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 try{await page.goto(app.origin);await page.locator('.advanced-tools summary').click();await page.getByRole('button',{name:'设备档案',exact:true}).click();await page.getByRole('dialog',{name:'容器设备档案'}).waitFor();assert.ok((await page.locator('#profile-details').innerText()).includes(p.id));}finally{await browser.close();}
 await app.close();app=await createApp(config);assert.deepEqual(app.deviceProfile,p);
});

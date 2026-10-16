import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';
import {generateDeviceProfile} from '../../src/server/device-profile.js';
test('Android profile persists and uses mobile UA, touch and fixed phone dimensions',{timeout:45000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'android-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'profile.json');
 const profile={...generateDeviceProfile(),platform:'Android',device:'Pixel 7 · Android 模拟',screen:{width:412,height:915},deviceScaleFactor:2.625,isMobile:true,hasTouch:true};await writeFile(path,JSON.stringify({containerKey:hostname(),profile}));
 const config=readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1',DEVICE_PROFILE_PATH:path});let app=await createApp(config);t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state');const cookie=state.headers.get('set-cookie')!.split(';')[0];const res=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(res.status,201);const session=app.sessions.get((await res.json()).id)!;
 const observe=()=>session.page.evaluate(()=>({ua:navigator.userAgent,touch:navigator.maxTouchPoints,dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height},portrait:screen.orientation.type}));const actual=await observe();assert.match(actual.ua,/Android 14; Pixel 7/);assert.ok(actual.ua.includes('Chrome/'+session.browser.version()+' '),'mobile UA must report the installed Chromium version, not the Playwright bundled browser version');assert.ok(actual.touch>0);assert.equal(actual.dpr,2.625);assert.deepEqual(actual.screen,profile.screen);assert.equal(actual.portrait,'portrait-primary');
 const headers=await session.page.evaluate(async()=>await(await fetch('/device-headers')).json());assert.equal(headers.userAgent,actual.ua);
 await session.submit({type:'event',action:'viewport',epoch:session.current!.epoch,eventId:1,width:1400,height:900},randomUUID());assert.deepEqual(session.page.viewportSize(),{width:412,height:839});assert.deepEqual(await observe(),actual);
 await app.close();app=await createApp(config);assert.equal(app.deviceProfile.platform,'Android');
});

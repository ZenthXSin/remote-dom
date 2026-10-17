import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../../src/server/app.js';
import {readConfig} from '../../src/server/config.js';

test('repeated captures reuse shadow discovery without delaying new document discovery',{timeout:30000},async t=>{
 const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}));t.after(()=>app.close());
 const state=await fetch(app.origin+'/api/state'),cookie=state.headers.get('set-cookie')!.split(';')[0];
 const response=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin})});assert.equal(response.status,201);
 const session=app.sessions.get((await response.json()).id)!,cdp=session.cdp as any,send=cdp.send.bind(cdp);let scans=0;
 cdp.send=(method:string,params:unknown)=>{if(method==='DOM.describeNode')scans++;return send(method,params);};
 const start=performance.now();for(let i=0;i<8;i++){await session.page.evaluate(i=>document.title='capture '+i,i);await session.poll(true);}
 console.log(JSON.stringify({captures:8,fullTreeScans:scans,elapsedMs:Math.round(performance.now()-start)}));assert.ok(scans<4,'ordinary repeated captures must not repeatedly serialize the complete DOM tree');
 const before=scans;await session.navigate(app.fixtureOrigin+'/edge-menu');await session.poll(true);assert.ok(scans>before,'new isolated contexts must discover shadow roots immediately');
});

import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server/app.js';
import {readConfig} from '../src/server/config.js';
import {RemoteSession} from '../src/server/session.js';
import {TargetPolicy} from '../src/server/policy.js';

async function setup(t:TestContext,requests:number){
  const directory=await mkdtemp(join(tmpdir(),'rd-restore-concurrency-'));
  const owner='a'.repeat(64);
  const app=await createApp({...readConfig({PORT:'0',ENGINE_MODE:'demo',ENGINE_HOST:'127.0.0.1'}),accountOwner:owner,stateDir:join(directory,'state'),deviceProfilePath:join(directory,'profile.json')});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  let release!:()=>void,allEntered!:()=>void,entered=0;
  const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>allEntered=resolve);
  t.after(()=>release());
  const originalAssert=TargetPolicy.prototype.assert;
  t.mock.method(TargetPolicy.prototype,'assert',async function(this:TargetPolicy,raw:string){const url=await originalAssert.call(this,raw);if(++entered===requests)allEntered();await gate;return url;});
  const started:RemoteSession[]=[];
  t.mock.method(RemoteSession.prototype,'start',async function(this:RemoteSession){started.push(this);});
  const saved=async()=>{const id=randomUUID();await app.runtime.store!.save({id,owner,url:app.fixtureOrigin,title:'Fixture',savedAt:new Date().toISOString(),state:{cookies:[],origins:[]}});return id;};
  const restore=(id:string)=>fetch(app.origin+'/api/saved-browsers',{method:'POST',headers:{Cookie:'rd_owner='+owner,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({id})});
  return {app,started,saved,restore,ready,release};
}

test('concurrent restores of the same saved browser start one tracked session',{timeout:5000},async t=>{
  const state=await setup(t,2),id=await state.saved();
  const pending=[state.restore(id),state.restore(id)];await state.ready;state.release();
  const responses=await Promise.all(pending);for(const response of responses)await response.arrayBuffer();
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  assert.equal(state.started.length,1);assert.equal(state.app.sessions.size,1);
  assert.equal(state.app.sessions.get(id),state.started[0]);
});

test('concurrent restores of different saved browsers enforce the owner session limit',{timeout:5000},async t=>{
  const state=await setup(t,3),ids=await Promise.all([state.saved(),state.saved(),state.saved()]);
  const pending=ids.map(state.restore);await state.ready;state.release();
  const responses=await Promise.all(pending);for(const response of responses)await response.arrayBuffer();
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,201,429]);
  assert.equal(state.started.length,2);assert.equal(state.app.sessions.size,2);
});

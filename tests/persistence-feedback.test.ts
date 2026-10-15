import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Browser,BrowserContext} from 'playwright-core';
import {BrowserStore} from '../src/server/browser-store.js';
import {RemoteSession} from '../src/server/session.js';
import {TargetPolicy} from '../src/server/policy.js';
import {readConfig} from '../src/server/config.js';
import {loadContainerProfile} from '../src/server/device-profile.js';

test('a failed save stays visible and prevents closing until a successful retry',{timeout:5000},async t=>{
 const base=await mkdtemp(join(tmpdir(),'rd-persistence-feedback-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const directory=join(base,'store'),offline=join(base,'offline'),store=new BrowserStore(directory);await store.initialize();
 const config=readConfig({}),profile=await loadContainerProfile(join(base,'profile.json'));
 const session=new RemoteSession('owner',config,new TargetPolicy('http://127.0.0.1:12345',new Set()),profile,store);
 let closes=0;
 session.browser={isConnected:()=>true,close:async()=>{closes++;}} as unknown as Browser;
 session.context={storageState:async()=>({cookies:[],origins:[]})} as unknown as BrowserContext;
 t.mock.method(console,'error',()=>{});
 await session.saveState();await rename(directory,offline);
 await assert.rejects(session.saveState(),/未能保存/);assert.match(session.summary().persistenceError!,/未能保存/);
 await assert.rejects(session.close(),/未能保存/);assert.equal(closes,0);
 await rename(offline,directory);await session.saveState();assert.equal(session.summary().persistenceError,undefined);
 await session.close();assert.equal(closes,1);
});

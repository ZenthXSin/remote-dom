import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {BrowserContext,Page,Response} from 'playwright-core';
import {ClaudeLoginError,importClaudeSession,parseClaudeSessionKey} from '../src/server/claude-login.js';
import {TargetPolicy} from '../src/server/policy.js';
import {RemoteSession} from '../src/server/session.js';

const key='sk-ant-sid02-'+ 'synthetic_test_'.repeat(4);
const policy=new TargetPolicy('http://127.0.0.1:1',new Set(['claude.ai']),true,async()=>[{address:'8.8.8.8'}]);
const page:Pick<Page,'goto'>={goto:async()=>({status:()=>200} as Response)};

test('Claude import accepts only session credentials and rejects pasted bundles without echoing them',()=>{
  assert.equal(parseClaudeSessionKey(' \n'+key+'\n '),key);
  for(const value of [undefined,{},'',key+'; foo=bar',key+'\nsecret','sk-ant-api03-'+ 'a'.repeat(100),'email@example.test----password----'+key,'a'.repeat(5000)]){
    assert.throws(()=>parseClaudeSessionKey(value),error=>error instanceof ClaudeLoginError&&!error.message.includes(key)&&!error.message.includes('password'));
  }
});

test('Claude import enforces target policy before changing cookies and keeps browser errors private',async()=>{
  let writes=0;
  const context={addCookies:async()=>{writes++;throw new Error('browser failure: '+key);}};
  await assert.rejects(importClaudeSession(key,context,page,new TargetPolicy('http://127.0.0.1:1',new Set())),error=>error instanceof ClaudeLoginError&&error.status===403);
  assert.equal(writes,0);
  await assert.rejects(importClaudeSession(key,context,page,policy),error=>error instanceof ClaudeLoginError&&error.status===502&&!error.message.includes(key));
  assert.equal(writes,1);
});

test('Claude import fixes cookie scope and flags, opens normal HTTPS page and distinguishes incomplete loading from persistence',async()=>{
  let saved=0,writes=0;
  const context:Pick<BrowserContext,'addCookies'>={addCookies:async cookies=>{
    writes++;assert.deepEqual(cookies,[{name:'sessionKey',value:key,domain:'.claude.ai',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
  }};
  const navigation:Pick<Page,'goto'>={goto:async(url,options)=>{assert.equal(url,'https://claude.ai/');assert.equal(options?.waitUntil,'domcontentloaded');return {status:()=>200} as Response;}};
  assert.deepEqual(await importClaudeSession(key,context,navigation,policy,async()=>{saved++;}),{applied:true,navigation:'opened',persistence:'saved'});
  const timeout:Pick<Page,'goto'>={goto:async()=>{throw new Error('timeout: '+key);}};
  assert.deepEqual(await importClaudeSession(key,context,timeout,policy,async()=>{saved++;throw new Error('disk failure: '+key);}),{applied:true,navigation:'incomplete',persistence:'failed'});
  assert.deepEqual(await importClaudeSession(key,context,{goto:async()=>({status:()=>403} as Response)},policy),{applied:true,navigation:'incomplete',persistence:'disabled'});
  assert.equal(saved,2);assert.equal(writes,3);
});

test('a session rejects concurrent credential imports and releases its lock after success or failure',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let writes=0;
  const session=Object.assign(Object.create(RemoteSession.prototype),{
    policy,context:{addCookies:async()=>{writes++;await gate;}},page:{...page,isClosed:()=>false}
  }) as RemoteSession;
  const first=session.loginClaude(key);
  await assert.rejects(session.loginClaude(key),error=>error instanceof ClaudeLoginError&&error.status===409);
  release();await first;assert.equal(writes,1);
  await assert.rejects(session.loginClaude('invalid'));
  await session.loginClaude(key);assert.equal(writes,2);
});

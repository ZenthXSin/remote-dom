import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserStore} from '../src/server/browser-store.js';
test('login state is encrypted, scoped to its owner and recoverable after store restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'browser-store-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new BrowserStore(directory);await store.initialize();await store.rememberOwner('owner-one',Date.now()+60000);
 await store.save({id:'browser-one',owner:'owner-one',title:'Private browser',url:'https://example.com/',savedAt:new Date().toISOString(),state:{cookies:[{name:'login',value:'confidential-cookie-marker',domain:'example.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]}});
 assert.equal(store.list('other-owner').length,0);assert.equal(store.read('other-owner','browser-one'),undefined);const encrypted=await readFile(join(directory,'state'));assert.equal(encrypted.includes(Buffer.from('confidential-cookie-marker')),false);assert.equal((await stat(join(directory,'state'))).mode&0o777,0o600);
 const restart=new BrowserStore(directory);await restart.initialize();assert.equal(restart.read('owner-one','browser-one')!.state.cookies[0].value,'confidential-cookie-marker');assert.equal(restart.ownerForRecovery(store.recovery('owner-one')!),'owner-one');await restart.forget('owner-one','browser-one');assert.equal(restart.list('owner-one').length,0);
});

test('failed writes keep the last committed browser and owner data and later writes recover',async t=>{
 const base=await mkdtemp(join(tmpdir(),'browser-store-failure-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const directory=join(base,'store'),offline=join(base,'offline'),store=new BrowserStore(directory);await store.initialize();
 const expires=Date.now()+60000;await store.rememberOwner('owner',expires);
 const browser={id:'browser',owner:'owner',title:'Committed',url:'https://example.com/',savedAt:new Date().toISOString(),state:{cookies:[],origins:[]}};
 await store.save(browser);const before=await readFile(join(directory,'state'));
 await rename(directory,offline);
 await assert.rejects(store.save({...browser,title:'Uncommitted'}),{code:'ENOENT'});
 assert.equal(store.read('owner','browser')!.title,'Committed');
 await assert.rejects(store.save({...browser,id:'ghost'}),{code:'ENOENT'});assert.equal(store.read('owner','ghost'),undefined);
 await assert.rejects(store.forget('owner','browser'),{code:'ENOENT'});assert.ok(store.read('owner','browser'));
 await assert.rejects(store.rememberOwner('owner',expires+60000),{code:'ENOENT'});assert.equal(store.owners().get('owner'),expires);
 await rename(offline,directory);assert.deepEqual(await readFile(join(directory,'state')),before);
 await store.save({...browser,title:'Recovered'});const restart=new BrowserStore(directory);await restart.initialize();
 assert.equal(restart.read('owner','browser')!.title,'Recovered');assert.equal(restart.read('owner','ghost'),undefined);
});

test('missing key never creates a replacement for existing encrypted browser data',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'browser-store-key-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new BrowserStore(directory);await store.initialize();await store.rememberOwner('owner',Date.now()+60000);const before=await readFile(join(directory,'state'));await unlink(join(directory,'key'));await assert.rejects(new BrowserStore(directory).initialize(),/密钥缺失/);assert.deepEqual(await readFile(join(directory,'state')),before);await assert.rejects(readFile(join(directory,'key')),{code:'ENOENT'});
});

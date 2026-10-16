import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxyHostResolverRules} from '../src/server/browser-network.js';
test('proxy DNS rules block external resolution while preserving exact infrastructure hosts',()=>{
  assert.equal(proxyHostResolverRules('http://egress-proxy:3128',['http://127.0.0.1:4173','http://fixture:8080','http://fixture:9000']),
    'MAP * ~NOTFOUND, EXCLUDE egress-proxy, EXCLUDE 127.0.0.1, EXCLUDE fixture');
  assert.throws(()=>proxyHostResolverRules('http://*.example.com:3128',[]),/Invalid/);
});

test('managed relay mode cannot be enabled for an unrestricted standalone browser',async()=>{
 const {readConfig}=await import('../src/server/config.js');
 const env={ENGINE_MODE:'development',REMOTE_PROXY_SERVER:'http://relay:3128',TARGET_HOSTS:'*',MANAGED_EGRESS_POLICY:'1'};
 assert.throws(()=>readConfig(env),/Managed egress/);
 assert.throws(()=>readConfig({...env,ACCOUNT_OWNER:'a'.repeat(64),TARGET_HOSTS:'example.com'}),/Managed egress/);
 assert.throws(()=>readConfig({...env,ACCOUNT_OWNER:'a'.repeat(64),REMOTE_PROXY_USERNAME:'user'}),/Managed egress/);
 assert.equal(readConfig({...env,ACCOUNT_OWNER:'a'.repeat(64)}).managedEgress,true);
});

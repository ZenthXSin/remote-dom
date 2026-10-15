import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxyHostResolverRules} from '../src/server/browser-network.js';
test('proxy DNS rules block external resolution while preserving exact infrastructure hosts',()=>{
  assert.equal(proxyHostResolverRules('http://egress-proxy:3128',['http://127.0.0.1:4173','http://fixture:8080','http://fixture:9000']),
    'MAP * ~NOTFOUND, EXCLUDE egress-proxy, EXCLUDE 127.0.0.1, EXCLUDE fixture');
  assert.throws(()=>proxyHostResolverRules('http://*.example.com:3128',[]),/Invalid/);
});

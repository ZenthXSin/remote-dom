import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,TargetPolicy} from '../src/server/policy.js';
import {sanitizeDocument,safeStyle,safeSvgAttribute} from '../src/server/sanitize.js';
import {readConfig} from '../src/server/config.js';
import type {CapturedDocument} from '../src/shared/protocol.js';

test('blocks private, mapped, metadata and unusual loopback addresses',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1','fc00::1','0.0.0.0','100.64.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('demo policy cannot be redirected to arbitrary loopback or public websites',async()=>{
  const policy=new TargetPolicy('http://127.0.0.1:5000',new Set());
  assert.equal((await policy.assert('http://127.0.0.1:5000/path')).pathname,'/path');
  for(const url of ['http://127.0.0.1:5001','http://2130706433:5001','http://169.254.169.254','https://example.com','file:///etc/passwd','javascript:alert(1)','http://user:pass@127.0.0.1:5000'])await assert.rejects(policy.assert(url));
});
test('styles only carry approved values and opaque resource references',()=>{
  const resolver=(url:string)=>url==='https://test/image.png'?'abc123':undefined;
  assert.equal(safeStyle('background-image','url(https://attacker.test/steal)',resolver),undefined);
  assert.equal(safeStyle('background-image','url(https://test/image.png)',resolver),'url(asset:abc123)');
  assert.equal(safeStyle('background-image','url(https://test/image.png)',()=>undefined),undefined);
  assert.equal(safeStyle('background-image','url(https://test/image.png)',()=> 'other-session'),'url(asset:other-session)');
  assert.equal(safeStyle('background-image','u\\72l(https://test/image.png)',resolver),undefined);
  assert.equal(safeStyle('background-image','u\\72l(https://test/image.png)',()=>undefined),undefined);
  assert.equal(safeStyle('color','expression(alert(1))',resolver),undefined);
  assert.equal(safeStyle('behavior','url(x)',resolver),undefined);
  assert.equal(safeStyle('color','rgb(1, 2, 3)',resolver),'rgb(1,2,3)');
});
test('sanitizer excludes handlers, raw resource URLs and password values',()=>{
  const raw:CapturedDocument={root:'n1',title:'test',url:'https://test/',scrollX:0,scrollY:0,focused:null,unsupported:[],truncated:false,nodes:[{id:'n1',kind:'element',tag:'input',attrs:{type:'password',onclick:'alert(1)',src:'https://evil',name:'token'},value:'sensitive',style:{color:'red','background-image':'url(https://evil)'}}]};
  const safe=sanitizeDocument(raw,()=>undefined);const serialized=JSON.stringify(safe);
  for(const forbidden of ['onclick','https://evil','sensitive','token'])assert.equal(serialized.includes(forbidden),false);
});
test('production cannot silently use the development runner',()=>{
  assert.throws(()=>readConfig({NODE_ENV:'production'}),/生产启动被禁用/);
  assert.throws(()=>readConfig({ENGINE_MODE:'development'}),/REMOTE_PROXY_SERVER/);
});
test('SVG rendering rejects active tags, external references and event attributes',()=>{
 assert.equal(safeSvgAttribute('href','https://evil.test'),undefined);
 assert.equal(safeSvgAttribute('fill','url(https://evil.test/image.svg)'),undefined);
 assert.equal(safeSvgAttribute('onload','alert(1)'),undefined);
 const raw:CapturedDocument={root:'n1',title:'svg',url:'https://test/',scrollX:0,scrollY:0,focused:null,unsupported:[],truncated:false,nodes:[
  {id:'n1',kind:'element',tag:'svg',namespace:'svg',attrs:{viewBox:'0 0 24 24',onload:'alert(1)'},children:['n2']},
  {id:'n2',kind:'element',tag:'path',namespace:'svg',attrs:{d:'M0 0 L24 24',href:'https://evil.test',fill:'url(https://evil.test)'}},
 ]};const safe=sanitizeDocument(raw,()=>undefined);assert.equal(safe.nodes[0].namespace,'svg');assert.equal(safe.nodes[1].attrs!.d,'M0 0 L24 24');assert.equal(JSON.stringify(safe).includes('evil.test'),false);assert.equal(JSON.stringify(safe).includes('onload'),false);
});
test('wildcard permits public HTTP and HTTPS without granting private-network access',async()=>{
 const policy=new TargetPolicy('http://127.0.0.1:5000',new Set(['*']),true,async hostname=>[{address:hostname==='private.example'?'10.0.0.2':'8.8.8.8'}]);
 assert.equal((await policy.assert('https://public.example/path')).hostname,'public.example');
 assert.equal((await policy.assert('http://another.example/path')).protocol,'http:');
 for(const url of ['https://private.example','http://127.0.0.1','http://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://localhost','file:///etc/passwd','https://public.example:8443'])await assert.rejects(policy.assert(url));
});

test('escaped SVG paint URLs cannot reach local resource loading',()=>{assert.equal(safeSvgAttribute('fill',String.raw`u\72l(https://example.com/image)`),undefined);assert.equal(safeSvgAttribute('stroke','currentColor'),'currentColor');});

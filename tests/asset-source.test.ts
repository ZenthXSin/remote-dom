import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {fetchAsset,MAX_ASSET_BYTES} from '../src/server/asset-source.js';
import {TargetPolicy} from '../src/server/policy.js';
import {readConfig} from '../src/server/config.js';
test('resource recovery bounds decoded bytes and validates redirects before any network access',async t=>{
 let forbidden=0;const bytes=Buffer.from('resource bytes');
 const server=createServer((req,res)=>{res.setHeader('Content-Type','image/png');if(req.url==='/private'){res.writeHead(302,{Location:'http://127.0.0.1:1/private'});res.end();}else if(req.url==='/large'){res.setHeader('Content-Encoding','gzip');res.end(gzipSync(Buffer.alloc(MAX_ASSET_BYTES+1)));}else if(req.url==='/image'){res.setHeader('Content-Encoding','gzip');res.end(gzipSync(bytes));}else{forbidden++;res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const origin='http://127.0.0.1:'+(server.address() as any).port,policy=new TargetPolicy(origin,new Set()),config=readConfig({});
 assert.deepEqual((await fetchAsset({url:origin+'/image',mime:'image/png'},config,policy,async()=>'' )).body,bytes);
 await assert.rejects(()=>fetchAsset({url:origin+'/large',mime:'image/png'},config,policy,async()=>''),/too large/);
 await assert.rejects(()=>fetchAsset({url:origin+'/private',mime:'image/png'},config,policy,async()=>''));assert.equal(forbidden,0);
});
test('resource replay uses the configured proxy and drops original authorization on cross-origin redirects',async t=>{
 const seen:{url:string;auth?:string;cookie?:string;proxy?:string}[]=[];
 const proxy=createServer((req,res)=>{seen.push({url:req.url!,auth:req.headers.authorization,cookie:req.headers.cookie,proxy:req.headers['proxy-authorization'] as string});if(seen.length===1){res.writeHead(302,{Location:'http://second.example/asset'});res.end();}else{res.setHeader('Content-Type','image/png');res.end('ok');}});
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>proxy.close());const server='http://127.0.0.1:'+(proxy.address() as any).port;
 const config=readConfig({ENGINE_MODE:'development',REMOTE_PROXY_SERVER:server,REMOTE_PROXY_USERNAME:'test-user',REMOTE_PROXY_PASSWORD:'test-pass'}),policy=new TargetPolicy('http://fixture.invalid',new Set(['*']),true,async()=>[{address:'8.8.8.8'}]);
 const result=await fetchAsset({url:'http://first.example/asset',mime:'image/png',headers:{authorization:'Bearer fixture'}},config,policy,async url=>new URL(url).hostname==='first.example'?'first=1':'second=1');assert.equal(result.body.toString(),'ok');assert.equal(seen[0].auth,'Bearer fixture');assert.equal(seen[1].auth,undefined);assert.equal(seen[1].cookie,'second=1');assert.equal(seen[0].proxy,'Basic '+Buffer.from('test-user:test-pass').toString('base64'));
 await assert.rejects(()=>fetchAsset({url:'http://first.example/asset',mime:'image/png',method:'POST'},config,policy,async()=>''),/replayed/);
});
test('changing canvas delivery buffers are released on read, bounded and expire without a reader',async()=>{
 const {AssetTransit}=await import('../src/server/asset-transit.js');const transit=new AssetTransit(4,25),body=(value:string)=>({body:Buffer.from(value),mime:'image/png'});
 transit.put('a',body('12'));transit.put('b',body('345'));assert.equal(transit.take('a'),undefined);assert.equal(transit.take('b')!.body.toString(),'345');assert.equal(transit.size,0);
 transit.put('c',body('1'));await new Promise(r=>setTimeout(r,40));assert.equal(transit.size,0);transit.put('d',body('1'));transit.clear();assert.equal(transit.size,0);
});
test('inline resource limits use decoded byte length, including base64 padding',async t=>{
 const {RemoteSession}=await import('../src/server/session.js');const {generateDeviceProfile}=await import('../src/server/device-profile.js');
 const config=readConfig({}),policy=new TargetPolicy('http://fixture.test',new Set()),session=new RemoteSession('fixture-owner',config,policy,generateDeviceProfile());t.after(()=>session.close(true));
 const inline=(size:number)=>'data:image/png;base64,'+Buffer.alloc(size).toString('base64');
 assert.equal((session as any).resource(inline(MAX_ASSET_BYTES+1)),undefined);
 const id=(session as any).resource(inline(MAX_ASSET_BYTES));assert.ok(id);assert.equal((await session.getAsset(id))!.body.length,MAX_ASSET_BYTES);assert.equal((session as any).inlineTransit.size,0);
});

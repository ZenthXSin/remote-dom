import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {WebSocketServer} from 'ws';
import {RemoteSession} from '../../src/server/session.js';import {readConfig} from '../../src/server/config.js';import {TargetPolicy} from '../../src/server/policy.js';import {generateDeviceProfile} from '../../src/server/device-profile.js';
test('proxy boundary preserves native WebSocket and CORS preflights and prevents loopback bypass',{timeout:45000},async t=>{
 let preflights=0,deniedFetches=0,privateHits=0;const requests:string[]=[];
 const upstream=createServer((req,res)=>{const url=new URL(req.url!);requests.push(url.hostname);
  if(req.method==='OPTIONS'){preflights++;res.writeHead(403);res.end();return;}
  if(url.pathname==='/denied'){deniedFetches++;res.end('must not reach');return;}
  res.setHeader('Content-Type','text/html');res.end('<title>Native network</title><button>Ready</button>');
 });upstream.on('connect',(_req,socket,head)=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)socket.unshift(head);upstream.emit('connection',socket);});
 const wss=new WebSocketServer({noServer:true});upstream.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>ws.on('message',data=>ws.send(data,{binary:false}))));
 const trap=createServer((_req,res)=>{privateHits++;res.end('private');});
 await Promise.all([new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r)),new Promise<void>(r=>trap.listen(0,'127.0.0.1',r))]);
 t.after(()=>{wss.close();upstream.closeAllConnections();upstream.close();trap.closeAllConnections();trap.close();});
 const proxy=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
 const config=readConfig({...process.env,ENGINE_MODE:'development',BROWSER_HEADLESS:'1',REMOTE_PROXY_SERVER:proxy,TARGET_HOSTS:'site.example,api.example',ACCOUNT_OWNER:undefined});
 const policy=new TargetPolicy('http://127.0.0.1:1',config.hosts,true,async()=>[{address:'93.184.216.34'}]);
 const session=new RemoteSession('test',config,policy,generateDeviceProfile());t.after(()=>session.close(true));await session.start('http://site.example/');
 assert.equal(await session.page.title(),'Native network');
 const socketResult=await session.page.evaluate(()=>new Promise<string>((resolve,reject)=>{const s=new WebSocket('ws://site.example/echo');s.onopen=()=>s.send('echo');s.onmessage=e=>{s.close();resolve(e.data);};s.onerror=()=>reject(Error('WebSocket failed'));}));assert.equal(socketResult,'echo');
 assert.match(await session.page.evaluate(()=>Function.prototype.toString.call(WebSocket)),/\[native code\]/);
 const cors=await session.page.evaluate(async()=>{try{await fetch('http://api.example/denied',{method:'POST',headers:{'X-Test':'1'},body:'test'});return 'unexpected';}catch{return 'blocked';}});
 assert.equal(cors,'blocked');assert.equal(preflights,1);assert.equal(deniedFetches,0);
 for(const host of ['127.0.0.1','localhost']){
  await session.page.goto(`http://${host}:${(trap.address() as {port:number}).port}/`,{timeout:5000}).catch(()=>{});
 }
 assert.equal(privateHits,0,'implicit Chromium loopback bypass must be disabled');assert.ok(requests.every(h=>['site.example','api.example'].includes(h)));
 await assert.rejects(()=>session.navigate('http://private.example/'),/允许列表/);
});

import {createServer as httpServer,request,type IncomingHttpHeaders,type IncomingMessage,type ServerResponse} from 'node:http';
import {createServer as httpsServer,type ServerOptions} from 'node:https';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Agent} from 'node:http';
import type {Duplex} from 'node:stream';

interface GatewayOptions {upstream:string;publicOrigin?:string;host?:string;port?:number;ttlMs?:number;capability?:string;tls?:ServerOptions}
const hop=new Set(['connection','upgrade','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding']);
function cleanHeaders(source:IncomingHttpHeaders):IncomingHttpHeaders{const blocked=new Set([...hop,...String(source.connection??'').toLowerCase().split(',').map(s=>s.trim())]);return Object.fromEntries(Object.entries(source).filter(([key])=>!blocked.has(key)));}

// A fixed backend, capability entry and same-origin upgrades. This gateway never
// receives target cookies or executes target scripts; the engine owns sessions.
export async function createGateway(options:GatewayOptions){
  const upstream=new URL(options.upstream);if(upstream.protocol!=='http:'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw new Error('Specify a fixed internal HTTP engine endpoint');
  const host=options.host??'127.0.0.1',port=options.port??0;
  if(!options.publicOrigin&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Public origin is required for a public listener');
  let origin=options.publicOrigin??'';
  if(origin){const parsed=new URL(origin);if(parsed.origin!==origin||parsed.username||!['http:','https:'].includes(parsed.protocol)||parsed.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('Public gateway origin must use HTTPS');}
  const key=options.capability??randomBytes(32).toString('hex'),ttl=options.ttlMs??2*3600000;
  if(!/^[a-f0-9]{64}$/.test(key)||!Number.isFinite(ttl)||ttl<0||ttl>12*3600000)throw new Error('Invalid gateway capability or lifetime');
  const expires=ttl===0?Infinity:Date.now()+ttl;let expired=false;
  const sockets=new Set<Duplex>();const agent=new Agent({keepAlive:true,maxSockets:32,maxFreeSockets:4});
  const engineOrigin=`http://127.0.0.1:${upstream.port||80}`;
  const equals=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(key),Buffer.from(value));
  const cookieName=()=>origin.startsWith('https:')?'__Host-rd_gateway':'rd_gateway';
  const granted=(req:IncomingMessage)=>equals((req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName()+'='))?.slice(cookieName().length+1));
  const parse=(req:IncomingMessage)=>{const url=new URL(req.url??'/',origin);return req.headers.host===new URL(origin).host&&url.origin===origin?url:undefined;};
  const forwardHeaders=(req:IncomingMessage,websocket=false)=>{
    const headers=cleanHeaders(req.headers);headers.host=new URL(engineOrigin).host;
    if(req.headers.origin===origin)headers.origin=engineOrigin;
    headers.cookie=(req.headers.cookie??'').split(';').filter(v=>!v.trim().startsWith(cookieName()+'=')).join(';');
    delete headers['forwarded'];delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];
    if(websocket){headers.connection='Upgrade';headers.upgrade='websocket';}
    return headers;
  };
  const deny=(res:ServerResponse,status:number)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(status===410?'测试入口已过期':status===403?'请使用完整访问链接':'网关暂不可用');};
  const handler=(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    if(expired||Date.now()>=expires){deny(res,410);return;}
    let url:URL|undefined;try{url=parse(req);}catch{}if(!url){deny(res,403);return;}
    const entering=req.method==='GET'&&url.pathname==='/'&&equals(url.searchParams.get('access'));
    if(!entering&&!granted(req)){deny(res,403);return;}
    if(!['GET','POST','DELETE','HEAD'].includes(req.method??'')||!['GET','HEAD'].includes(req.method??'')&&req.headers.origin!==origin){deny(res,403);return;}
    if(Number(req.headers['content-length']??0)>96000){deny(res,413);return;}
    if(entering)url.searchParams.delete('access');
    const outgoing=request({hostname:upstream.hostname,port:upstream.port,path:url.pathname+url.search,method:req.method,headers:forwardHeaders(req),agent,timeout:30000},response=>{
      const headers=cleanHeaders(response.headers);headers['cache-control']='no-store';
      if(origin.startsWith('https:')&&headers['set-cookie'])headers['set-cookie']=headers['set-cookie'].map(cookie=>/;\s*secure(?:;|$)/i.test(cookie)?cookie:cookie+'; Secure');
      if(entering)headers['set-cookie']=[...(headers['set-cookie']??[]),`${cookieName()}=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1,Math.min(30*86400,Math.floor((expires-Date.now())/1000)))}${origin.startsWith('https:')?'; Secure':''}`];
      res.writeHead(response.statusCode??502,headers);response.on('error',()=>res.destroy());response.pipe(res);
    });
    outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)deny(res,502);else res.destroy();});
    let bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>96000){outgoing.destroy();if(!res.headersSent)deny(res,413);}});req.on('aborted',()=>outgoing.destroy());
    res.on('close',()=>{if(!res.writableFinished)outgoing.destroy();});req.pipe(outgoing);
  };
  const server=options.tls?httpsServer(options.tls,handler):httpServer(handler);
  server.on('upgrade',(req,client,head)=>{
    const reject=(status=403)=>{client.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
    if(expired||Date.now()>=expires){reject(410);return;}
    let url:URL|undefined;try{url=parse(req);}catch{}
    if(!url||!/^\/api\/sessions\/[a-f0-9-]{36}\/stream$/.test(url.pathname)||url.search||!granted(req)||req.headers.origin!==origin||req.headers.upgrade?.toLowerCase()!=='websocket'){reject();return;}
    sockets.add(client);client.on('error',()=>client.destroy());client.once('close',()=>sockets.delete(client));
    const outgoing=request({hostname:upstream.hostname,port:upstream.port,path:url.pathname,method:'GET',headers:forwardHeaders(req,true),agent:false,timeout:8000});
    client.once('close',()=>outgoing.destroy());
    outgoing.once('upgrade',(response,backend,backendHead)=>{
      if(client.destroyed||expired){backend.destroy();client.destroy();return;}
      sockets.add(backend);backend.once('close',()=>{sockets.delete(backend);client.destroy();});client.once('close',()=>backend.destroy());backend.on('error',()=>backend.destroy());
      backend.setTimeout(0);
      const headers=response.rawHeaders.reduce((lines,value,index)=>index%2?lines:lines+`${value}: ${response.rawHeaders[index+1]}\r\n`,'');
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
      if(backendHead.length)client.write(backendHead);if(head.length)backend.write(head);
      // Raw streams preserve native compression, control frames and backpressure.
      client.pipe(backend);backend.pipe(client);
    });
    outgoing.once('response',response=>{response.resume();reject(response.statusCode??502);});
    outgoing.once('timeout',()=>outgoing.destroy());outgoing.once('error',()=>{if(!client.destroyed)reject(502);});outgoing.end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Gateway unavailable');
  if(!origin)origin=`${options.tls?'https':'http'}://127.0.0.1:${address.port}`;
  const expiry=ttl===0?undefined:setTimeout(()=>{expired=true;for(const socket of sockets)socket.destroy();},ttl);expiry?.unref();
  return {origin,accessUrl:origin+'/?access='+key,expiresAt:ttl===0?null:new Date(expires).toISOString(),server,close:async()=>{clearTimeout(expiry);expired=true;for(const socket of sockets)socket.destroy();agent.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

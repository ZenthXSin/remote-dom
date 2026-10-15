// Temporary Runlocal Phoenix relay protocol; no request/response body logging.
// The capability gateway authenticates every forwarded HTTP/WS request before
// it reaches the fixed engine. The managed proxy and normal CA trust stay on.
import {request,type ClientRequest,type IncomingMessage} from 'node:http';
import WebSocket from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {createGateway} from './server.js';
import {monitorSocket} from '../server/socket-health.js';
const proxy=process.env.HTTPS_PROXY??process.env.HTTP_PROXY;if(!proxy)throw new Error('Managed HTTPS proxy is required');
const ttl=Number(process.env.GATEWAY_TTL_HOURS??2)*3600000;if(!Number.isFinite(ttl)||ttl<3600000||ttl>12*3600000)throw new Error('Invalid preview lifetime');
const expires=Date.now()+ttl;let stopped=false,outer:WebSocket|undefined,gateway:Awaited<ReturnType<typeof createGateway>>|undefined,reconnect:NodeJS.Timeout|undefined;
const upstream=process.env.GATEWAY_UPSTREAM??'http://127.0.0.1:4173';
const httpPeers=new Map<string,{request:ClientRequest;response?:IncomingMessage;bytes:number}>(),wsPeers=new Map<string,{socket:WebSocket;pending:{data:string;binary:boolean}[];bytes:number}>();
function connect(){
 if(stopped)return;const ws=new WebSocket('wss://runlocal.eu/tunnel/websocket?vsn=2.0.0&caps=binary-bodies,stream',{agent:new HttpsProxyAgent(proxy!),maxPayload:16*1024*1024});outer=ws;let serial=0,join='',streamingSupported=false,heartbeat:NodeJS.Timeout|undefined;monitorSocket(ws);
 const send=(topic:string,event:string,payload:unknown)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify([join,String(++serial),topic,event,payload]));};
 const failHttp=(topic:string,id:string,status=502)=>send(topic,'http_response',{request_id:id,status,headers:[['content-type','text/plain']],body:'Gateway unavailable'});
 ws.on('open',()=>{join=String(++serial);ws.send(JSON.stringify([join,join,'tunnel:connect','phx_join',{}]));heartbeat=setInterval(()=>ws.send(JSON.stringify([null,String(++serial),'phoenix','heartbeat',{}])),30000);heartbeat.unref();});
 const drain=(pause:()=>void,resume:()=>void)=>{if(ws.bufferedAmount<=4*1024*1024)return;pause();const close=()=>clearInterval(timer);const timer=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount<1024*1024){clearInterval(timer);ws.off('close',close);resume();}},20);timer.unref();ws.once('close',close);};
 ws.on('message',bytes=>{void(async()=>{
  let message:any;try{message=JSON.parse(bytes.toString());}catch{ws.close(1002);return;}if(!Array.isArray(message)||message.length!==5)return;const [, ,topic,event,payload]=message;if(typeof topic!=='string'||!payload||typeof payload!=='object')return;
  if(event==='tunnel_created'){
   const url=new URL(payload.url);if(url.protocol!=='https:'||!/^[-a-z0-9]+\.runlocal\.eu$/.test(url.hostname)||url.port||url.pathname!=='/'||url.search)throw new Error('Unexpected preview origin');
   streamingSupported=Array.isArray(payload.caps)&&payload.caps.includes('stream');if(!streamingSupported)throw new Error('Relay lacks bounded streaming');await gateway?.close();gateway=await createGateway({upstream,publicOrigin:url.origin,port:4174,ttlMs:Math.max(1,expires-Date.now())});
   console.log(JSON.stringify({url:gateway.origin,accessUrl:gateway.accessUrl,expiresAt:new Date(expires).toISOString(),transport:'websocket'}));return;
  }
  if(event==='phx_reply'&&topic==='tunnel:connect'&&payload.status!=='ok'){console.error('Preview registration rejected');ws.close();return;}
  if(event==='http_request'||event==='http_request_start'){
   const id=payload.request_id;if(typeof id!=='string'||httpPeers.size>=32||!gateway){failHttp(topic,id,503);return;}
   const headers=Object.fromEntries((Array.isArray(payload.headers)?payload.headers:[]).filter((pair:any)=>Array.isArray(pair)&&typeof pair[0]==='string').map(([key,value]:[string,string])=>[key.toLowerCase(),value]));headers.host=new URL(gateway.origin).host;
   const outgoing=request({hostname:'127.0.0.1',port:4174,path:String(payload.path??'/')+(payload.query_string?'?'+payload.query_string:''),method:payload.method,headers,timeout:30000},response=>{
    const peer=httpPeers.get(id);if(peer)peer.response=response;const responseHeaders=Object.entries(response.headers).flatMap(([key,value])=>Array.isArray(value)?value.map(item=>[key,item]):[[key,value]]).filter(([key])=>!['transfer-encoding','connection'].includes(key!));

    // The registration advertises stream support. Current public server accepts
    // these frames; streaming also bounds resource/download memory.
    send(topic,'http_response_start',{request_id:id,status:response.statusCode,headers:responseHeaders});
    response.on('data',chunk=>{send(topic,'http_response_chunk',{request_id:id,body:Buffer.from(chunk).toString('base64'),body_encoding:'base64'});drain(()=>response.pause(),()=>response.resume());});
    const end=()=>{if(httpPeers.delete(id))send(topic,'http_response_end',{request_id:id});};response.once('end',end);response.once('error',end);
   });httpPeers.set(id,{request:outgoing,bytes:0});outgoing.once('timeout',()=>outgoing.destroy());outgoing.once('error',()=>{if(httpPeers.delete(id))failHttp(topic,id);});
   if(event==='http_request'){const body=payload.body?Buffer.from(payload.body,payload.body_encoding==='base64'?'base64':'utf8'):Buffer.alloc(0);if(body.length>96000){outgoing.destroy();return;}outgoing.end(body);}return;
  }
  if(event==='http_request_chunk'){const peer=httpPeers.get(payload.request_id);if(peer){const body=Buffer.from(payload.body??'',payload.body_encoding==='base64'?'base64':'utf8');peer.bytes+=body.length;if(peer.bytes>96000)peer.request.destroy();else peer.request.write(body);}return;}
  if(event==='http_request_end'){httpPeers.get(payload.request_id)?.request.end();return;}
  if(event==='http_cancel'){const peer=httpPeers.get(payload.request_id);httpPeers.delete(payload.request_id);peer?.request.destroy();peer?.response?.destroy();return;}
  if(event==='ws_upgrade'){
   const id=payload.ws_id;if(typeof id!=='string'||wsPeers.size>=8||!gateway){send(topic,'ws_close',{ws_id:id});return;}
   const headers=Object.fromEntries((Array.isArray(payload.headers)?payload.headers:[]).filter(([key]:[string,string])=>!['host','upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-extensions'].includes(key.toLowerCase())));headers.Host=new URL(gateway.origin).host;
   const local=new WebSocket('ws://127.0.0.1:4174'+payload.path+(payload.query_string?'?'+payload.query_string:''),{headers,maxPayload:8*1024*1024});const peer={socket:local,pending:[] as {data:string;binary:boolean}[],bytes:0};wsPeers.set(id,peer);
   local.on('open',()=>{for(const item of peer.pending)local.send(item.binary?Buffer.from(item.data,'base64'):item.data);peer.pending=[];peer.bytes=0;});
   local.on('message',(data,binary)=>{send(topic,'ws_frame',{ws_id:id,data:binary?Buffer.from(data as Buffer).toString('base64'):data.toString(),opcode:binary?'binary':'text'});drain(()=>local.pause(),()=>local.resume());});
   const close=()=>{if(wsPeers.delete(id))send(topic,'ws_close',{ws_id:id});};local.once('close',close);local.once('error',()=>{close();local.terminate();});return;
  }
  if(event==='ws_client_frame'){
   const peer=wsPeers.get(payload.ws_id);if(!peer||typeof payload.data!=='string')return;if(payload.data.length>96000){peer.socket.close(1009);return;}
   const binary=payload.opcode==='binary';if(peer.socket.readyState===WebSocket.OPEN)peer.socket.send(binary?Buffer.from(payload.data,'base64'):payload.data);else if(peer.socket.readyState===WebSocket.CONNECTING&&peer.pending.length<16&&peer.bytes+payload.data.length<=128000){peer.pending.push({data:payload.data,binary});peer.bytes+=payload.data.length;}else peer.socket.terminate();return;
  }
  if(event==='ws_close'){const peer=wsPeers.get(payload.ws_id);wsPeers.delete(payload.ws_id);peer?.socket.close();return;}
 })().catch(()=>{console.error('Preview protocol unavailable');ws.close(1011);});});
 ws.on('error',()=>console.error('Preview relay unavailable'));
 ws.on('close',()=>{clearInterval(heartbeat);for(const peer of httpPeers.values()){peer.request.destroy();peer.response?.destroy();}httpPeers.clear();for(const peer of wsPeers.values())peer.socket.terminate();wsPeers.clear();if(!stopped)reconnect=setTimeout(connect,3000);});
}
async function stop(){stopped=true;clearTimeout(reconnect);outer?.terminate();for(const peer of httpPeers.values())peer.request.destroy();for(const peer of wsPeers.values())peer.socket.terminate();await gateway?.close();}
connect();const expiry=setTimeout(()=>void stop().then(()=>process.exit(0)),ttl);expiry.unref();for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void stop().then(()=>process.exit(0)));

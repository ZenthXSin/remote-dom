import {get} from 'node:https';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {isIP} from 'node:net';
import {publicProxyLookup} from './proxy-network.js';
import type {Config} from './config.js';

// DNS is also carried through the configured proxy. An internal worker network
// has no route to public DNS servers; giving it an egress NIC would break isolation.
export function proxyResolver(proxy:NonNullable<Config['proxy']>,query?: (hostname:string,type:'A'|'AAAA')=>Promise<unknown>,publicOnly=false){
 const address=new URL(proxy.server);if(!['http:','https:'].includes(address.protocol))throw new Error('隔离容器的 DNS 解析目前要求 HTTP/HTTPS 代理');if(proxy.username)address.username=proxy.username;if(proxy.password)address.password=proxy.password;
 const agent=new HttpsProxyAgent(address,{keepAlive:true,maxSockets:16,maxFreeSockets:2,...(publicOnly?{lookup:publicProxyLookup}:{})});
 const load=query??((hostname:string,type:'A'|'AAAA')=>new Promise<unknown>((resolve,reject)=>{const fail=()=>reject(new Error('代理 DNS 解析失败'));const req=get('https://dns.google/resolve?name='+encodeURIComponent(hostname)+'&type='+type,{agent,headers:{Accept:'application/dns-json'},timeout:4000},res=>{const chunks:Buffer[]=[];let size=0;res.on('error',fail);res.on('data',c=>{size+=c.length;if(size>32768){req.destroy();fail();return;}chunks.push(c);});res.on('end',()=>{if(res.statusCode!==200){fail();return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{fail();}});});req.on('timeout',()=>req.destroy());req.on('error',fail);}));
 const cache=new Map<string,{expires:number;addresses:{address:string}[]}>(),pending=new Map<string,Promise<{address:string}[]>>();
 return async(hostname:string)=>{if(hostname.length>253||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname))throw new Error('域名格式不正确');const existing=cache.get(hostname);if(existing&&existing.expires>Date.now())return existing.addresses;const inFlight=pending.get(hostname);if(inFlight)return inFlight;if(pending.size>=8)throw new Error('DNS 解析繁忙，请稍后重试');
 const run=(async()=>{const responses=await Promise.all([load(hostname,'A'),load(hostname,'AAAA')]);const addresses:{address:string}[]=[];for(const raw of responses){const response=raw as {Status?:number;Answer?:{type:number;data:string}[]};if(response.Status===3)continue;if(response.Status!==0||response.Answer!==undefined&&!Array.isArray(response.Answer))throw new Error('代理 DNS 响应无效');for(const answer of response.Answer??[]){if(answer.type!==1&&answer.type!==28)continue;if(!isIP(answer.data))throw new Error('代理 DNS 响应无效');addresses.push({address:answer.data});}}if(cache.size>=512)cache.delete(cache.keys().next().value!);cache.set(hostname,{addresses,expires:Date.now()+30000});return addresses;})();pending.set(hostname,run);try{return await run;}finally{pending.delete(hostname);}
 };
}

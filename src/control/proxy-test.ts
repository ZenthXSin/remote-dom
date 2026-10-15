import {request as httpRequest} from 'node:http';
import {request as httpsRequest,get,Agent} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import type {Duplex} from 'node:stream';
import {isIP} from 'node:net';
import {publicProxyLookup} from '../server/proxy-network.js';
import {isPublicAddress} from '../server/policy.js';
import type {EgressProfile} from './egress-store.js';

// Fixed HTTPS destination; bounded CONNECT, verified TLS, and no direct fallback.
async function testProxyIpv4(profile:EgressProfile){
 const address=new URL(profile.server!),host=address.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(address.protocol)||address.username||address.password||isIP(host)&&!isPublicAddress(host))throw new Error('代理需使用公网 HTTP/HTTPS 地址');
 const started=Date.now(),destination='www.cloudflare.com';
 return new Promise<{ok:true;ip:string;country:string;latencyMs:number;checkedAt:string}>((resolve,reject)=>{
  let tunnel:Duplex|undefined,probe:ReturnType<typeof get>|undefined,agent:Agent|undefined,done=false;
  const cleanup=()=>{clearTimeout(timer);connector.destroy();probe?.destroy();agent?.destroy();tunnel?.destroy();};
  const fail=(message:string)=>{if(done)return;done=true;cleanup();reject(new Error(message));};
  const connector=(address.protocol==='https:'?httpsRequest:httpRequest)({hostname:host,port:address.port||undefined,method:'CONNECT',path:destination+':443',agent:false,lookup:publicProxyLookup,maxHeaderSize:16384,headers:{Host:destination+':443',...(profile.username?{'Proxy-Authorization':'Basic '+Buffer.from(profile.username+':'+(profile.password??'')).toString('base64')}:{})}});
  const timer=setTimeout(()=>fail('代理连接超时，请检查地址、端口或线路状态'),12000);
  connector.on('error',()=>fail('代理连接失败，请检查协议、地址和认证信息'));
  connector.on('response',res=>{res.resume();fail(res.statusCode===407?'代理认证失败，请检查用户名和密码':'代理拒绝了连接请求');});
  connector.on('connect',(res,socket,head)=>{
   tunnel=socket;socket.on('error',()=>fail('代理连接中断，请重试'));if(done){socket.destroy();return;}
   if(res.statusCode!==200){fail(res.statusCode===407?'代理认证失败，请检查用户名和密码':'代理拒绝了连接请求');return;}if(head.length)socket.unshift(head);
   agent=new Agent();agent.createConnection=()=>tlsConnect({socket,servername:destination,rejectUnauthorized:true});
   probe=get('https://'+destination+'/cdn-cgi/trace',{agent,maxHeaderSize:16384},response=>{
    if(response.statusCode!==200){response.resume();fail('代理无法访问测试网站，请检查线路');return;}
    let text='';response.on('data',chunk=>{text+=chunk;if(text.length>16384)fail('代理测试响应异常');});response.on('error',()=>fail('代理连接中断，请重试'));
    response.on('end',()=>{if(done)return;const fields=Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));if(!isIP(fields.ip??'')||!isPublicAddress(fields.ip)||!/^[A-Z]{2}$/.test(fields.loc??'')){fail('代理测试响应异常');return;}done=true;cleanup();resolve({ok:true,ip:fields.ip,country:fields.loc,latencyMs:Date.now()-started,checkedAt:new Date().toISOString()});});
   });probe.on('error',()=>fail('代理无法建立安全连接，请检查线路'));
  });connector.end();
 });
}

// A successful IPv4 trace does not establish that IPv6-only resources work.
// Keep this probe on the same authenticated upstream, with verified TLS.
async function testProxyIpv6(profile:EgressProfile):Promise<'reachable'|'unavailable'>{
 const address=new URL(profile.server!),destination='ipv6.google.com';
 return new Promise(resolve=>{
  let tunnel:Duplex|undefined,secure:ReturnType<typeof tlsConnect>|undefined,done=false;
  const finish=(status:'reachable'|'unavailable')=>{if(done)return;done=true;clearTimeout(timer);secure?.destroy();tunnel?.destroy();connector.destroy();resolve(status);};
  const connector=(address.protocol==='https:'?httpsRequest:httpRequest)({hostname:address.hostname.replace(/^\[|\]$/g,''),port:address.port||undefined,method:'CONNECT',path:destination+':443',agent:false,lookup:publicProxyLookup,maxHeaderSize:16384,headers:{Host:destination+':443',...(profile.username?{'Proxy-Authorization':'Basic '+Buffer.from(profile.username+':'+(profile.password??'')).toString('base64')}:{})}});
  const timer=setTimeout(()=>finish('unavailable'),8000);
  connector.on('error',()=>finish('unavailable'));
  connector.on('response',response=>{response.resume();finish('unavailable');});
  connector.on('connect',(response,socket,head)=>{
   tunnel=socket;socket.on('error',()=>finish('unavailable'));if(done){socket.destroy();return;}
   if(response.statusCode!==200){finish('unavailable');return;}if(head.length)socket.unshift(head);
   secure=tlsConnect({socket,servername:destination,rejectUnauthorized:true});
   secure.once('error',()=>finish('unavailable'));secure.once('secureConnect',()=>finish('reachable'));
  });connector.end();
 });
}

export async function testProxy(profile:EgressProfile){
 const address=new URL(profile.server!),host=address.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(address.protocol)||address.username||address.password||isIP(host)&&!isPublicAddress(host))throw new Error('代理需使用公网 HTTP/HTTPS 地址');
 const [result,ipv6]=await Promise.all([testProxyIpv4(profile),testProxyIpv6(profile)]);
 return {...result,ipv6};
}

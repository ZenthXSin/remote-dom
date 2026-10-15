import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address:string):boolean {
  try {
    let parsed=ipaddr.parse(address.replace(/^\[|\]$/g,''));
    if(parsed.kind()==='ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress())parsed=(parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range()==='unicast';
  } catch {return false;}
}
export class TargetPolicy {
  constructor(readonly fixtureOrigin:string,readonly hosts:Set<string>,readonly development=false,readonly resolver:(hostname:string)=>Promise<{address:string}[]>=hostname=>lookup(hostname,{all:true}),readonly fixtureAliases:Set<string>=new Set()){}
  async assert(raw:string):Promise<URL> {
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('仅支持不含凭据的 HTTP/HTTPS 地址');
    if(url.origin===this.fixtureOrigin||this.fixtureAliases.has(url.origin))return url;
    if(!this.development)throw new Error('当前研发模式仅允许内置测试站');
    if(url.port&&url.port!==(url.protocol==='https:'?'443':'80'))throw new Error('当前测试入口仅支持 HTTP 80 与 HTTPS 443');
    const hostname=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(!this.hosts.has('*')&&!this.hosts.has(hostname))throw new Error('目标域名未在开发允许列表中');
    if(hostname==='localhost'||hostname.endsWith('.localhost')||hostname.endsWith('.local'))throw new Error('禁止内部地址');
    const addresses=isIP(hostname)?[{address:hostname}]:await this.resolver(hostname);
    if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new Error('禁止非公网地址');
    return url;
  }
}

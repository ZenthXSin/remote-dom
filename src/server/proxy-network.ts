import {lookup} from 'node:dns';
import type {LookupFunction} from 'node:net';
import {isPublicAddress} from './policy.js';

// Validate the addresses actually used for each connection, including proxy DNS
// requests. A user-supplied hostname must not reach private host/container services.
export const publicProxyLookup:LookupFunction=(hostname,options,callback)=>{
 lookup(hostname,{all:true},(error,addresses)=>{
  if(error){callback(error,'');return;}
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address))){callback(new Error('个人代理需使用公网地址'),'');return;}
  const family=options.family==='IPv4'?4:options.family==='IPv6'?6:options.family;
  const candidates=family?addresses.filter(a=>a.family===family):addresses;
  if(!candidates.length){callback(new Error('个人代理地址不可用'),'');return;}
  if(options.all)callback(null,candidates);else callback(null,candidates[0].address,candidates[0].family);
 });
};

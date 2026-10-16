import type {CDPSession} from 'playwright-core';
import {Diagnostics,diagnosticCookies,diagnosticTarget} from './diagnostics.js';
const names=new Set(['cf_clearance','__cf_bm']);
// CDP ExtraInfo reports the actual network headers, including CHIPS cookies.
// Playwright allHeaders can omit partitioned cookies before interception resumes.
export function watchNetworkDiagnostics(cdp:CDPSession,log:Diagnostics,window:string){
 cdp.on('Network.requestWillBeSent',e=>{log.add('network-request',{window,networkId:e.requestId,method:e.request.method,resource:e.type,...diagnosticTarget(e.request.url)});});
 cdp.on('Network.requestWillBeSentExtraInfo',e=>{
  if(!log.active)return;
  const header=Object.entries(e.headers).find(([key])=>key.toLowerCase()==='cookie')?.[1];
  log.add('network-cookies',{window,networkId:e.requestId,source:'chromium-network',...diagnosticCookies(header),cookies:e.associatedCookies.filter(c=>names.has(c.cookie.name)).map(c=>({name:c.cookie.name,domain:c.cookie.domain,pathId:diagnosticTarget('https://cookie.invalid'+c.cookie.path).pathId,secure:c.cookie.secure,sameSite:c.cookie.sameSite,partitioned:!!c.cookie.partitionKey,blockedReasons:c.blockedReasons}))});
 });
 cdp.on('Network.responseReceivedExtraInfo',e=>{
  if(!log.active)return;
  log.add('network-response',{window,networkId:e.requestId,status:e.statusCode});
  for(const blocked of e.blockedCookies??[]){const name=blocked.cookie?.name??blocked.cookieLine.split('=',1)[0];if(names.has(name))log.add('cookie-rejected',{window,networkId:e.requestId,cookie:name,domain:blocked.cookie?.domain,reasons:blocked.blockedReasons});}
 });
}

import type {Config} from './config.js';
import type {TargetPolicy} from './policy.js';
import {createUpstreamRelay} from '../control/upstream-relay.js';

// Enforce destination policy at the HTTP proxy boundary. Chromium keeps its
// native HTTP/cache/service-worker/WebSocket implementations; TLS stays opaque.
export async function createBrowserProxy(proxy:NonNullable<Config['proxy']>,policy:TargetPolicy){
  if(!['http:','https:'].includes(new URL(proxy.server).protocol))return;
  return createUpstreamRelay({profile:{id:'browser-policy',name:'Browser policy',mode:'custom',enabled:true,maxAccounts:1,...proxy},
    assertTarget:target=>policy.assert(target)});
}

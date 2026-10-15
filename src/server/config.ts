import {resolve} from 'node:path';
import {hostname} from 'node:os';
export interface Config {
  host:string; port:number; mode:'demo'|'development'; chromiumPath:string;
  proxy?:{server:string;username?:string;password?:string};
  hosts:Set<string>; defaultUrl?:string; maxSessions:number; idleMs:number; assetDir:string;deviceProfilePath:string;environmentProfilePath?:string;
  stateDir?:string;accountOwner?:string;
}
export function readConfig(env:NodeJS.ProcessEnv=process.env):Config {
  if(env.NODE_ENV==='production'||env.ENGINE_MODE==='production')throw new Error('生产启动被禁用：尚未实现每会话虚拟机与内核出口隔离，不得以开发运行器替代。');
  const mode=env.ENGINE_MODE??'demo';
  if(mode!=='demo'&&mode!=='development')throw new Error('ENGINE_MODE must be demo or development');
  let proxy:Config['proxy'];
  if(mode==='development'){
    if(!env.REMOTE_PROXY_SERVER)throw new Error('development 模式必须设置 REMOTE_PROXY_SERVER，禁止默认直连');
    const parsed=new URL(env.REMOTE_PROXY_SERVER);
    if(!['http:','https:','socks5:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('代理地址不合法；凭据应通过独立环境变量提供');
    proxy={server:parsed.origin==='null'?`${parsed.protocol}//${parsed.host}`:parsed.origin,username:env.REMOTE_PROXY_USERNAME,password:env.REMOTE_PROXY_PASSWORD};
  }
  const host=env.ENGINE_HOST??'127.0.0.1';
  if(host!=='127.0.0.1'&&host!=='0.0.0.0')throw new Error('ENGINE_HOST must be 127.0.0.1 or container bind 0.0.0.0');
  if(env.ACCOUNT_OWNER&&!/^[a-f0-9]{64}$/.test(env.ACCOUNT_OWNER))throw new Error('Invalid account owner');
  return {host,port:Number(env.PORT??4173),mode,chromiumPath:env.CHROMIUM_PATH??'/usr/bin/chromium',proxy,accountOwner:env.ACCOUNT_OWNER,
    hosts:new Set((env.TARGET_HOSTS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)),defaultUrl:env.DEFAULT_TARGET_URL,
    maxSessions:4,idleMs:15*60*1000,assetDir:resolve('dist'),
    stateDir:env.BROWSER_STATE_DIR,deviceProfilePath:env.DEVICE_PROFILE_PATH??resolve(env.DEVICE_PROFILE_DIR??'.runtime/container-profiles',`${hostname()}.json`),environmentProfilePath:env.CONTAINER_ENVIRONMENT_PATH};
}

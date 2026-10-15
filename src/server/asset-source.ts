import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {HttpsProxyAgent} from 'https-proxy-agent';
import type {Config} from './config.js';
import type {TargetPolicy} from './policy.js';
export const MAX_ASSET_BYTES=2*1024*1024;
export const ASSET_MIMES=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','audio/wav','audio/x-wav','audio/mpeg','audio/ogg','audio/webm','video/mp4','video/webm','video/ogg','font/woff2','font/woff','application/font-woff','application/font-woff2','font/ttf','font/otf']);
export interface AssetBody {body:Buffer;mime:string}
export interface AssetSource {url:string;mime:string;headers?:Record<string,string>;method?:string}
// Bounded streaming fallback. Every redirect is re-authorized and uses the same
// proxy. Unlike APIRequestContext this never retains completed response bodies.
export async function fetchAsset(source:AssetSource,config:Config,policy:TargetPolicy,cookies:(url:string)=>Promise<string>):Promise<AssetBody>{
 if(source.method&&source.method!=='GET')throw new Error('Resource cannot be replayed');
 let url=source.url;const firstOrigin=new URL(url).origin;const signal=AbortSignal.timeout(10000);
 for(let hop=0;hop<=5;hop++){
  const target=await policy.assert(url);target.hash='';if(signal.aborted)throw new Error('Resource timed out');
  const headers:Record<string,string>={Accept:source.mime,...source.headers,'Accept-Encoding':'identity',Host:target.host};
  if(target.origin!==firstOrigin){delete headers.authorization;delete headers.origin;delete headers.referer;}
  const cookie=await cookies(target.href);if(cookie)headers.Cookie=cookie;
  const fixture=target.origin===policy.fixtureOrigin||policy.fixtureAliases.has(target.origin);
  const proxy=!fixture&&config.proxy?new URL(config.proxy.server):undefined;
  if(!fixture&&!proxy)throw new Error('Resource proxy is required');
  if(proxy){if(!['http:','https:'].includes(proxy.protocol))throw new Error('Unsupported resource proxy');if(config.proxy?.username)proxy.username=config.proxy.username;if(config.proxy?.password)proxy.password=config.proxy.password;}
  const agent=proxy&&target.protocol==='https:'?new HttpsProxyAgent(proxy):undefined;
  const endpoint=proxy&&target.protocol==='http:'?new URL(proxy):target;
  if(proxy&&target.protocol==='http:'){
   if(proxy.username||proxy.password)headers['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
   endpoint.username='';endpoint.password='';
  }
  try{
   const result=await new Promise<AssetBody|{redirect:string}>((resolve,reject)=>{
    const request=(endpoint.protocol==='https:'?httpsRequest:httpRequest)(endpoint,{method:'GET',headers,agent,path:proxy&&target.protocol==='http:'?target.href:target.pathname+target.search,signal},response=>{
     const status=response.statusCode??0;
     if([301,302,303,307,308].includes(status)&&response.headers.location){response.destroy();resolve({redirect:new URL(response.headers.location,target).href});return;}
     const mime=(response.headers['content-type']??'').split(';')[0].trim().toLowerCase();
     if(status<200||status>=300||!ASSET_MIMES.has(mime)||Number(response.headers['content-length']??0)>MAX_ASSET_BYTES){response.destroy();reject(new Error('Resource unavailable or too large'));return;}
     const encoding=response.headers['content-encoding'];
     const decoder=encoding==='gzip'?createGunzip():encoding==='br'?createBrotliDecompress():encoding==='deflate'?createInflate():undefined;
     if(encoding&&encoding!=='identity'&&!decoder){response.destroy();reject(new Error('Unsupported resource encoding'));return;}
     const stream=decoder?response.pipe(decoder):response;
     response.on('error',error=>{decoder?.destroy();reject(error);});
     const chunks:Buffer[]=[];let size=0;
     stream.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_ASSET_BYTES){stream.destroy(new Error('Resource too large'));response.destroy();return;}chunks.push(chunk);});
     stream.on('error',error=>{response.destroy();reject(error);});stream.on('end',()=>resolve({body:Buffer.concat(chunks,size),mime}));
    });request.on('error',reject);request.end();
   });
   if('body' in result)return result;url=result.redirect;
  }finally{agent?.destroy();}
 }
 throw new Error('Too many resource redirects');
}

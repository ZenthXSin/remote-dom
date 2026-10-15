// Trusted development maintenance module. No HTTP route exposes this module.
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {RemoteSession} from './session.js';
import {FrameCapture} from './frame-capture.js';
import {createApp,type RunningAppState} from './app.js';
export {RemoteSession};

export async function prepareUpgrade(assetDir:string){
  const [captureSource,html,appJs,frameJs]=await Promise.all(['capture.js','public/index.html','public/app.js','public/frame.js'].map(path=>readFile(`${assetDir}/${path}`,'utf8')));
  return {install(app:any,owners?:Map<string,number>,running?:RunningAppState){
    const hydration:Promise<unknown>[]=[];let count=0;
    for(const session of app.sessions.values()){
      const hadSvg=session.svgSources instanceof Map;
      session.svgSources??=new Map();session.svgBytes??=0;session.inputRevision??=0;
      session.lastViewActivity??=0;session.capturedAssetState??='';
      Object.setPrototypeOf(session,RemoteSession.prototype);session.captureSource=captureSource;
      if(!hadSvg)session.context.on('response',(response:any)=>{void(async()=>{
        if((response.headers()['content-type']??'').split(';')[0]!=='image/svg+xml'||session.svgSources.size>=32||session.svgBytes>=4*1024*1024)return;
        const length=Number(response.headers()['content-length']??0);if(length>2*1024*1024)return;
        const body=await response.body();if(session.closed||body.length>2*1024*1024||session.svgBytes+body.length>4*1024*1024||session.svgSources.has(response.url()))return;
        session.svgSources.set(response.url(),body.toString());session.svgBytes+=body.length;
      })().catch(()=>{});});
      for(const window of session.windows.values()){window.page.removeAllListeners('dialog');session.watchDialogs(window.page);window.capture=new FrameCapture(window.page,window.cdp,captureSource,session.svgSources);
        hydration.push((async()=>{
          const urls:string[]=await window.page.evaluate(()=>[...new Set([...document.querySelectorAll('svg use, img')].flatMap(n=>{
            const href=n instanceof HTMLImageElement?n.currentSrc:n.getAttribute('href')??n.getAttributeNS('http://www.w3.org/1999/xlink','href');
            if(!href||href.startsWith('#'))return [];try{const u=new URL(href,location.href);u.hash='';if(n instanceof HTMLImageElement&&!u.pathname.endsWith('.svg'))return [];return [u.href];}catch{return [];}
          }))].slice(0,32));
          for(const url of urls){await session.policy.assert(url);await window.page.evaluate(async (url:string)=>{try{const response=await fetch(url,{cache:'force-cache'});const reader=response.body?.getReader();let bytes=0;if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>2*1024*1024){await reader.cancel();break;}}}catch{}},url);}
        })().catch(()=>{}));
      }
      session.capture=session.windows.get(session.activeWindow).capture;session.epoch=randomUUID();session.current=undefined;session.history.clear();session.events.clear();session.lastError='';count++;
    }
    const server=app.server;const marker=Symbol.for('remote-dom.originalRequest');
    const listeners=server.listeners('request');if(listeners.length!==1)throw new Error('Unexpected engine request listeners');
    const previous=listeners[0];const original=server[marker]??previous;server[marker]=original;
    const updated=function(this:any,req:any,res:any){
      const path=new URL(req.url??'/','http://localhost').pathname;
      if(owners&&path.startsWith('/api/')){
        const owner=(req.headers.cookie??'').split(';').map((v:string)=>v.trim()).find((v:string)=>v.startsWith('rd_owner='))?.slice(9);
        if(owner&&(owners.get(owner)??0)>Date.now()&&(owners.get(owner)??0)<Date.now()+2*3600000){owners.set(owner,Date.now()+24*3600000);res.setHeader('Set-Cookie',`rd_owner=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);}
        const setHeader=res.setHeader;res.setHeader=function(name:string,value:any){if(name.toLowerCase()==='set-cookie'){const extend=(cookie:string)=>{const token=cookie.match(/^rd_owner=([a-f0-9]{64});/)?.[1];if(token){owners.set(token,Date.now()+24*3600000);return cookie.replace(/Max-Age=\d+/,'Max-Age=86400');}return cookie;};value=Array.isArray(value)?value.map(extend):extend(String(value));}return setHeader.call(this,name,value);};
      }
      if(req.method==='GET'&&['/','/app.js','/mirror'].includes(path)){
        res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
        if(path==='/'){res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}
        else if(path==='/app.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(appJs);}
        else{const nonce=randomBytes(18).toString('base64');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'none'; font-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;}body{overflow:auto}#mirror-root{min-height:100vh}</style></head><body><div id="mirror-root"></div><script nonce="${nonce}">${frameJs.replaceAll('</script','<\\/script')}</script></body></html>`);}
        return;
      }
      return original.call(this,req,res);
    };
    server.removeListener('request',previous);server.on('request',updated);
    return {count,ready:(async()=>{await Promise.all(hydration);const state=running??app.runtime;if(state){const replacement=await createApp(state.config,state);Object.assign(app,replacement);(globalThis as any).__rdRunningApp=app;}return true;})()};
  }};
}

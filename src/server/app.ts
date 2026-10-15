import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import type {Config} from './config.js';
import {startFixture} from './fixture.js';
import {TargetPolicy} from './policy.js';
import {RemoteSession} from './session.js';
import type {UserEvent} from '../shared/protocol.js';
import {loadContainerProfile} from './device-profile.js';
import {verifyContainerEnvironment} from './container-environment.js';
import {BrowserStore} from './browser-store.js';
import {gzipSync} from 'node:zlib';
import {proxyResolver} from './proxy-resolver.js';

function reply(res:ServerResponse,status:number,body:unknown,compress=false){
  let bytes=Buffer.from(JSON.stringify(body));
  if(compress&&bytes.length>8192){const zipped=gzipSync(bytes,{level:1});if(zipped.length<bytes.length){bytes=zipped;res.setHeader('Content-Encoding','gzip');}res.setHeader('Vary','Accept-Encoding');}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);
}
async function body(req:IncomingMessage,max=16000):Promise<Record<string,unknown>> {
  let length=0;const chunks:Buffer[]=[];
  for await(const chunk of req){length+=chunk.length;if(length>max)throw new Error('请求过大');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('无效请求');return value;
}
export interface RunningAppState {config:Config;sessions:Map<string,RemoteSession>;owners:Map<string,number>;fixture:Awaited<ReturnType<typeof startFixture>>;origin:string;server:Server;cleanup:NodeJS.Timeout;wss:WebSocketServer;deviceProfile:Awaited<ReturnType<typeof loadContainerProfile>>;containerEnvironment?:Awaited<ReturnType<typeof verifyContainerEnvironment>>;store?:BrowserStore}
export async function createApp(config:Config,running?:RunningAppState) {
  const deviceProfile=running?.deviceProfile??await loadContainerProfile(config.deviceProfilePath);
  const containerEnvironment=running?.containerEnvironment??(config.environmentProfilePath?await verifyContainerEnvironment(config.environmentProfilePath,deviceProfile):undefined);
  const fixture=running?.fixture??await startFixture();
  const fixtureAlias=new URL(fixture.origin);fixtureAlias.hostname='localhost';
  const policy=new TargetPolicy(fixture.origin,config.hosts,config.mode==='development',config.proxy&&config.accountOwner?proxyResolver(config.proxy):undefined,new Set([fixtureAlias.origin]));
  const store=running?.store??(config.stateDir?new BrowserStore(config.stateDir):undefined);if(store&&!running?.store)await store.initialize();
  const sessions=running?.sessions??new Map<string,RemoteSession>();const owners=running?.owners??store?.owners()??new Map<string,number>();
  let pending=0;const pendingOwners=new Map<string,number>();
  if(config.accountOwner){const expires=Date.now()+30*24*3600000;owners.set(config.accountOwner,expires);await store?.rememberOwner(config.accountOwner,expires);}
  let origin=running?.origin??'';
  const [html,appJs,frameJs]=await Promise.all(['index.html','app.js','frame.js'].map(name=>readFile(join(config.assetDir,'public',name),'utf8')));
  const ownerFor=(req:IncomingMessage)=>{const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('rd_owner='))?.slice(9);return cookie&&(!config.accountOwner||cookie===config.accountOwner)&&(owners.get(cookie)??0)>Date.now()?cookie:undefined;};
  const server=running?.server??createServer();
  const requestHandler=(req:IncomingMessage,res:ServerResponse)=>{void(async()=>{
    const path=new URL(req.url??'/',origin||'http://localhost').pathname;
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    if(path==='/health'&&req.method==='GET'){reply(res,200,{ok:true,mode:config.mode,productionReady:false});return;}
    if(path==='/'&&req.method==='GET'){
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
    }
    if(path==='/app.js'&&req.method==='GET'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(appJs);return;}
    if(path==='/mirror'&&req.method==='GET'){
      const nonce=randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'none'; font-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`);
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;}body{overflow:auto}#mirror-root{min-height:100vh}</style></head><body><div id="mirror-root"></div><script nonce="${nonce}">${frameJs.replaceAll('</script','<\\/script')}</script></body></html>`);return;
    }
    if(path==='/api/state'&&req.method==='GET'){
      if(config.accountOwner){if((req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('rd_owner='))?.slice(9)!==config.accountOwner){reply(res,401,{error:'账号环境凭证不匹配'});return;}const expires=Date.now()+30*24*3600000;owners.set(config.accountOwner,expires);await store?.rememberOwner(config.accountOwner,expires);}
      let owner=ownerFor(req);if(!owner){if(owners.size>=100){reply(res,503,{error:'研发访客数量已达上限'});return;}owner=randomBytes(32).toString('hex');owners.set(owner,Date.now()+30*24*3600000);await store?.rememberOwner(owner,Date.now()+30*24*3600000);res.setHeader('Set-Cookie',`rd_owner=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);}
      const defaultUrl=config.mode==='development'?(config.defaultUrl??(config.hosts.size===1&&!config.hosts.has('*')?`https://${[...config.hosts][0]}/`:fixture.origin)):fixture.origin;
      reply(res,200,{assetCacheScope:createHash('sha256').update('asset-cache-v1:'+owner).digest('hex'),mode:config.mode,deviceProfile,containerEnvironment,transport:req.headers['x-engine-http-transport']==='1'?'http':'websocket',fixtureUrl:fixture.origin,defaultUrl,allowedHosts:[...config.hosts],sessions:[...sessions.values()].filter(s=>s.owner===owner).map(s=>s.summary()),savedSessions:store?.list(owner)??[],limits:{maxSessions:2},capabilities:{dom:true,remoteJs:true,localRendering:true,canvas:true,iframes:true,uploads:true,downloads:true,popups:true,contenteditable:true,persistentLogin:!!store,basicMedia:true,productionIsolation:false}});return;
    }
    const owner=ownerFor(req);if(!owner){reply(res,401,{error:'请刷新页面重新建立研发会话'});return;}
    if(req.method!=='GET'&&req.headers.origin!==origin){reply(res,403,{error:'请求来源不匹配'});return;}
    if(path==='/api/recovery'&&req.method==='GET'){if(!store){reply(res,400,{error:'尚未配置浏览器存储'});return;}await store.rememberOwner(owner,Date.now()+30*24*3600000);reply(res,200,{token:store.recovery(owner)});return;}
    if(path==='/api/recovery'&&req.method==='POST'){const request=await body(req);const recovered=typeof request.token==='string'?store?.ownerForRecovery(request.token):undefined;if(!recovered){reply(res,404,{error:'恢复码无效'});return;}owners.set(recovered,Date.now()+30*24*3600000);await store!.rememberOwner(recovered,Date.now()+30*24*3600000);res.setHeader('Set-Cookie',`rd_owner=${recovered}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);reply(res,200,{ok:true});return;}
    if(path==='/api/saved-browsers'&&req.method==='POST'){
      const request=await body(req);const saved=typeof request.id==='string'?store?.read(owner,request.id):undefined;if(!saved){reply(res,404,{error:'保存的环境不存在'});return;}
      if(request.action==='forget'){const active=sessions.get(saved.id);if(active){active.disablePersistence();sessions.delete(active.id);await active.close();}await store!.forget(owner,saved.id);reply(res,200,{ok:true});return;}
      await policy.assert(saved.url);
      if(!store!.read(owner,saved.id)){reply(res,404,{error:'保存的环境已清除'});return;}
      if(sessions.has(saved.id)){reply(res,200,sessions.get(saved.id)!.summary());return;}
      if(sessions.size>=config.maxSessions||[...sessions.values()].filter(s=>s.owner===owner).length>=2){reply(res,429,{error:'请先结束现有会话'});return;}
      const session=new RemoteSession(owner,config,policy,deviceProfile,store,saved.state,saved.id);sessions.set(session.id,session);
      try{await session.start(saved.url);reply(res,201,session.summary());}catch{sessions.delete(session.id);await session.close(true);reply(res,503,{error:'保存的环境暂时无法启动'});}return;
    }
    if(path==='/api/sessions'&&req.method==='POST'){
      const request=await body(req);const url=typeof request.url==='string'?request.url:fixture.origin;
      const size=request.viewport as {width?:number;height?:number}|undefined;
      const viewport=size&&Number.isFinite(size.width)&&Number.isFinite(size.height)?{width:Math.max(160,Math.min(3840,Math.round(size.width!))),height:Math.max(160,Math.min(2160,Math.round(size.height!)))}:undefined;
      await policy.assert(url);
      if(sessions.size>=config.maxSessions||[...sessions.values()].filter(s=>s.owner===owner).length>=2){reply(res,429,{error:'会话数量已达上限，请先结束现有会话'});return;}
      pending++;pendingOwners.set(owner,(pendingOwners.get(owner)??0)+1);
      const session=new RemoteSession(owner,config,policy,deviceProfile,store);
      sessions.set(session.id,session);
      try{await session.start(url,viewport);reply(res,201,session.summary());}
      catch(error){sessions.delete(session.id);await session.close(true);console.error('Browser startup failed:',error instanceof Error?error.name:'unknown');reply(res,503,{error:'浏览器未能安全启动或目标无法加载。请检查沙箱运行环境与目标网络。'});}
      finally{pending--;pendingOwners.set(owner,(pendingOwners.get(owner)??1)-1);}
      return;
    }
    const match=path.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(navigate|navigation|assets|updates|events|windows|uploads|downloads)(?:\/([a-f0-9-]+))?)?$/);
    if(match){
      const session=sessions.get(match[1]);if(!session||session.owner!==owner){reply(res,404,{error:'会话不存在'});return;}
      session.lastActivity=Date.now();
      if(!match[2]&&req.method==='DELETE'){await session.close();sessions.delete(session.id);reply(res,200,{ok:true});return;}
      if(!match[2]&&req.method==='GET'){reply(res,200,session.summary());return;}
      if(match[2]==='windows'&&req.method==='POST'){const request=await body(req);if(request.action==='close')await session.closeWindow();else if(typeof request.id==='string')await session.selectWindow(request.id);else throw new Error('缺少窗口编号');reply(res,200,{ok:true});return;}
      if(match[2]==='uploads'&&req.method==='POST'){reply(res,200,await session.upload(await body(req,65000)),/\bgzip\b/.test(req.headers['accept-encoding']??''));return;}
      if(match[2]==='downloads'&&req.method==='GET'){
        const file=session.downloads.get(match[3]);if(!file){reply(res,404,{error:'文件不存在'});return;}
        res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.end(file.body);return;
      }
      if(match[2]==='updates'&&req.method==='GET'){
        session.view();
        const params=new URL(req.url!,origin).searchParams;
        const change=session.changes(params.get('epoch')??'',Number(params.get('since')??-1));
        if(!change||params.get('control')==='1'&&(change.type==='snapshot'||change.type==='patch')){res.writeHead(204);res.end();}else reply(res,200,change,/\bgzip\b/.test(req.headers['accept-encoding']??''));return;
      }
      if(match[2]==='events'&&req.method==='POST'){
        const request=await body(req,64000);
        if(typeof request.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(request.clientId))throw new Error('无效连接标识');
        if(request.sync){
          const sync=request.sync as {epoch?:string;seq?:number};
          const events=Array.isArray(request.events)?request.events:[request.event];
          if(!events.length||events.length>16||typeof sync.epoch!=='string'||sync.epoch.length>100||!Number.isSafeInteger(sync.seq)||sync.seq!< -1)throw new Error('无效输入批次');
          const start=performance.now(),replies=[];
          for(const event of events)replies.push(await session.submit(event as UserEvent,request.clientId,false));
          const applied=performance.now();await session.syncAfterInput();
          reply(res,200,{type:'event-result',replies,update:session.changes(sync.epoch,sync.seq!),timing:{executeMs:Math.round(applied-start),syncMs:Math.round(performance.now()-applied)}},/\bgzip\b/.test(req.headers['accept-encoding']??''));return;
        }
        reply(res,200,await session.submit(request.event as UserEvent,request.clientId));return;
      }
      if(match[2]==='navigate'&&req.method==='POST'){const request=await body(req);if(typeof request.url!=='string')throw new Error('缺少目标地址');await session.navigate(request.url);reply(res,200,session.summary());return;}
      if(match[2]==='navigation'&&req.method==='POST'){const request=await body(req);if(!['back','forward','reload'].includes(String(request.action)))throw new Error('无效导航');await session.navigation(request.action as 'back'|'forward'|'reload');reply(res,200,{ok:true});return;}
      if(match[2]==='assets'&&req.method==='GET'){
        let asset;try{asset=await session.getAsset(match[3]);}catch{reply(res,503,{error:'资源暂时不可用，请重试'});return;}if(!asset){reply(res,404,{error:'资源不存在'});return;}
        res.setHeader('Content-Type',asset.mime);res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.end(asset.body);return;
      }
    }
    reply(res,404,{error:'接口不存在'});
  })().catch(error=>{if(!res.headersSent)reply(res,400,{error:error instanceof Error&&error.message.length<150?error.message:'请求无法处理'});else res.end();});};
  if(running){clearInterval(running.cleanup);server.removeAllListeners('request');server.removeAllListeners('upgrade');running.wss.close();}
  server.on('request',requestHandler);
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,zlibDeflateOptions:{level:1},concurrencyLimit:4}});
  server.on('upgrade',(req,socket,head)=>{
    const path=new URL(req.url??'/',origin).pathname;const match=path.match(/^\/api\/sessions\/([a-f0-9-]+)\/stream$/);
    const owner=ownerFor(req);const session=match?sessions.get(match[1]):undefined;
    if(!owner||!session||session.owner!==owner||req.headers.origin!==origin||session.sockets.size>=2){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{ws.on('error',()=>{});session.attach(ws);});
  });
  if(!running)await new Promise<void>(resolve=>server.listen(config.port,config.host,resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Listener failed');origin=`http://127.0.0.1:${address.port}`;
  const cleanup=setInterval(()=>{
    for(const [owner,expires]of owners)if(expires<Date.now())owners.delete(owner);
    for(const [id,session]of sessions)if(Date.now()-session.lastActivity>config.idleMs||!owners.has(session.owner)){void session.close().then(()=>{if(sessions.get(id)===session)sessions.delete(id);}).catch(()=>{});}
  },15000);cleanup.unref();
  async function close(){clearInterval(cleanup);await Promise.all([...sessions.values()].map(s=>s.close(true)));sessions.clear();wss.close();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>fixture.server.close(()=>resolve()))]);}
  const runtime:RunningAppState={config,sessions,owners,fixture,origin,server,cleanup,wss,deviceProfile,containerEnvironment,store};
  return {origin,fixtureOrigin:fixture.origin,close,sessions,server,deviceProfile,runtime};
}

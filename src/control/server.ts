import {createServer,request,Agent,type IncomingMessage,type ServerResponse,type IncomingHttpHeaders} from 'node:http';
import type {Duplex} from 'node:stream';
import {timingSafeEqual} from 'node:crypto';
import {AccountStore,publicAccount,type Account} from './accounts.js';
import type {WorkerPool} from './workers.js';
import {testProxy} from './proxy-test.js';
import type {EgressStore} from './egress-store.js';

interface Options {store:AccountStore;workers:WorkerPool;egress?:EgressStore;publicOrigin?:string;host?:string;port?:number;html:string;script:string}
const hop=new Set(['connection','upgrade','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','forwarded','x-forwarded-host','x-forwarded-proto','x-forwarded-for','x-real-ip']);
function clean(headers:IncomingHttpHeaders){const blocked=new Set([...hop,...String(headers.connection??'').toLowerCase().split(',').map(s=>s.trim())]);return Object.fromEntries(Object.entries(headers).filter(([name])=>!blocked.has(name)));}
function reply(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let length=0;for await(const c of req){length+=c.length;if(length>16000)throw new Error('请求过大');chunks.push(c);}const b=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!b||Array.isArray(b)||typeof b!=='object')throw new Error('无效请求');return b as Record<string,unknown>;}
export async function createControl(options:Options){
 const {store,workers}=options;let origin=options.publicOrigin??'';const host=options.host??'127.0.0.1';if(!origin&&!['127.0.0.1','localhost'].includes(host))throw new Error('Public origin is required');if(origin){const u=new URL(origin);if(u.origin!==origin||u.username||u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('HTTPS public origin required');}
 const cookieName=()=>origin.startsWith('https:')?'__Host-rd_account':'rd_account';
 const tokenFor=(req:IncomingMessage)=>(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName()+'='))?.slice(cookieName().length+1);
 const cookie=(token:string,maxAge=7*86400)=>`${cookieName()}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${origin.startsWith('https:')?'; Secure':''}`;
 const sockets=new Map<Duplex,{accountId:string;token:string}>(),agent=new Agent({keepAlive:true,maxSockets:64,maxFreeSockets:8});
 const revoke=(id:string,token?:string)=>{for(const [socket,auth] of sockets)if(auth.accountId===id&&(!token||auth.token===token))socket.destroy();};
 const rates=new Map<string,{count:number;until:number}>();
 const allowLogin=(req:IncomingMessage,username:string)=>{for(const [key,v] of rates)if(v.until<Date.now())rates.delete(key);const keys=['account:'+username.slice(0,40),'ip:'+(req.socket.remoteAddress??'local')];if(rates.size>1000)return false;if(keys.some(key=>(rates.get(key)?.count??0)>=12))return false;for(const key of keys){const v=rates.get(key)??{count:0,until:Date.now()+300000};v.count++;rates.set(key,v);}return true;};
 const proxyTests=new Set<string>();let activeProxyTests=0;
 const registrations=new Map<string,{count:number;until:number}>();
 const allowRegistration=(req:IncomingMessage)=>{for(const [key,value] of registrations)if(value.until<Date.now())registrations.delete(key);const key=req.socket.remoteAddress??'local',value=registrations.get(key)??{count:0,until:Date.now()+600000};if(registrations.size>=1000||value.count>=10)return false;value.count++;registrations.set(key,value);return true;};
 const parse=(req:IncomingMessage)=>{const url=new URL(req.url??'/',origin);if(req.headers.host!==new URL(origin).host||url.origin!==origin)throw new Error('Invalid host');return url;};
 const csrf=(req:IncomingMessage,token:string)=>{const v=req.headers['x-csrf-token'];const expected=store.csrf(token);return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&timingSafeEqual(Buffer.from(v),Buffer.from(expected));};
 const headersFor=(req:IncomingMessage,account:Account,upstream:URL,ws=false)=>{const h=clean(req.headers);h.host=`127.0.0.1:${upstream.port||80}`;h.cookie=`rd_owner=${account.workerOwner}`;if(req.headers.origin===origin)h.origin=`http://${h.host}`;if(ws){h.connection='Upgrade';h.upgrade='websocket';}return h;};
 const handler=(req:IncomingMessage,res:ServerResponse)=>{void(async()=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
   let url:URL;try{url=parse(req);}catch{reply(res,403,{error:'请求来源不匹配'});return;}const path=url.pathname,token=tokenFor(req),account=store.authenticate(token);
   if(!['GET','POST','DELETE','HEAD'].includes(req.method??'')||!['GET','HEAD'].includes(req.method??'')&&req.headers.origin!==origin){reply(res,403,{error:'请求来源不匹配'});return;}
   if(path==='/account/app.js'&&req.method==='GET'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(options.script);return;}
   if(path==='/account'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");res.end(options.html);return;}
   if(path==='/account/api/login'&&req.method==='POST'){const b=await body(req);const username=typeof b.username==='string'?b.username:'',password=typeof b.password==='string'?b.password:'';if(!allowLogin(req,username)){reply(res,429,{error:'登录尝试过多，请五分钟后重试'});return;}const next=await store.login(username,password);if(!next){reply(res,401,{error:'用户名或密码不正确，或账号已停用'});return;}res.setHeader('Set-Cookie',cookie(next));reply(res,200,{ok:true});return;}
   if(path==='/account/api/register'&&req.method==='POST'){
     if(!allowRegistration(req)){reply(res,429,{error:'注册尝试过多，请十分钟后重试'});return;}
     const b=await body(req);if(typeof b.username!=='string'||typeof b.password!=='string'||b.confirmPassword!==b.password){reply(res,400,{error:'请填写用户名，并确保两次密码一致'});return;}
     try{const created=await store.create(b.username,b.password,'user');reply(res,201,{account:created});}catch(error){reply(res,400,{error:error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'注册暂不可用，请稍后重试'});}return;
   }
   if(!account||!token){if(req.method==='GET'&&!path.startsWith('/api/')&&!path.startsWith('/account/api/')){res.writeHead(303,{Location:'/account'});res.end();}else reply(res,401,{error:'请先登录账号'});return;}
   if(path.startsWith('/account/api/')){
     if(req.method!=='GET'&&!csrf(req,token)){reply(res,403,{error:'操作凭证不匹配，请刷新页面'});return;}
     if(path==='/account/api/me'&&req.method==='GET'){reply(res,200,{account:publicAccount(account),csrf:store.csrf(token)});return;}
     if(path==='/account/api/logout'&&req.method==='POST'){await store.logout(token);revoke(account.id,token);res.setHeader('Set-Cookie',cookie('',0));reply(res,200,{ok:true});return;}
     if(path==='/account/api/password'&&req.method==='POST'){const b=await body(req);if(typeof b.currentPassword!=='string'||typeof b.password!=='string'||!await store.checkPassword(account.id,b.currentPassword)){reply(res,400,{error:'当前密码不正确'});return;}await store.update(account.id,undefined,b.password);revoke(account.id);res.setHeader('Set-Cookie',cookie('',0));reply(res,200,{ok:true});return;}
     if(path==='/account/api/my-egress/test'&&req.method==='POST'&&options.egress){
       const b=await body(req);
       if(b.mode!=='custom'||typeof b.server!=='string'||b.username!==undefined&&typeof b.username!=='string'||b.password!==undefined&&typeof b.password!=='string'||b.clearCredentials!==undefined&&typeof b.clearCredentials!=='boolean'){reply(res,400,{error:'请填写个人代理地址后再测试'});return;}
       if(proxyTests.has(account.id)||activeProxyTests>=4){reply(res,429,{error:'代理测试正在进行，请稍后重试'});return;}
       proxyTests.add(account.id);activeProxyTests++;
       try{const profile=options.egress.testProfile(account.id,{server:b.server,username:b.username as string|undefined,password:b.password as string|undefined,clearCredentials:b.clearCredentials as boolean|undefined});reply(res,200,await testProxy(profile));}
       catch(error){reply(res,400,{error:error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'代理测试失败，请稍后重试'});}
       finally{proxyTests.delete(account.id);activeProxyTests--;}return;
     }
     if(path==='/account/api/my-egress'&&options.egress){
       if(req.method==='GET'){reply(res,200,options.egress.personal(account.id));return;}
       if(req.method==='POST'){
         const b=await body(req);
         if(b.mode==='default'){if(!workers.switchEgress)throw new Error('未配置出口管理');await workers.switchEgress(account.id,'default');}
         else if(b.mode==='custom'){
           if(typeof b.server!=='string'||b.username!==undefined&&typeof b.username!=='string'||b.password!==undefined&&typeof b.password!=='string'||b.clearCredentials!==undefined&&typeof b.clearCredentials!=='boolean'||!workers.configureOwnEgress)throw new Error('代理参数不正确');
           await workers.configureOwnEgress(account.id,{server:b.server,username:b.username as string|undefined,password:b.password as string|undefined,clearCredentials:b.clearCredentials as boolean|undefined});
         }else{reply(res,400,{error:'请选择个人代理或默认出口'});return;}
         revoke(account.id);reply(res,200,options.egress.personal(account.id));return;
       }
     }
     if(account.role!=='admin'){reply(res,403,{error:'需要管理员权限'});return;}
     const egress=options.egress;
     if(path==='/account/api/egress'&&req.method==='GET'&&egress){reply(res,200,egress.snapshot());return;}
     if(path==='/account/api/egress'&&req.method==='POST'&&egress){const b=await body(req);if(typeof b.name!=='string'||typeof b.server!=='string'||b.username!==undefined&&typeof b.username!=='string'||b.password!==undefined&&typeof b.password!=='string')throw new Error('代理参数不正确');const profile=await egress.add({name:b.name,server:b.server,username:b.username as string|undefined,password:b.password as string|undefined,maxAccounts:Number(b.maxAccounts??1)});reply(res,201,{profile});return;}
     if(path==='/account/api/egress/default'&&req.method==='POST'&&egress){const b=await body(req);if(typeof b.selection!=='string')throw new Error('出口参数不正确');await egress.setDefault(b.selection);reply(res,200,{ok:true});return;}
     const route=path.match(/^\/account\/api\/accounts\/([a-f0-9-]{36})\/egress$/);if(route&&req.method==='POST'&&egress){const b=await body(req);if(!store.get(route[1])||typeof b.selection!=='string'||!workers.switchEgress)throw new Error('账号或出口参数不正确');revoke(route[1]);await workers.switchEgress(route[1],b.selection);reply(res,200,{ok:true});return;}
     const proxy=path.match(/^\/account\/api\/egress\/([a-f0-9-]{36})$/);if(proxy&&req.method==='POST'&&egress){const b=await body(req);if(typeof b.enabled!=='boolean')throw new Error('代理状态不正确');await egress.setEnabled(proxy[1],b.enabled);if(!b.enabled)for(const id of egress.affected(proxy[1])){revoke(id);await workers.stop(id);}reply(res,200,{ok:true});return;}
     if(path==='/account/api/accounts'&&req.method==='GET'){reply(res,200,{accounts:store.list(),workers:await workers.status()});return;}
     if(path==='/account/api/accounts'&&req.method==='POST'){const b=await body(req);if(typeof b.username!=='string'||typeof b.password!=='string'||b.role!==undefined&&!['admin','user'].includes(String(b.role)))throw new Error('账号参数不正确');reply(res,201,{account:await store.create(b.username,b.password,b.role as 'admin'|'user'|undefined)});return;}
     const match=path.match(/^\/account\/api\/accounts\/([a-f0-9-]{36})$/);if(match&&req.method==='POST'){const b=await body(req);if(b.disabled===undefined&&b.password===undefined)throw new Error('请选择停用、启用或重置密码');if(b.disabled!==undefined&&typeof b.disabled!=='boolean'||b.password!==undefined&&typeof b.password!=='string')throw new Error('账号参数不正确');const changed=await store.update(match[1],b.disabled as boolean|undefined,b.password as string|undefined);revoke(match[1]);if(changed.disabled)await workers.stop(match[1]);reply(res,200,{account:changed});return;}
     reply(res,404,{error:'接口不存在'});return;
   }
   // Account identity is authoritative; visitor recovery codes cannot switch tenants.
   if(path==='/api/recovery'){reply(res,404,{error:'账号模式下请使用账号恢复浏览器环境'});return;}
   if(Number(req.headers['content-length']??0)>96000){reply(res,413,{error:'请求过大'});return;}
   let worker;try{worker=await workers.ensure(account);}catch(error){if(path==='/'&&req.method==='GET'){const message=error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'浏览器暂时无法启动，请稍后重试';res.writeHead(303,{Location:'/account?browserError='+encodeURIComponent(message)+'#home'});res.end();return;}throw error;}if(!store.authenticate(token)){reply(res,401,{error:'登录已失效'});return;}const upstream=new URL(worker.upstream),release=workers.lease(account.id);
   const outgoing=request({hostname:upstream.hostname,port:upstream.port,path:url.pathname+url.search,method:req.method,headers:headersFor(req,account,upstream),agent,timeout:30000},response=>{const h=clean(response.headers);delete h['set-cookie'];response.on('error',()=>res.destroy());if(path==='/'&&req.method==='GET'&&response.statusCode===200){delete h['content-length'];const chunks:Buffer[]=[];let bytes=0;response.on('data',c=>{bytes+=c.length;if(bytes>256000){outgoing.destroy();res.destroy();return;}chunks.push(c);});response.on('end',()=>{res.writeHead(200,h);res.end(Buffer.concat(chunks).toString().replace('</body>','<script src="/account/app.js" defer></script></body>'));});}else{res.writeHead(response.statusCode??502,h);response.pipe(res);}});
   let count=0;req.on('data',chunk=>{count+=chunk.length;if(count>96000){outgoing.destroy();if(!res.headersSent)reply(res,413,{error:'请求过大'});}});req.on('aborted',()=>outgoing.destroy());outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)reply(res,502,{error:'浏览器容器暂不可用，请刷新重试'});else res.destroy();});res.once('close',()=>{release();if(!res.writableFinished)outgoing.destroy();});req.pipe(outgoing);
 })().catch(error=>{if(!res.headersSent)reply(res,503,{error:error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'服务暂不可用，请稍后重试'});else res.destroy();});};
 const server=createServer(handler);server.requestTimeout=30000;server.headersTimeout=15000;
 server.on('upgrade',(req,client,head)=>{void(async()=>{
   const reject=(code=403)=>client.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);let url:URL;try{url=parse(req);}catch{reject();return;}const token=tokenFor(req),account=store.authenticate(token);if(!account||!token||req.headers.origin!==origin||!/^\/api\/sessions\/[a-f0-9-]{36}\/stream$/.test(url.pathname)||url.search||req.headers.upgrade?.toLowerCase()!=='websocket'){reject();return;}
   client.on('error',()=>client.destroy());const worker=await workers.ensure(account);if(client.destroyed||!store.authenticate(token)){client.destroy();return;}const upstream=new URL(worker.upstream),release=workers.lease(account.id);sockets.set(client,{accountId:account.id,token});client.once('close',()=>{sockets.delete(client);release();});client.on('data',()=>workers.touch(account.id));
   const outgoing=request({hostname:upstream.hostname,port:upstream.port,path:url.pathname,method:'GET',headers:headersFor(req,account,upstream,true),agent:false,timeout:8000});client.once('close',()=>outgoing.destroy());
   outgoing.once('upgrade',(response,backend,backendHead)=>{if(client.destroyed||!store.authenticate(token)){backend.destroy();client.destroy();return;}backend.setTimeout(0);backend.on('error',()=>backend.destroy());backend.once('close',()=>client.destroy());client.once('close',()=>backend.destroy());const h=response.rawHeaders.reduce((lines,value,i)=>i%2?lines:lines+`${value}: ${response.rawHeaders[i+1]}\r\n`,'');client.write(`HTTP/1.1 101 Switching Protocols\r\n${h}\r\n`);if(backendHead.length)client.write(backendHead);if(head.length)backend.write(head);client.pipe(backend);backend.pipe(client);});outgoing.once('response',response=>{response.resume();reject(response.statusCode??502);});outgoing.once('timeout',()=>outgoing.destroy());outgoing.once('error',()=>reject(502));outgoing.end();
 })().catch(()=>client.destroy());});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,host,resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('Account listener unavailable');if(!origin)origin=`http://127.0.0.1:${address.port}`;
 const watchdog=setInterval(()=>{for(const [socket,auth] of sockets)if(!store.authenticate(auth.token))socket.destroy();},30000);watchdog.unref();
 return {origin,server,close:async()=>{clearInterval(watchdog);for(const s of sockets.keys())s.destroy();agent.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await workers.close();}};
}

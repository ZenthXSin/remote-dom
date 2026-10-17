import {RemoteKeyboardInput} from './keyboard-input.js';
import {RemotePointerInput} from './pointer-input.js';
import {watchNetworkDiagnostics} from './network-diagnostics.js';
import {Diagnostics,diagnosticTarget,diagnosticCookies,diagnosticSetCookies} from './diagnostics.js';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,devices,type Browser,type BrowserContext,type Page,type CDPSession,type Dialog} from 'playwright-core';
import {WebSocket} from 'ws';
import type {Config} from './config.js';
import {TargetPolicy} from './policy.js';
import {sanitizeDocument} from './sanitize.js';
import {snapshot,diff,advanceSnapshot} from './diff.js';
import type {CapturedDocument,Snapshot,UserEvent,ServerMessage,BrowserDialogMessage} from '../shared/protocol.js';
import type {DeviceProfile} from './device-profile.js';
import {FrameCapture,type CaptureFrame} from './frame-capture.js';
import {fontsFromCss,type RemoteFont} from './fonts.js';
import {Uploads,type PendingFilePicker} from './uploads.js';
import type {BrowserStore,LoginState} from './browser-store.js';
import {proxyHostResolverRules} from './browser-network.js';
import {createBrowserProxy} from './browser-proxy.js';
import {monitorSocket} from './socket-health.js';
import {AssetTransit} from './asset-transit.js';
import {ClaudeLoginError,importClaudeSession} from './claude-login.js';
import {deviceEmulation} from './device-emulation.js';
import {isDevicePreset,type DevicePreset} from '../shared/device-presets.js';
import {ASSET_MIMES,MAX_ASSET_BYTES,fetchAsset,type AssetBody,type AssetSource} from './asset-source.js';

// Complex pages can legitimately exceed 4 MiB in computed styles alone.
const MAX_SNAPSHOT_BYTES=16*1024*1024;
const MAX_STREAM_BUFFER_BYTES=2*MAX_SNAPSHOT_BYTES;

export class RemoteSession {
  readonly diagnostics=new Diagnostics(()=>{for(const window of this.windows.values())void window.cdp.send('Network.disable').catch(()=>{});});
  readonly id=randomUUID(); readonly created=Date.now(); lastActivity=Date.now();
  browser!:Browser; context!:BrowserContext; page!:Page; cdp!:CDPSession;
  private renderFlow=new WeakMap<WebSocket,{enabled:boolean;limit:number;waiting:{epoch:string;seq:number}[];last?:Snapshot}>();
  sockets=new Set<WebSocket>(); assets=new Map<string,AssetSource>();
  private assetByUrl=new Map<string,string>(); private assetRevision=0;private inlineTransit=new AssetTransit();private inlineIds:string[]=[];private assetLoads=new Map<string,Promise<AssetBody>>();
  private fontRules=new Map<string,RemoteFont[]>();
  private svgSources=new Map<string,string>();private svgBytes=0;
  private windows=new Map<string,{page:Page;cdp:CDPSession;capture:FrameCapture;title:string}>();
  private activeWindow='';private viewport={width:1100,height:760};private switching=Promise.resolve();
  private picker?:PendingFilePicker;private uploads=new Uploads();
  downloads=new Map<string,{name:string;body:Buffer}>();private downloading=0;private downloadBytes=0;
  current?:Snapshot; private epoch=randomUUID(); private capture!:FrameCapture;
  private timer?:NodeJS.Timeout; private closed=false; private captureSource='';
  private lastError=''; private inputQueue=Promise.resolve(); private queued=0;
  private events=new Map<string,number>(); private history=new Map<number,Snapshot>();
  private inputRevision=0;
  private pointer=new RemotePointerInput(peer=>this.releaseInputs(peer,'pointer'));
  private keyboard=new RemoteKeyboardInput(peer=>this.releaseInputs(peer,'keyboard'));
  private releaseInputs(peer?:string,kind:'pointer'|'keyboard'|'all'='all'){this.inputQueue=this.inputQueue.then(async()=>{if(kind!=='keyboard')await this.pointer.cancel(peer);if(kind!=='pointer')await this.keyboard.cancel(peer);}).catch(()=>{});}
  private pendingDialog?:{dialog:Dialog;info:BrowserDialogMessage};
  private requestedUrl='';
  private networkGuard?:Awaited<ReturnType<typeof createBrowserProxy>>;
  private saveTimer?:NodeJS.Timeout;
  private saveTask?:Promise<void>;
  private claudeLoginBusy=false;
  private deviceSwitchBusy=false;
  private persistenceError='';
  private pollTask?:Promise<void>;
  private lastViewActivity=0;private capturedAssetState='';
  constructor(readonly owner:string,readonly config:Config,readonly policy:TargetPolicy,readonly deviceProfile:DeviceProfile,private store?:BrowserStore,private restoredState?:LoginState,restoredId?:string,private devicePreset:DevicePreset='default'){if(restoredId)(this as {id:string}).id=restoredId;if(!isDevicePreset(devicePreset))throw new Error('无效设备类型');}
  async start(url:string,viewport={width:1100,height:760}) {
    this.requestedUrl=url;
    viewport=this.deviceProfile.platform==='Android'?{...devices['Pixel 7'].viewport}:viewport;
    this.viewport={...viewport};
    await this.policy.assert(url);
    if(this.closed)throw new Error('Session cancelled');
    this.captureSource=await readFile(join(this.config.assetDir,'capture.js'),'utf8');
    this.networkGuard=this.config.proxy&&!this.config.managedEgress?await createBrowserProxy(this.config.proxy,this.policy):undefined;
    const nativeNetwork=this.config.managedEgress||!!this.networkGuard;
    const upstream=this.networkGuard?{server:this.networkGuard.origin}:this.config.proxy;
    // Chromium otherwise bypasses proxies implicitly for all loopback targets.
    // Only the exact built-in fixture port may bypass the policy proxy.
    const proxy=upstream?{...upstream,bypass:['<-loopback>',...[this.policy.fixtureOrigin,...this.policy.fixtureAliases].map(origin=>new URL(origin).host)].join(',')}:undefined;
    // Explicitly enable Chromium's sandbox. There is no --no-sandbox fallback.
    this.browser=await chromium.launch({executablePath:this.config.chromiumPath,headless:this.config.headless,chromiumSandbox:true,
      proxy,args:['--disable-gpu','--disable-back-forward-cache','--renderer-process-limit=2','--js-flags=--optimize-for-size','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking',
        ...(proxy?[`--host-resolver-rules=${proxyHostResolverRules(proxy.server,[this.policy.fixtureOrigin,...this.policy.fixtureAliases])}`]:[])]});
    if(this.closed){await this.browser.close();throw new Error('Session cancelled');}
    const p=this.deviceProfile;
    this.context=await this.browser.newContext({...(p.platform==='Android'?{...devices['Pixel 7'],userAgent:devices['Pixel 7'].userAgent.replace(/Chrome\/[\d.]+/,`Chrome/${this.browser.version()}`)}:{}),proxy,viewport,screen:{...p.screen},deviceScaleFactor:p.deviceScaleFactor,
      locale:p.locale,timezoneId:p.timezoneId,colorScheme:p.colorScheme,isMobile:p.isMobile,hasTouch:p.hasTouch,
      serviceWorkers:nativeNetwork?'allow':'block',acceptDownloads:true,permissions:['clipboard-write'],storageState:this.restoredState});
    if(!nativeNetwork){await this.context.route('**/*',async route=>{
      try{await this.policy.assert(route.request().url());await route.continue();}catch(error){this.diagnostics.add('policy-block',{...diagnosticTarget(route.request().url()),reason:error instanceof Error&&error.message.includes('DNS')?'dns-validation-failed':'target-not-allowed'});await route.abort('blockedbyclient').catch(()=>{});}
    });
    await this.context.routeWebSocket(/.*/,async socket=>{
      try{const url=new URL(socket.url());if(!['ws:','wss:'].includes(url.protocol))throw new Error('Invalid socket scheme');url.protocol=url.protocol==='wss:'?'https:':'http:';await this.policy.assert(url.href);socket.connectToServer();}
      catch{socket.close({code:1008,reason:'Target socket is not allowed'});}
    });}
    this.context.on('response',response=>{void(async()=>{
      const mime=(response.headers()['content-type']??'').split(';')[0];
      if(!ASSET_MIMES.has(mime)&&mime!=='image/svg+xml'&&mime!=='text/css')return;
      const length=Number(response.headers()['content-length']??0);if(length>MAX_ASSET_BYTES)return;
      if(ASSET_MIMES.has(mime)){
        if(this.closed||this.assets.size>=2048&&!this.assetByUrl.has(response.url())||response.url().length>8192)return;
        const headers:Record<string,string>={};const original=await response.request().allHeaders();
        for(const key of ['accept','authorization','referer','origin','user-agent'])if(original[key])headers[key]=original[key];
        const previous=this.assetByUrl.get(response.url());if(previous)this.assets.delete(previous);
        const id=randomUUID();this.assets.set(id,{url:response.url(),mime,method:response.request().method(),headers});this.assetByUrl.set(response.url(),id);this.assetRevision++;return;
      }
      // CSS is parsed into font rules; SVG is parsed into sanitized DOM. Neither
      // is a binary resource served from the user-facing asset endpoint.
      const body=await response.body();if(this.closed||body.length>MAX_ASSET_BYTES)return;
      if(mime==='image/svg+xml'){if(this.svgSources.size<32&&this.svgBytes+body.length<=4*1024*1024&&!this.svgSources.has(response.url())){this.svgSources.set(response.url(),body.toString());this.svgBytes+=body.length;}return;}
      if(this.fontRules.size<100)this.fontRules.set(response.url(),fontsFromCss(body.toString(),response.url()));
    })().catch(()=>{});});
    await this.registerWindow(await this.context.newPage());
    this.context.on('page',page=>{this.switching=this.switching.then(()=>this.registerWindow(page)).catch(()=>{void page.close();});});
    try{await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}catch(error){if(!this.pendingDialog)throw error;await this.page.waitForLoadState('domcontentloaded',{timeout:0});}
    await this.poll();
    this.schedule();
    if(this.store){this.saveTimer=setInterval(()=>{void this.saveState().catch(()=>{});},10000);this.saveTimer.unref();await this.saveState();}
  }
  private async registerWindow(page:Page){
    if(this.closed||this.windows.size>=3){await page.close();return;}
    const id=randomUUID();const cdp=await this.context.newCDPSession(page);
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    if(this.devicePreset!=='default')await this.emulateDevice(cdp,this.devicePreset);
    const capture=new FrameCapture(page,cdp,this.captureSource,this.svgSources);
    this.windows.set(id,{page,cdp,capture,title:''});
    this.watchDialogs(page);
    watchNetworkDiagnostics(cdp,this.diagnostics,id);
    if(this.diagnostics.active)await cdp.send('Network.enable');
    const requestIds=new WeakMap<object,{id:number;at:number}>();let requestCounter=0;
    page.on('request',request=>{if(!this.diagnostics.active)return;const info={id:++requestCounter,at:performance.now()};requestIds.set(request,info);this.diagnostics.add('request',{window:id,request:info.id,method:request.method(),resource:request.resourceType(),...diagnosticTarget(request.url()),redirect:!!request.redirectedFrom()});void request.allHeaders().then(headers=>this.diagnostics.add('request-cookies',{source:'playwright-observed-not-authoritative',window:id,request:info.id,...diagnosticCookies(headers.cookie)})).catch(()=>{});});
    page.on('response',response=>{if(!this.diagnostics.active)return;const info=requestIds.get(response.request());const headers=response.headers();this.diagnostics.add('response',{window:id,request:info?.id,status:response.status(),ms:info?Math.round(performance.now()-info.at):undefined,...diagnosticTarget(response.url()),challenge:headers['cf-mitigated']==='challenge',ray:/^[a-zA-Z0-9-]{1,80}$/.test(headers['cf-ray']??'')?headers['cf-ray']:undefined});void response.headersArray().then(headers=>this.diagnostics.add('response-cookies',{window:id,request:info?.id,...diagnosticSetCookies(headers)})).catch(()=>{});});
    page.on('requestfailed',request=>{const info=requestIds.get(request);const failure=request.failure()?.errorText??'';this.diagnostics.add('request-failed',{window:id,request:info?.id,...diagnosticTarget(request.url()),reason:failure.match(/net::ERR_[A-Z_]+/)?.[0]??'failed'});});
    page.on('framenavigated',frame=>this.diagnostics.add('navigation',{window:id,main:frame===page.mainFrame(),...diagnosticTarget(frame.url())}));
    page.on('pageerror',()=>this.diagnostics.add('page-script-error',{window:id}));
    page.on('crash',()=>this.diagnostics.add('page-crash',{window:id}));
    page.on('filechooser',chooser=>{void(async()=>{this.uploads.clear();this.picker={id:randomUUID(),chooser,accept:(await chooser.element().getAttribute('accept'))?.slice(0,1024)??'',multiple:chooser.isMultiple()};})().catch(()=>{});});
    page.on('download',download=>{void(async()=>{
      if(this.downloading>=2||this.downloadBytes>=32*1024*1024){await download.cancel();return;}
      this.downloading++;
      try{const path=await download.path();if(!path)return;const size=(await stat(path)).size;if(size>16*1024*1024||this.downloadBytes+size>32*1024*1024)return;
        const body=await readFile(path);if(this.closed)return;this.downloads.set(randomUUID(),{name:download.suggestedFilename().replace(/[\\/\x00-\x1f]/g,'_').slice(0,200)||'download',body});this.downloadBytes+=body.length;
      }finally{this.downloading--;await download.delete().catch(()=>{});}
    })().catch(()=>{});});
    cdp.on('Page.frameNavigated',({frame})=>{if(!frame.parentId&&this.page===page){this.releaseInputs();this.epoch=randomUUID();this.current=undefined;this.history.clear();this.picker=undefined;this.uploads.clear();}});
    page.on('close',()=>{this.windows.delete(id);if(this.activeWindow===id&&!this.closed){const fallback=[...this.windows.keys()].at(-1);if(fallback)void this.selectWindow(fallback);}});
    await this.selectWindow(id);
  }
  async startDiagnostics(){
    this.diagnostics.start();
    await Promise.all([...this.windows.values()].map(async window=>{await window.cdp.send('Network.enable').catch(()=>{});}));
    const cookies=await this.context.cookies(this.page.url()).catch(()=>[]);
    this.diagnostics.add('cookie-baseline',{clearance:cookies.some(c=>c.name==='cf_clearance'),botManagement:cookies.some(c=>c.name==='__cf_bm')});
    this.diagnostics.add('environment',{proxyConfigured:!!this.config.proxy,platform:this.deviceProfile.platform,network:this.config.managedEgress?'managed-relay':this.networkGuard?'proxy-policy':'browser-routing'});
    return this.diagnostics.report();
  }
  async stopDiagnostics(){const report=this.diagnostics.stop();await Promise.all([...this.windows.values()].map(window=>window.cdp.send('Network.disable').catch(()=>{})));return report;}
  async selectWindow(id:string){
    const window=this.windows.get(id);if(!window||window.page.isClosed())throw new Error('窗口不存在');
    await this.pointer.cancel();await this.keyboard.cancel();
    this.page=window.page;this.cdp=window.cdp;this.capture=window.capture;this.activeWindow=id;
    this.epoch=randomUUID();this.current=undefined;this.history.clear();await this.metrics();await this.page.bringToFront();
    this.picker=undefined;this.uploads.clear();
  }
  async closeWindow(){if(this.windows.size<2)throw new Error('仅剩主窗口，请使用结束会话');await this.page.close();}
  private watchDialogs(page:Page){page.on('dialog',dialog=>{
    if(this.closed){void dialog.dismiss().catch(()=>{});return;}
    const origin=(()=>{try{return new URL(page.url()).origin;}catch{return '远端网页';}})();
    const info:BrowserDialogMessage={type:'dialog',epoch:this.epoch,id:randomUUID(),kind:dialog.type() as BrowserDialogMessage['kind'],message:dialog.message().slice(0,10000),defaultValue:dialog.defaultValue().slice(0,10000),origin};
    this.pendingDialog={dialog,info};this.broadcast(info);
  });}
  private get emulatedDevice(){return deviceEmulation(this.devicePreset??'default',this.deviceProfile,this.browser.version());}
  private async metrics(viewport=this.viewport,cdp=this.cdp,preset=this.devicePreset){
    const device=deviceEmulation(preset??'default',this.deviceProfile,this.browser.version());
    await cdp.send('Emulation.setDeviceMetricsOverride',{...viewport,screenWidth:device.screen.width,screenHeight:device.screen.height,
      deviceScaleFactor:device.deviceScaleFactor,mobile:device.isMobile,screenOrientation:{angle:0,type:device.isMobile?'portraitPrimary':'landscapePrimary'}});
  }
  private async emulateDevice(cdp:CDPSession,preset:DevicePreset){
    const device=deviceEmulation(preset,this.deviceProfile,this.browser.version());
    await cdp.send('Emulation.setUserAgentOverride',{userAgent:device.userAgent,platform:device.platform});
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:device.hasTouch,maxTouchPoints:device.hasTouch?5:1});
    await this.metrics(this.viewport,cdp,preset);
  }
  async switchDevice(preset:unknown){
    if(!isDevicePreset(preset))throw new Error('无效设备类型');
    if(this.closed||!this.page||this.page.isClosed())throw new Error('请先打开或恢复浏览器');
    if(this.deviceSwitchBusy||this.claudeLoginBusy)throw new Error('浏览器正在处理切换，请稍候');
    if(this.pendingDialog)throw new Error('请先处理网页提示框');
    const previous=this.devicePreset??'default';if(previous===preset)return {preset,reloaded:true,persistence:!!this.store};
    this.deviceSwitchBusy=true;
    try{
      await this.pointer.cancel();await this.keyboard.cancel();
      try{for(const window of this.windows.values())await this.emulateDevice(window.cdp,preset);}
      catch{for(const window of this.windows.values())await this.emulateDevice(window.cdp,previous).catch(()=>{});throw new Error('设备切换失败，请重试');}
      this.devicePreset=preset;
      let reloaded=true;try{await this.page.reload({waitUntil:'domcontentloaded',timeout:20000});}catch{reloaded=false;}
      await this.poll(true);await this.saveTask?.catch(()=>{});await this.saveState();
      return {preset,reloaded,persistence:!!this.store};
    }finally{this.deviceSwitchBusy=false;}
  }
  view(){const wasIdle=Date.now()-this.lastViewActivity>=2000;this.lastViewActivity=Date.now();if(wasIdle&&this.timer){clearTimeout(this.timer);this.schedule();}}
  private schedule(){if(!this.closed)this.timer=setTimeout(()=>{this.timer=undefined;void this.poll().finally(()=>this.schedule());},this.lastError?1500:this.sockets.size||Date.now()-this.lastViewActivity<2000?60:1500);}
  poll(force=false):Promise<void> {
    if(this.pollTask)return this.pollTask;
    const task=this.captureDocument(force);this.pollTask=task;
    void task.finally(()=>{if(this.pollTask===task)this.pollTask=undefined;});return task;
  }
  async syncAfterInput(){
    if(this.closed||this.pendingDialog)return;
    await this.poll(true);
    // A capture already in flight may predate the input. Never label that
    // document as acknowledging the newer revision.
    if(!this.closed&&!this.pendingDialog&&(!this.current||(this.current.inputRevision??-1)<this.inputRevision))await this.poll(true);
  }
  private async captureDocument(force=false) {
    if(this.closed)return;
    try {
      const assetState=`${this.assetRevision}:${this.fontRules.size}:${this.svgSources.size}:${this.persistenceError}`;
      if(!force&&this.current&&assetState===this.capturedAssetState&&!await this.capture.needsCapture())return;
      const epoch=this.epoch,revision=this.inputRevision,viewport={...this.viewport};
      const captureStart=performance.now();const raw=await this.capture.capture();this.diagnostics.add('capture',{ms:Math.round(performance.now()-captureStart)});if(epoch!==this.epoch)return;
      if(Buffer.byteLength(JSON.stringify(raw))>MAX_SNAPSHOT_BYTES)throw new Error('页面超过当前快照大小限制');
      const document=sanitizeDocument(raw,url=>this.resource(url));
      this.capturedAssetState=assetState;
      document.inputRevision=revision;document.viewport=viewport;document.devicePreset=this.devicePreset??'default';
      document.persistenceError=this.persistenceError||undefined;
      const active=this.windows.get(this.activeWindow);if(active)active.title=document.title;
      document.windows=[...this.windows].map(([id,w])=>({id,title:w.title||'新窗口',active:id===this.activeWindow}));
      document.filePicker=this.picker?{id:this.picker.id,accept:this.picker.accept,multiple:this.picker.multiple}:undefined;
      document.downloads=[...this.downloads].map(([id,file])=>({id,name:file.name,size:file.body.length}));
      document.fontFaces=[...this.fontRules.values()].flat().flatMap(font=>{
        const id=font.urls.map(url=>this.assetByUrl.get(url)).find(Boolean);return id?[{family:font.family,style:font.style,weight:font.weight,unicodeRange:font.unicodeRange,assetUrl:`asset:${id}`}]:[];
      }).slice(0,32);
      this.lastError='';
      if(!this.current){this.current=snapshot(document,this.epoch);this.broadcast(this.current);}
      else {const patch=diff(this.current,document);if(patch){this.history.set(this.current.seq,this.current);while(this.history.size>2)this.history.delete(this.history.keys().next().value!);this.current=advanceSnapshot(this.current,document,patch);this.broadcast(patch);}}
    }catch(error){
      if(this.closed)return;
      const message=error instanceof Error&&error.message.includes('快照')?error.message:'页面正在导航或捕获暂不可用';
      if(message!==this.lastError){this.lastError=message;this.broadcast({type:'error',message});}
    }
  }
  attach(socket:WebSocket) {
    this.diagnostics.add('stream-open');socket.once('close',(code)=>this.diagnostics.add('stream-close',{code}));
    monitorSocket(socket);this.renderFlow.set(socket,{enabled:false,limit:1,waiting:[]});
    this.view();
    this.lastActivity=Date.now();this.sockets.add(socket);const peer=randomUUID();this.events.set(peer,0);
    if(this.current)this.send(socket,this.current);
    if(this.pendingDialog)this.send(socket,this.pendingDialog.info);
    socket.on('close',()=>{this.sockets.delete(socket);this.events.delete(peer);this.releaseInputs(peer);});
    socket.on('message',data=>{
      let message:unknown;try{message=JSON.parse(data.toString());}catch{return socket.close(1008,'Invalid JSON');}
      if((message as {type?:string})?.type==='render-flow'){const flow=this.renderFlow.get(socket)!,limit=(message as {window?:number}).window;flow.enabled=true;flow.limit=Number.isInteger(limit)?Math.max(1,Math.min(3,limit!)):1;return;}
      if((message as {type?:string})?.type==='rendered'){
        const flow=this.renderFlow.get(socket)!,ack=message as {epoch?:string;seq?:number};
        const index=flow.waiting.findIndex(frame=>ack.epoch===frame.epoch&&ack.seq===frame.seq);
        if(flow.enabled&&index>=0){
          // The renderer may coalesce contiguous frames and acknowledge the last.
          flow.waiting.splice(0,index+1);
          if(this.current&&(flow.last?.epoch!==this.current.epoch||flow.last?.seq!==this.current.seq))this.send(socket,this.current);
        }return;
      }
      if((message as {type?:string})?.type==='resync'){const flow=this.renderFlow.get(socket)!;flow.waiting=[];flow.last=undefined;if(this.current)this.send(socket,this.current);return;}
      if((message as {type?:string})?.type==='ping'){this.lastActivity=Date.now();this.send(socket,{type:'pong'});return;}
      void this.submit(message as UserEvent,peer).then(response=>this.send(socket,response));
    });
  }
  changes(epoch:string,seq:number){
    if(this.pendingDialog)return this.pendingDialog.info;
    if(this.lastError)return {type:'error' as const,message:this.lastError};
    if(!this.current)return null;
    if(epoch!==this.current.epoch)return this.current;
    if(seq===this.current.seq)return null;
    const previous=this.history.get(seq);if(!previous||previous.epoch!==epoch)return this.current;
    const patch=diff(previous,this.current);return patch?{...patch,seq:this.current.seq}:null;
  }
  async submit(event:UserEvent,peer:string,captureAfter=true):Promise<ServerMessage>{
    if(!this.validEvent(event))return {type:'error',message:'无效的输入事件'};
    if(event.action==='dialog'){
      const pending=this.pendingDialog;if(!pending||pending.info.id!==event.dialogId||typeof event.accept!=='boolean')return {type:'error',message:'提示框已改变',eventId:event.eventId};
      try{if(event.accept)await pending.dialog.accept(event.value??'');else await pending.dialog.dismiss();if(this.pendingDialog===pending)this.pendingDialog=undefined;this.inputRevision++;return {type:'ack',eventId:event.eventId,inputRevision:this.inputRevision};}catch{return {type:'error',message:'提示框操作失败',eventId:event.eventId};}
    }
    if(event.epoch!==this.epoch)return {type:'error',message:'页面已改变，请等待重新同步',eventId:event.eventId};
    if(!this.events.has(peer)&&this.events.size>=8)return {type:'error',message:'输入连接数量已达上限',eventId:event.eventId};
    if(event.eventId<=(this.events.get(peer)??0)||this.queued>=80)return {type:'error',message:'事件过期或输入队列已满',eventId:event.eventId};
    this.events.set(peer,event.eventId);this.queued++;this.lastActivity=Date.now();
    this.view();
    let respond!:(value:ServerMessage)=>void;const result=new Promise<ServerMessage>(resolve=>respond=resolve);
    this.inputQueue=this.inputQueue.then(async()=>{
      try{if(this.closed||event.epoch!==this.epoch)throw new Error('stale');const clipboard=await this.applyEvent(event,peer);if(event.action!=='hover')this.inputRevision++;respond(typeof clipboard==='string'?{type:'clipboard',text:clipboard,eventId:event.eventId,inputRevision:this.inputRevision}:{type:'ack',eventId:event.eventId,inputRevision:this.inputRevision});}
      catch{respond({type:'error',message:'操作未完成，请重试',eventId:event.eventId});}
      finally{this.queued--;if(captureAfter&&!this.pendingDialog)void this.syncAfterInput().catch(()=>{});}
    });return result;
  }
  private validEvent(event:UserEvent):boolean {
    return !!event&&event.type==='event'&&Number.isSafeInteger(event.eventId)&&event.eventId>0&&typeof event.epoch==='string'
      &&['click','hover','focus','input','key','scroll','viewport','select','navigation','dialog','media','pointer'].includes(event.action)
      &&(event.nodeId===undefined||/^n\d+$/.test(event.nodeId))
      &&(event.keyPhase===undefined||['down','up','cancel'].includes(event.keyPhase))
      &&(event.nativePointer===undefined||typeof event.nativePointer==='boolean')
      &&[event.x,event.y,event.offsetX,event.offsetY,event.pressure,event.tiltX,event.tiltY].every(value=>value===undefined||typeof value==='number'&&Number.isFinite(value))
      &&(event.pressure===undefined||event.pressure>=0&&event.pressure<=1)
      &&[event.tiltX,event.tiltY].every(value=>value===undefined||value>=-90&&value<=90)
      &&(event.pointerType===undefined||['mouse','touch','pen'].includes(event.pointerType))
      &&(event.clickCount===undefined||Number.isInteger(event.clickCount)&&event.clickCount>=1&&event.clickCount<=3)
      &&(event.value===undefined||typeof event.value==='string'&&event.value.length<=10000);
  }
  private async evaluate(expression:string,frame?:CaptureFrame) {return this.capture.evaluate(frame??this.capture.main,expression);}
  private async applyEvent(event:UserEvent,peer:string) {
    if(event.action==='key'&&event.keyPhase==='cancel'){await this.keyboard.cancel(peer);return;}
    if(event.action==='navigation'){if(!['back','forward','reload'].includes(event.key??''))throw new Error('Invalid navigation');await this.navigation(event.key as 'back'|'forward'|'reload');return;}
    if(event.action==='viewport'){
      if(!Number.isFinite(event.width)||!Number.isFinite(event.height))throw new Error('Invalid viewport');
      // Playwright setViewportSize also replaces screen dimensions. Override only
      // the viewport through CDP so a window resize never changes device identity.
      const viewport={width:Math.max(160,Math.min(3840,Math.round(event.width!))),height:Math.max(160,Math.min(2160,Math.round(event.height!)))};
      if(this.deviceSwitchBusy)throw new Error('设备切换中，请稍候');
      await this.metrics(viewport);this.viewport=viewport;return;
    }
    if(event.action==='pointer'&&event.nativePointer){
      if(!['down','move','up','cancel'].includes(event.key??'')||!Number.isFinite(event.x)||!Number.isFinite(event.y))throw new Error('Invalid pointer');
      let position:{x:number;y:number}|undefined;
      if(event.key==='down'){
        if(!event.nodeId||!this.current?.nodes.some(n=>n.id===event.nodeId))throw new Error('Stale pointer target');
        const route=this.capture.route(event.nodeId);if(!route)throw new Error('Pointer frame unavailable');
        position=await this.capture.position(route,event.offsetX,event.offsetY);
      }
      await this.pointer.dispatch(event,peer,this.cdp,this.emulatedDevice.hasTouch,position);return;
    }
    if(event.action==='pointer'){
      if(!['down','move','up'].includes(event.key??'')||!Number.isFinite(event.x)||!Number.isFinite(event.y))throw new Error('Invalid pointer');
      const x=Math.max(0,Math.min(this.viewport.width,event.x!)),y=Math.max(0,Math.min(this.viewport.height,event.y!));
      await this.page.mouse.move(x,y);if(event.key==='down')await this.page.mouse.down();if(event.key==='up')await this.page.mouse.up();return;
    }
    if(event.nodeId&&!this.current?.nodes.some(n=>n.id===event.nodeId))throw new Error('Stale node');
    const route=this.capture.route(event.nodeId);if(!route)throw new Error('Frame is not ready');
    const evaluate=(expression:string)=>this.evaluate(expression,route.frame);
    const node=`window.__remoteDom.node(${JSON.stringify(route.localId)})`;
    if(event.action==='media'){
      if(!['play','pause','seek','volume','muted','rate'].includes(event.key??''))throw new Error('Invalid media operation');
      const value=event.mediaValue;if(['seek','volume','rate'].includes(event.key??'')&&(!Number.isFinite(value)||value!<0||value!>86400))throw new Error('Invalid media value');
      await evaluate(`(async()=>{const n=${node};if(!(n instanceof HTMLMediaElement))throw new Error('Not media');switch(${JSON.stringify(event.key)}){case 'play':await n.play();break;case 'pause':n.pause();break;case 'seek':n.currentTime=${value??0};break;case 'volume':n.volume=Math.max(0,Math.min(1,${value??0}));break;case 'muted':n.muted=${event.accept===true};break;case 'rate':n.playbackRate=Math.max(.25,Math.min(4,${value??1}));break;}})()`);return;
    }
    if(event.action==='focus'){await evaluate(`(()=>{const n=${node};if(n instanceof HTMLElement)n.focus({preventScroll:true});})()`);return;}
    if(event.action==='scroll'){
      if(!Number.isFinite(event.x)||!Number.isFinite(event.y))throw new Error('Invalid scroll');
      const x=Math.max(0,Math.min(1e7,event.x!)),y=Math.max(0,Math.min(1e7,event.y!));
      const windowFrame=event.nodeId?this.capture.frameWindows.get(event.nodeId):route.frame;
      if(windowFrame)await this.evaluate(`window.scrollTo(${x},${y})`,windowFrame);else await evaluate(`${node}?.scrollTo(${x},${y})`);return;
    }
    if(event.action==='click'||event.action==='hover'){
      const pointer={...event,pointerType:this.emulatedDevice.hasTouch?event.pointerType:undefined};
      if(event.clipboard&&event.action==='click'){
        const origin=new URL(this.page.url()).origin,marker=randomUUID();let ready=false;
        try{await this.context.grantPermissions(['clipboard-read','clipboard-write'],{origin});await this.evaluate(`navigator.clipboard.writeText(${JSON.stringify(marker)})`);ready=true;}catch{}
        try{await this.capture.click(route,event.x,event.y,false,pointer);if(ready){for(let attempt=0;attempt<5;attempt++){const text=await this.evaluate('navigator.clipboard.readText()');if(typeof text==='string'&&text!==marker){if(text.length>1024*1024)throw new Error('Clipboard exceeds 1 MiB');return text;}await new Promise(resolve=>setTimeout(resolve,80));}}}
        finally{await this.context.clearPermissions();await this.context.grantPermissions(['clipboard-write']);}
        return;
      }
      await this.capture.click(route,event.x,event.y,event.action==='hover',pointer);return;
    }
    if(event.action==='input'){
      const ready=await evaluate(`(()=>{const n=${node};if(n instanceof HTMLElement&&n.isContentEditable){n.focus();const range=document.createRange();range.selectNodeContents(n);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true;}if(!(n instanceof HTMLInputElement||n instanceof HTMLTextAreaElement)||n.disabled||n.readOnly)return false;if(n instanceof HTMLInputElement&&!['text','password','email','search','url','tel','number'].includes(n.type))return false;n.focus();n.select();return true;})()`);
      if(!ready)throw new Error('Unsupported input');
      if(event.value)await this.page.keyboard.insertText(event.value);else await this.page.keyboard.press('Backspace');
      if(Number.isInteger(event.selectionStart)&&Number.isInteger(event.selectionEnd))await evaluate(`(()=>{const n=${node};try{if(n instanceof HTMLElement&&n.isContentEditable){const walk=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);const text=[];while(walk.nextNode())text.push(walk.currentNode);const position=offset=>{for(const item of text){if(offset<=item.textContent.length)return [item,offset];offset-=item.textContent.length;}return [n,n.childNodes.length]};const start=position(${Math.max(0,event.selectionStart!)}),end=position(${Math.max(0,event.selectionEnd!)});const range=document.createRange();range.setStart(...start);range.setEnd(...end);getSelection().removeAllRanges();getSelection().addRange(range);return;}n.setSelectionRange(${Math.max(0,event.selectionStart!)},${Math.max(0,event.selectionEnd!)});}catch{}})()`);
      return;
    }
    if(event.action==='key'){
      if(!event.key||!/^(Control|Meta|Alt|Shift|Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete|F[1-9]|F1[0-2]|[\x20-\x7e])$/.test(event.key))throw new Error('Unsupported key');
      if(event.nodeId&&event.keyPhase!=='up'&&!['Control','Meta','Alt','Shift'].includes(event.key)&&!this.keyboard.held(peer,event.key))await evaluate(`(()=>{const n=${node};if(n instanceof HTMLElement)n.focus({preventScroll:true});})()`);
      if(event.keyPhase){await this.keyboard.dispatch(event,peer,this.page);return;}
      const keys=[event.ctrl?'Control':'',event.meta?'Meta':'',event.alt?'Alt':'',event.shift?'Shift':''].filter(Boolean);
      try{for(const key of keys)await this.page.keyboard.down(key);await this.page.keyboard.press(event.key);}finally{for(const key of keys.reverse())await this.page.keyboard.up(key);}return;
    }
    if(event.action==='select'){
      await evaluate(`(()=>{const n=${node};if(n instanceof HTMLSelectElement)n.value=${JSON.stringify(event.value??'')};else if(n instanceof HTMLInputElement&&['range','color','date','time','datetime-local','month','week'].includes(n.type)){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(event.value??'')});}else throw new Error('not-control');n.dispatchEvent(new Event('input',{bubbles:true,composed:true}));n.dispatchEvent(new Event('change',{bubbles:true,composed:true}));})()`);
    }
  }
  private resource(url:string){
    if(!url.startsWith('data:'))return this.assetByUrl.get(url);
    if(url.length>2800000)return;
    const match=url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)return;
    const key='inline:'+createHash('sha256').update(url).digest('hex');const existing=this.assetByUrl.get(key);if(existing)return existing;
    const decodedBytes=Math.floor(match[2].length*3/4)-(match[2].endsWith('==')?2:match[2].endsWith('=')?1:0);if(decodedBytes>MAX_ASSET_BYTES)return;
    while(this.inlineIds.length>=256){const old=this.inlineIds.shift()!,source=this.assets.get(old);if(source)this.assetByUrl.delete(source.url);this.assets.delete(old);this.inlineTransit.take(old);}
    if(this.assets.size>=2048)return;
    const id=randomUUID();this.assets.set(id,{url:key,mime:match[1]});this.assetByUrl.set(key,id);this.inlineIds.push(id);this.inlineTransit.put(id,{body:Buffer.from(match[2],'base64'),mime:match[1]});this.assetRevision++;return id;
  }
  async getAsset(id:string):Promise<AssetBody|undefined>{
    const source=this.assets.get(id);if(!source||this.closed)return;
    const existing=this.assetLoads.get(id);if(existing)return existing;
    if(this.assetLoads.size>=4)throw new Error('Resource transfers busy');
    const load=(async()=>{
      if(source.url.startsWith('inline:')){
        const buffered=this.inlineTransit.take(id);if(buffered)return buffered;
        for(const window of this.windows.values()){
          const url=await window.capture.inlineResource(source.url.slice(7));
          if(url){const body=Buffer.from(url.slice(url.indexOf(',')+1),'base64');if(body.length<=MAX_ASSET_BYTES)return {body,mime:source.mime};}
        }
        throw new Error('Inline resource has changed');
      }
      if(this.assetByUrl.get(source.url)!==id)throw new Error('Resource has changed');
      for(const window of this.windows.values()){const body=await window.capture.resource(source.url);if(body)return {body,mime:source.mime};}
      return fetchAsset(source,this.config,this.policy,async url=>(await this.context.cookies(url)).map(cookie=>cookie.name+'='+cookie.value).join('; '));
    })();
    this.assetLoads.set(id,load);
    try{const result=await load;if(!source.url.startsWith('inline:')&&this.assetByUrl.get(source.url)!==id)throw new Error('Resource has changed');return result;}finally{if(this.assetLoads.get(id)===load)this.assetLoads.delete(id);}
  }

  async upload(request:Record<string,unknown>){
    if(request.action==='dismiss-picker'){
      if(!this.picker||request.pickerId!==this.picker.id||request.epoch!==this.epoch)throw new Error('文件选择请求已失效');
      const sync=request.sync as {epoch?:string;seq?:number}|undefined;
      if(sync&&(typeof sync.epoch!=='string'||sync.epoch.length>100||!Number.isSafeInteger(sync.seq)||sync.seq!< -1))throw new Error('无效同步位置');
      this.uploads.clear();this.picker=undefined;await this.syncAfterInput();
      return {ok:true,update:sync?this.changes(sync.epoch!,sync.seq!):null};
    }
    const result=await this.uploads.handle(request,this.epoch,this.picker);if('finished'in result&&result.finished)this.picker=undefined;return result;
  }
  saveState():Promise<void>{
    if(this.saveTask)return this.saveTask;
    const store=this.store;if(!store||!this.context||!this.browser?.isConnected()||this.pendingDialog)return Promise.resolve();
    const task=(async()=>{
      try{
        const state=await this.context.storageState({indexedDB:true});if(this.store!==store)return;
        await store.save({id:this.id,owner:this.owner,url:this.current?.url??this.requestedUrl,title:this.current?.title??'已保存的浏览器',savedAt:new Date().toISOString(),state,devicePreset:this.devicePreset??'default'});
        this.persistenceError='';
      }catch(error){
        const message='浏览器环境未能保存，当前登录状态可能在关闭后丢失。请保持页面打开并联系管理员。';
        if(!this.persistenceError){console.error('Browser state persistence failed:',error instanceof Error?error.name:'unknown');this.broadcast({type:'error',message});}
        this.persistenceError=message;throw new Error(message);
      }
    })();
    this.saveTask=task;void task.then(()=>{if(this.saveTask===task)this.saveTask=undefined;},()=>{if(this.saveTask===task)this.saveTask=undefined;});return task;
  }
  disablePersistence(){clearInterval(this.saveTimer);this.store=undefined;}
  async loginClaude(value:unknown){
    if(this.claudeLoginBusy||this.deviceSwitchBusy)throw new ClaudeLoginError('浏览器正在处理登录或设备切换，请稍候',409);
    if(this.closed||!this.context||!this.page||this.page.isClosed())throw new ClaudeLoginError('请先打开或恢复浏览器',409);
    if(this.pendingDialog)throw new ClaudeLoginError('请先处理远端网页的提示框',409);
    this.claudeLoginBusy=true;
    try{return await importClaudeSession(value,this.context,this.page,this.policy,this.store?async()=>{
      // An autosave already in progress may have captured the previous cookies.
      await this.saveTask?.catch(()=>{});await this.saveState();
    }:undefined);}finally{this.claudeLoginBusy=false;}
  }
  async navigate(url:string){await this.policy.assert(url);await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}
  async navigation(action:'back'|'forward'|'reload'){
    if(action==='back')await this.page.goBack({waitUntil:'domcontentloaded'});
    else if(action==='forward')await this.page.goForward({waitUntil:'domcontentloaded'});
    else await this.page.reload({waitUntil:'domcontentloaded'});
  }
  send(socket:WebSocket,message:ServerMessage){if(socket.readyState===WebSocket.OPEN){
    const flow=this.renderFlow.get(socket);
    if(flow&&(message.type==='snapshot'||message.type==='patch')){
      if(flow.enabled&&flow.waiting.length>=flow.limit)return;
      const current=this.current;
      if(flow.enabled&&current){
        if(flow.last?.epoch===current.epoch&&flow.last.seq===current.seq)return;
        // Keep one shared immutable baseline per viewer so a delayed client can
        // catch up with a delta after the short general history has been evicted.
        if(!(message.type==='patch'&&message.epoch===flow.last?.epoch&&message.base===flow.last.seq)){
          const patch=flow.last?.epoch===current.epoch?diff(flow.last,current):undefined;
          message=patch?{...patch,seq:current.seq}:current;
        }
      }
      const cursor={epoch:message.epoch,seq:message.seq};
      if(flow.enabled)flow.waiting.push(cursor);else flow.waiting=[cursor];
      flow.last=current;
    }
    if(socket.bufferedAmount>MAX_STREAM_BUFFER_BYTES){socket.close(1013,'Reconnect to resync');const timer=setTimeout(()=>socket.terminate(),1000);timer.unref();socket.once('close',()=>clearTimeout(timer));return;}socket.send(JSON.stringify(message));}}
  private broadcast(message:ServerMessage){for(const socket of this.sockets)this.send(socket,message);}
  summary(){return {id:this.id,title:this.current?.title??'加载中',url:this.current?.url??this.requestedUrl,created:this.created,seq:this.current?.seq??0,deviceProfileId:this.deviceProfile.id,devicePreset:this.devicePreset??'default',persistenceError:this.persistenceError||undefined};}
  async close(force=false){if(this.closed)return;try{await this.saveState();}catch(error){if(!force)throw error;}this.closed=true;await this.pointer.cancel();await this.keyboard.cancel();this.diagnostics.clear();clearInterval(this.saveTimer);this.uploads.clear();this.picker=undefined;this.downloads.clear();clearTimeout(this.timer);this.broadcast({type:'closed'});for(const socket of this.sockets)socket.close(1000,'Session closed');this.sockets.clear();await this.browser?.close().catch(()=>{});await this.networkGuard?.close();this.networkGuard=undefined;this.assets.clear();this.inlineTransit.clear();this.inlineIds=[];this.assetByUrl.clear();this.fontRules.clear();this.svgSources.clear();this.svgBytes=0;this.windows.clear();this.history.clear();this.current=undefined;}
}

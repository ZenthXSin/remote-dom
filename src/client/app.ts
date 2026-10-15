import {initShell} from '../ui/shell.js';
initShell();
import type {Snapshot,Patch,UserEvent} from '../shared/protocol.js';
import {AssetLoader} from './assets.js';
import {collectNodeAssets} from '../shared/assets.js';
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const stage=$('mirror-stage');
const frame=$<HTMLIFrameElement>('mirror');const address=$<HTMLInputElement>('address');
let port:MessagePort;let readyResolve:()=>void;const ready=new Promise<void>(resolve=>readyResolve=resolve);
let socket:WebSocket|undefined;let activeId='';let generation=0;let epoch='';let closing=false;let reconnectTimer:ReturnType<typeof setTimeout>|undefined;
let eventCounter=Number(sessionStorage.getItem('rd_event_counter'))||0;const sentAt=new Map<number,{time:number;frameId?:number;action?:UserEvent['action']}>();let queue=Promise.resolve();
const assetLoader=new AssetLoader((id,mime,bytes)=>port.postMessage({type:'asset',id,mime,bytes},[bytes]),(pending,failed)=>{
  $('resource-state').textContent=pending?`图片和字体加载中（${pending}）`:failed?`${failed} 项图片或字体未加载`:'';
  $('resource-state').hidden=!pending&&!failed;$('retry-assets').hidden=!failed;
});
$('retry-assets').addEventListener('click',()=>assetLoader.retry());
let fixtureUrl='';let preferredUrl='';let heartbeat:ReturnType<typeof setInterval>|undefined;
let transport='websocket';let httpFallback=false;let connected=false;let httpEpoch='';let httpSeq=-1;let socketTimeout:ReturnType<typeof setTimeout>|undefined;
const httpClient=sessionStorage.getItem('rd_input_client')??crypto.randomUUID();sessionStorage.setItem('rd_input_client',httpClient);
const pendingEvents:UserEvent[]=[];let writeBusy=false;let eventTimer:ReturnType<typeof setTimeout>|undefined;let progressTimer:ReturnType<typeof setTimeout>|undefined;let pollAbort:AbortController|undefined;let requestPoll:(()=>void)|undefined;let lastViewport='';
let uncertainInput=false;
function nextEventId(){const id=++eventCounter;sessionStorage.setItem('rd_event_counter',String(id));return id;}
let zoom=1;
let browserBusy=false;
function setBrowserBusy(value:boolean){browserBusy=value;for(const id of ['resume-browser','forget-browser','destroy','create','demo']){const button=document.getElementById(id) as HTMLButtonElement|null;if(button)button.disabled=value;}}
const recoveryDialog=$<HTMLDialogElement>('recovery-dialog');
$('recovery-close').addEventListener('click',()=>recoveryDialog.close());
$('show-recovery').addEventListener('click',()=>{void api('/api/recovery').then(data=>{$<HTMLInputElement>('recovery-value').value=data.token;$('recovery-submit').hidden=true;recoveryDialog.showModal();}).catch(error=>notice(error.message,true));});
$('enter-recovery').addEventListener('click',()=>{$<HTMLInputElement>('recovery-value').value='';$('recovery-submit').hidden=false;recoveryDialog.showModal();});
$('recovery-submit').addEventListener('click',()=>{void api('/api/recovery','POST',{token:$<HTMLInputElement>('recovery-value').value.trim()}).then(async()=>{await ready;closing=true;clearTimeout(reconnectTimer);socket?.close();activeId='';generation++;port.postMessage({type:'reset'});assetLoader.reset();const state=await refresh();if(state.sessions.length){connect(state.sessions[0].id);frame.hidden=false;$('empty').hidden=true;}else{frame.hidden=true;$('empty').hidden=false;}recoveryDialog.close();notice('环境身份已恢复，可选择已保存的浏览器');}).catch(error=>notice(error.message,true));});
$('resume-browser').addEventListener('click',()=>{const id=$<HTMLSelectElement>('saved-browsers').value;if(!id||browserBusy)return;setBrowserBusy(true);let checking=false;const poll=setInterval(()=>{if(checking)return;checking=true;void api('/api/state').then(state=>{if(state.sessions.some((session:any)=>session.id===id)&&activeId!==id){port.postMessage({type:'reset'});assetLoader.reset();epoch='';connect(id);frame.hidden=false;$('empty').hidden=true;}}).catch(()=>{}).finally(()=>checking=false);},350);void api('/api/saved-browsers','POST',{id}).then(async session=>{if(activeId!==session.id){port.postMessage({type:'reset'});assetLoader.reset();epoch='';connect(session.id);}frame.hidden=false;$('empty').hidden=true;await refresh();}).catch(error=>notice(error.message,true)).finally(()=>{clearInterval(poll);setBrowserBusy(false);});});
$('forget-browser').addEventListener('click',()=>{const id=$<HTMLSelectElement>('saved-browsers').value;if(!id)return;if(!confirm('清除后将无法恢复这个浏览器的已保存登录环境。确定清除？'))return;void api('/api/saved-browsers','POST',{id,action:'forget'}).then(async()=>{if(activeId===id){closing=true;activeId='';generation++;socket?.close();clearTimeout(reconnectTimer);assetLoader.reset();port.postMessage({type:'reset'});frame.hidden=true;$('empty').hidden=false;}await refresh();notice('该环境的保存数据已清除');}).catch(error=>notice(error.message,true));});
function openFind(){if(!activeId)return;$('find-bar').hidden=false;$<HTMLInputElement>('find-query').focus();}
function findPage(direction=0){if(port)port.postMessage({type:'find',query:$<HTMLInputElement>('find-query').value,direction});}
$('find-open').addEventListener('click',openFind);
$('find-query').addEventListener('input',()=>findPage());
$('find-query').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();findPage(event.shiftKey?-1:1);}if(event.key==='Escape'){$('find-bar').hidden=true;port.postMessage({type:'find',query:'',direction:0});}});
$('find-next').addEventListener('click',()=>findPage(1));$('find-prev').addEventListener('click',()=>findPage(-1));$('find-close').addEventListener('click',()=>{$('find-bar').hidden=true;port.postMessage({type:'find',query:'',direction:0});});
document.addEventListener('keydown',event=>{if(!activeId||!event.ctrlKey&&!event.metaKey)return;if(event.key.toLowerCase()==='f'){event.preventDefault();openFind();}if(event.key.toLowerCase()==='l'){event.preventDefault();address.focus();address.select();}});
let clipboardText='';$('copy-result').addEventListener('click',()=>{void navigator.clipboard.writeText(clipboardText).then(()=>{$('copy-result').hidden=true;notice('已复制到设备');}).catch(()=>notice('浏览器拒绝访问剪贴板',true));});
let browserDialogInfo:{id:string;epoch:string;kind:string}|undefined;
const browserDialog=$<HTMLDialogElement>('browser-dialog');
async function answerDialog(accept:boolean){const info=browserDialogInfo,id=activeId;if(!info||!id)return;try{const reply=await api(`/api/sessions/${id}/events`,'POST',{clientId:httpClient,event:{type:'event',epoch:info.epoch,eventId:nextEventId(),action:'dialog',dialogId:info.id,accept,value:$<HTMLInputElement>('browser-dialog-value').value}});if(reply.type==='error')throw new Error(reply.message);browserDialog.close();browserDialogInfo=undefined;}catch(error){notice((error as Error).message,true);}}
$('browser-dialog-accept').addEventListener('click',()=>void answerDialog(true));
$('browser-dialog-dismiss').addEventListener('click',()=>void answerDialog(false));
browserDialog.addEventListener('cancel',event=>{event.preventDefault();void answerDialog(false);});
let inChildWindow=false;
let mainWindowId='';
const viewBack=$<HTMLButtonElement>('view-back');
function resetViewBack(){inChildWindow=false;mainWindowId='';viewBack.textContent='← 返回';viewBack.disabled=!activeId;}
let pendingFilePicker:{id:string;accept:string;multiple:boolean}|undefined;
let pickerSession='';let pickerEpoch='';let uploading=false;
let uploadPercent=0;let feedbackTimer:ReturnType<typeof setTimeout>|undefined;
function operationFeedback(){
  clearTimeout(feedbackTimer);feedbackTimer=undefined;
  const pending=[...sentAt.values()].filter(sent=>sent.frameId!==undefined&&!['hover','viewport','scroll','focus'].includes(sent.action??''));
  const age=pending.length?performance.now()-Math.min(...pending.map(sent=>sent.time)):0;
  const text=uploading?`正在上传 ${uploadPercent}%`:age>=350?(age>=2500?'操作仍在处理…':'正在响应…'):'';
  const state=$('operation-state');if(state.textContent!==text)state.textContent=text;state.hidden=!text;
  if(pending.length||uploading)feedbackTimer=setTimeout(operationFeedback,150);
}
$('choose-files').addEventListener('click',()=>{if(pendingFilePicker&&!uploading){const input=$<HTMLInputElement>('files');input.accept=pendingFilePicker.accept;input.multiple=pendingFilePicker.multiple;input.value='';input.click();}});
$('cancel-picker').addEventListener('click',()=>{void dismissPicker().catch(error=>notice(error.message,true));});
async function dismissPicker(){
  const picker=pendingFilePicker,id=pickerSession,localGeneration=generation;if(!picker||uploading||!id)return;
  $<HTMLButtonElement>('cancel-picker').disabled=true;
  try{const result=await api(`/api/sessions/${id}/uploads`,'POST',{action:'dismiss-picker',pickerId:picker.id,epoch:pickerEpoch,sync:{epoch:httpEpoch,seq:httpSeq}});if(localGeneration!==generation)return;pendingFilePicker=undefined;$('file-panel').hidden=true;if(result.update)receive(result.update,id,localGeneration);}
  finally{if(localGeneration===generation)$<HTMLButtonElement>('cancel-picker').disabled=false;}
}
$('files').addEventListener('change',()=>{void uploadFiles().catch(error=>notice(error.message,true));});
async function uploadFiles(){
  const files=[...($<HTMLInputElement>('files').files??[])],picker=pendingFilePicker,id=pickerSession,pageEpoch=pickerEpoch;
  if(!files.length||!picker||uploading)return;
  const total=files.reduce((n,f)=>n+f.size,0);if(files.length>4||total>16*1024*1024)throw new Error('一次最多上传 4 个文件，共 16 MiB');
  uploading=true;uploadPercent=0;operationFeedback();$<HTMLButtonElement>('choose-files').disabled=true;$<HTMLButtonElement>('cancel-picker').disabled=true;let uploadId='';
  try{
    const upload=await api(`/api/sessions/${id}/uploads`,'POST',{action:'begin',pickerId:picker.id,epoch:pageEpoch,files:files.map(f=>({name:f.name,size:f.size,mimeType:f.type}))});uploadId=upload.id;
    let sent=0;
    for(let index=0;index<files.length;index++){
      const bytes=new Uint8Array(await files[index].arrayBuffer());
      for(let offset=0;offset<bytes.length;offset+=32768){const chunk=bytes.subarray(offset,offset+32768);await api(`/api/sessions/${id}/uploads`,'POST',{action:'chunk',id:uploadId,index,offset,data:btoa(String.fromCharCode(...chunk))});sent+=chunk.length;uploadPercent=Math.round(sent/Math.max(1,total)*100);operationFeedback();notice(`正在传送文件 · ${uploadPercent}%`);}
    }
    await api(`/api/sessions/${id}/uploads`,'POST',{action:'finish',id:uploadId});notice('文件已交给远端网页');
  }catch(error){if(uploadId)await api(`/api/sessions/${id}/uploads`,'POST',{action:'cancel',id:uploadId}).catch(()=>{});throw error;}
  finally{uploading=false;operationFeedback();$<HTMLButtonElement>('choose-files').disabled=false;$<HTMLButtonElement>('cancel-picker').disabled=false;}
}
let containerProfile:Record<string,any>|undefined;let containerEnvironment:Record<string,any>|undefined;
$('device-profile').addEventListener('click',()=>{
  if(!containerProfile)return;
  const p=containerProfile;
  $('profile-details').textContent=`档案编号：${p.id}\n创建时间：${p.createdAt}\n设备：${p.device}\n屏幕：${p.screen.width} × ${p.screen.height}\n像素比例：${p.deviceScaleFactor}\n语言：${p.locale}\n时区：${p.timezoneId}\n主题：${p.colorScheme}\n系统：${p.platform}\n浏览器：使用实际 Chromium 版本\n设备类型：${p.isMobile?'手机，支持触控':'桌面，无触摸设备'}`;
  if(containerEnvironment){const e=containerEnvironment;$('profile-details').textContent+=`\n\n系统环境：${e.os.id} ${e.os.version}\n系统主机名：${e.hostname}\n系统 machine-id：${e.machineId}\n原生可用 CPU：${e.cpuIds.length}\n容器内存上限：${e.memoryLimitBytes/1024**3} GiB\n系统语言：${e.locale}\n系统时区：${e.timezoneId}`;}
  $<HTMLDialogElement>('profile-dialog').showModal();
});
$('profile-close').addEventListener('click',()=>$<HTMLDialogElement>('profile-dialog').close());
function viewportSize(){return {width:Math.max(160,Math.round(stage.clientWidth/zoom)),height:Math.max(160,Math.round(stage.clientHeight/zoom))};}
function applyMirrorScale(){
 frame.style.width='100%';frame.style.height='100%';frame.style.transformOrigin='';frame.style.transform='';frame.style.left='';frame.style.top='';
}
function setZoom(scale:number){zoom=Math.max(.1,Math.min(4,scale));$('zoom-level').textContent=`${Math.round(zoom*100)}%`;applyMirrorScale();void ready.then(()=>port.postMessage({type:'zoom',scale:zoom}));resize();}
$('fit-screen').addEventListener('click',()=>{
  setZoom(1);lastViewport='';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{lastViewport='';resize();}));
});
$('zoom-out').addEventListener('click',()=>setZoom(zoom-.25));
$('zoom-in').addEventListener('click',()=>setZoom(zoom+.25));
$('zoom-reset').addEventListener('click',()=>setZoom(1));
$('expand').addEventListener('click',()=>{
  const view=$('viewer');view.classList.toggle('is-expanded');document.body.classList.toggle('browser-expanded',view.classList.contains('is-expanded'));
  $('expand').textContent=view.classList.contains('is-expanded')?'↙':'⛶';
  $('expand').setAttribute('aria-label',view.classList.contains('is-expanded')?'恢复窗口':'放大窗口');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{lastViewport='';resize();}));
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('viewer').classList.remove('is-expanded');document.body.classList.remove('browser-expanded');$('expand').textContent='⛶';$('expand').setAttribute('aria-label','放大窗口');resize();}});
async function api(path:string,method='GET',data?:unknown){const response=await fetch(path,{method,headers:data?{'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined,cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error??'请求失败');return result;}
function notice(message:string,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function persistenceNotice(message?:string){$('persistence-status').textContent=message??'';$('persistence-status').hidden=!message;}
frame.addEventListener('load',()=>{
  const channel=new MessageChannel();port=channel.port1;port.onmessage=event=>{
    const message=event.data;
    if(message.type==='open-find'){openFind();return;}
    if(message.type==='focus-address'){address.focus();address.select();return;}
    if(message.type==='find-result'){$('find-count').textContent=message.total?`${message.index} / ${message.total}`:'没有匹配';return;}
    if(message.type==='ready'){port.postMessage({type:'zoom',scale:zoom});readyResolve();return;}
    if(message.type==='resync'){resync();return;}
    if(message.type==='release-assets'){assetLoader.forget(message.ids);return;}
    if(message.type==='rendered'){$('nodes').textContent=String(message.nodeCount);$('revision').textContent=String(message.seq);return;}
    if(message.type==='event'){
      if(connected){const input=message as UserEvent;const remoteId=nextEventId();sentAt.set(remoteId,{time:performance.now(),frameId:input.eventId,action:input.action});operationFeedback();sendEvent({...input,eventId:remoteId});}
      else{port.postMessage({type:'error',eventId:message.eventId});notice('连接尚未恢复，请重新操作',true);}
    }
  };port.start();frame.contentWindow!.postMessage({type:'initialize'},'*',[channel.port2]);
});
frame.src='/mirror';
function prepareAssets(message:Snapshot|Patch){
  const nodes=message.type==='snapshot'?message.nodes:message.upsert;
  const ids=collectNodeAssets(nodes);for(const font of message.fontFaces??[]){const match=/^asset:([a-f0-9-]{36})$/.exec(font.assetUrl);if(match)ids.add(match[1]);}assetLoader.enqueue([...ids]);
}
function receive(message:any,id:string,localGeneration:number){
  if(localGeneration!==generation)return;
  if(message.type!=='snapshot'&&message.type!=='patch'){
    void ready.then(()=>{if(localGeneration!==generation)return;
    if(message.type==='dialog'){
      if(browserDialogInfo?.id!==message.id){browserDialogInfo=message;$('browser-dialog-title').textContent=message.kind==='prompt'?'网页请求输入':message.kind==='beforeunload'?'确认离开网页':'网页提示';$('browser-dialog-origin').textContent=message.origin;$('browser-dialog-message').textContent=message.message;const value=$<HTMLInputElement>('browser-dialog-value');value.hidden=message.kind!=='prompt';value.value=message.defaultValue??'';$('browser-dialog-dismiss').hidden=message.kind==='alert';if(!browserDialog.open)browserDialog.showModal();if(!value.hidden)value.focus();}
    }
    else if(message.type==='ack'||message.type==='clipboard'){
      if(message.type==='clipboard'){clipboardText=message.text;void navigator.clipboard.writeText(clipboardText).then(()=>{$('copy-result').hidden=true;notice('已复制到设备');}).catch(()=>$('copy-result').hidden=false);}
      const sent=sentAt.get(message.eventId);if(sent){$('latency').textContent=`${Math.round(performance.now()-sent.time)} ms`;sentAt.delete(message.eventId);operationFeedback();if(sent.frameId!==undefined)port.postMessage({...message,type:'ack',eventId:sent.frameId});}
    }else if(message.type==='error'){notice(message.message,true);const sent=sentAt.get(message.eventId);if(sent?.frameId!==undefined){port.postMessage({...message,eventId:sent.frameId});sentAt.delete(message.eventId);operationFeedback();}}else if(message.type==='closed'){closing=true;notice('会话已结束');}

    }).catch(()=>notice('操作确认暂不可用',true));return;
  }
  if(transport==='http'){
    if(message.epoch===httpEpoch&&message.seq<=httpSeq)return;
    if(message.type==='patch'&&(message.epoch!==httpEpoch||message.base!==httpSeq)){resync();return;}
    httpEpoch=message.epoch;httpSeq=message.seq;
  }
  queue=queue.then(async()=>{
    if(localGeneration!==generation)return;await ready;
      pendingFilePicker=message.filePicker;pickerSession=id;pickerEpoch=message.epoch;$('file-panel').hidden=!pendingFilePicker;
      const files=message.downloads??[];const downloads=$('downloads');
      if(downloads.dataset.state!==JSON.stringify(files)){downloads.dataset.state=JSON.stringify(files);downloads.replaceChildren();for(const file of files){const link=document.createElement('a');link.href=`/api/sessions/${id}/downloads/${file.id}`;link.textContent=`下载 ${file.name}`;link.className='secondary';link.setAttribute('download',file.name);downloads.append(link);}}
      epoch=message.epoch;const windows=message.windows??[];mainWindowId=windows[0]?.id??'';inChildWindow=windows.length>1&&!windows[0].active;viewBack.textContent=inChildWindow?'← 返回主窗口':'← 返回';viewBack.disabled=false;$('window-strip').hidden=windows.length<2;const select=$<HTMLSelectElement>('windows');if(JSON.stringify(windows)!==select.dataset.state){select.dataset.state=JSON.stringify(windows);select.replaceChildren();for(const window of windows){const option=document.createElement('option');option.value=window.id;option.textContent=window.title;option.selected=window.active;select.append(option);}}
      port.postMessage(message);prepareAssets(message);persistenceNotice(message.persistenceError);if(document.activeElement!==address)address.value=message.url;$('page-title').textContent=message.title||'无标题';
      $('capabilities').textContent=message.unsupported?.length?`页面含暂不支持的能力：${message.unsupported.join('、')}`:message.truncated?'页面达到节点数量上限':'目标脚本在远端执行 · 本地不接收目标 Cookie';
      if(message.type==='snapshot')resize();

  }).catch(()=>{if(localGeneration===generation){resync();notice('同步暂不可用，请重新连接',true);}});
}
function online(){connected=true;frame.inert=false;notice(uncertainInput?'最近操作尚未确认，请核对页面状态':'已连接 · 页面由本地 DOM 渲染',uncertainInput);uncertainInput=false;$('connection').textContent='在线';$('connection').className='online';}
function offline(){connected=false;frame.inert=true;$('connection').textContent='已断开';$('connection').className='';notice('连接中断，正在重新同步…');}
function resync(){httpEpoch='';httpSeq=-1;if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resync'}));}
function sendEvent(event:UserEvent){
  if(transport!=='http'){socket?.send(JSON.stringify(event));return;}
  const last=pendingEvents.at(-1);
  if(last&&['input','hover','scroll','viewport'].includes(event.action)&&last.action===event.action&&last.nodeId===event.nodeId){pendingEvents.pop();const sent=sentAt.get(last.eventId);if(sent?.frameId!==undefined)port.postMessage({type:'ack',eventId:sent.frameId});sentAt.delete(last.eventId);operationFeedback();}
  pendingEvents.push(event);if(!writeBusy&&!eventTimer)eventTimer=setTimeout(()=>{eventTimer=undefined;void flushEvents();},8);
}
async function flushEvents(){
  if(writeBusy||!pendingEvents.length||!activeId)return;
  const id=activeId,localGeneration=generation,events:UserEvent[]=[];let bytes=0;
  while(pendingEvents.length&&events.length<16){const next=pendingEvents[0];const size=new TextEncoder().encode(JSON.stringify(next)).length;if(events.length&&bytes+size>48000)break;events.push(pendingEvents.shift()!);bytes+=size;}
  writeBusy=true;pollAbort?.abort();clearTimeout(reconnectTimer);
  const checkTimer=setTimeout(()=>{if(localGeneration===generation)requestPoll?.();},250);progressTimer=checkTimer;
  try{
    const result=await api(`/api/sessions/${id}/events`,'POST',{clientId:httpClient,events,sync:{epoch:httpEpoch,seq:httpSeq}});
    if(localGeneration!==generation)return;
    for(const reply of result.replies??[]){receive(reply,id,localGeneration);if(reply.type==='error')resync();}
    if(result.update)receive(result.update,id,localGeneration);
    if(result.timing)$('latency').title=`服务端执行 ${result.timing.executeMs} ms · 捕获同步 ${result.timing.syncMs} ms`;
  }catch{if(localGeneration===generation){for(const event of events)receive({type:'error',eventId:event.eventId,message:'操作确认失败，请核对页面状态'},id,localGeneration);resync();}}
  finally{clearTimeout(checkTimer);if(progressTimer===checkTimer)progressTimer=undefined;if(localGeneration===generation){writeBusy=false;if(pendingEvents.length)void flushEvents();else requestPoll?.();}}
}
function connect(id:string){
  clearTimeout(socketTimeout);
  for(const sent of sentAt.values())if(sent.frameId!==undefined){port.postMessage({type:'error',eventId:sent.frameId});uncertainInput=true;}sentAt.clear();operationFeedback();$('file-panel').hidden=true;
  pollAbort?.abort();clearTimeout(eventTimer);clearTimeout(progressTimer);eventTimer=undefined;progressTimer=undefined;pendingEvents.length=0;writeBusy=false;requestPoll=undefined;lastViewport='';
  clearTimeout(reconnectTimer);clearInterval(heartbeat);generation++;socket?.close();socket=undefined;activeId=id;closing=false;connected=false;frame.inert=true;
  const localGeneration=generation;
  $('connection').dataset.transport=transport;
  $('connection').title=transport==='http'?'HTTP 备用连接':'WebSocket 长连接';
  assetLoader.begin(id);
  resetViewBack();
  if(transport==='http'){
    httpEpoch='';httpSeq=-1;
    let polling=false;
    const poll=async()=>{
      if(localGeneration!==generation||closing||polling)return;
      polling=true;const controller=new AbortController();pollAbort=controller;const controlOnly=writeBusy;
      try{
        const response=await fetch(`/api/sessions/${id}/updates?epoch=${encodeURIComponent(httpEpoch)}&since=${httpSeq}${controlOnly?'&control=1':''}`,{cache:'no-store',signal:controller.signal});
        if(localGeneration!==generation)return;
        if(response.status===404||response.status===401){closing=true;offline();notice('会话已失效，请重新创建',true);return;}
        if(!response.ok)throw new Error('Unavailable');
        if(!connected)online();
        if(response.status!==204){const message=await response.json();if(!writeBusy||message.type!=='snapshot'&&message.type!=='patch'){receive(message,id,localGeneration);await queue;}}
      }catch{if(localGeneration===generation&&!controller.signal.aborted){offline();httpEpoch='';httpSeq=-1;}}
      finally{polling=false;if(pollAbort===controller)pollAbort=undefined;}
      if(localGeneration===generation&&!closing&&!controller.signal.aborted)reconnectTimer=setTimeout(()=>void poll(),connected?(document.hidden?1200:writeBusy?250:80):1200);
    };
    requestPoll=()=>{clearTimeout(reconnectTimer);const kick=()=>{if(localGeneration!==generation||closing)return;if(polling)reconnectTimer=setTimeout(kick,15);else void poll();};kick();};
    void poll();return;
  }
  const scheme=location.protocol==='https:'?'wss:':'ws:',candidate=new WebSocket(`${scheme}//${location.host}/api/sessions/${id}/stream`);socket=candidate;
  let opened=false,received=false,lastMessage=Date.now(),stalled=false;
  socketTimeout=setTimeout(()=>{if(localGeneration===generation&&candidate.readyState===WebSocket.CONNECTING)candidate.close();},4000);
  candidate.onopen=()=>{if(localGeneration!==generation){candidate.close();return;}opened=true;lastMessage=Date.now();clearTimeout(socketTimeout);online();heartbeat=setInterval(()=>{if(localGeneration!==generation)return;if(!document.hidden&&Date.now()-lastMessage>45000){stalled=true;candidate.close();return;}if(candidate.readyState===WebSocket.OPEN)candidate.send(JSON.stringify({type:'ping'}));},15000);};
  candidate.onmessage=event=>{if(localGeneration!==generation)return;lastMessage=Date.now();try{const message=JSON.parse(event.data);received=true;if(message.type!=='pong')receive(message,id,localGeneration);}catch{candidate.close(1002,'Invalid stream response');}};
  candidate.onclose=()=>{if(localGeneration!==generation)return;clearTimeout(socketTimeout);offline();clearInterval(heartbeat);if(closing||!activeId)return;if(!opened||!received||stalled){httpFallback=true;transport='http';connect(id);}else reconnectTimer=setTimeout(()=>connect(id),1200);};
}
async function refresh(){const state=await api('/api/state');assetLoader.setScope(state.assetCacheScope??'');containerProfile=state.deviceProfile;applyMirrorScale();containerEnvironment=state.containerEnvironment;$<HTMLButtonElement>('device-profile').disabled=!containerProfile;fixtureUrl=state.fixtureUrl;preferredUrl=state.defaultUrl??fixtureUrl;transport=httpFallback?'http':state.transport??'websocket';$('mode').textContent=state.mode==='demo'?'受控测试模式':'云端浏览 · 就绪';if(state.mode==='development'){$('demo').textContent='打开目标网页 →';if(!activeId&&!address.value)address.value=preferredUrl;}$('saved-panel').hidden=!state.capabilities?.persistentLogin;const saved=$<HTMLSelectElement>('saved-browsers');saved.replaceChildren();for(const browser of state.savedSessions??[]){const option=document.createElement('option');option.value=browser.id;option.textContent=browser.title;saved.append(option);} const select=$<HTMLSelectElement>('sessions');select.replaceChildren();for(const session of state.sessions){const option=document.createElement('option');option.value=session.id;option.textContent=session.title;select.append(option);}select.value=activeId;return state;}
function normalizeAddress(){const value=address.value.trim();if(value&&!/^[a-z][a-z0-9+.-]*:/i.test(value))address.value='https://'+value;}
async function create(){
 normalizeAddress();
  const button=$<HTMLButtonElement>('create');button.disabled=true;notice('正在启动独立 Chromium 进程…');
  const first=!activeId;
  let creationPoll:ReturnType<typeof setInterval>|undefined;
  try{
    await ready;
    if(first){$('empty').hidden=true;frame.hidden=false;frame.style.visibility='hidden';await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
    const viewport=viewportSize();
    const existing=new Set((await api('/api/state')).sessions.map((s:any)=>s.id));let checking=false;
    creationPoll=setInterval(()=>{if(checking)return;checking=true;void api('/api/state').then(state=>{const pending=state.sessions.find((s:any)=>!existing.has(s.id));if(pending&&activeId!==pending.id){port.postMessage({type:'reset'});assetLoader.reset();epoch='';connect(pending.id);$('empty').hidden=true;frame.hidden=false;}}).catch(()=>{}).finally(()=>checking=false);},350);
    const session=await api('/api/sessions','POST',{url:address.value.trim()||fixtureUrl,viewport});
    if(activeId!==session.id){port.postMessage({type:'reset'});assetLoader.reset();epoch='';connect(session.id);}
    $('empty').hidden=true;frame.hidden=false;await refresh();
  }
  catch(error){if(first){frame.hidden=true;$('empty').hidden=false;}notice((error as Error).message,true);}
  finally{clearInterval(creationPoll);frame.style.visibility='';button.disabled=false;}
}
$('create').addEventListener('click',()=>void create());
$('demo').addEventListener('click',()=>{address.value=preferredUrl||fixtureUrl;void create();});
$('navigate').addEventListener('submit',event=>{event.preventDefault();normalizeAddress();if(!activeId){void create();return;}void api(`/api/sessions/${activeId}/navigate`,'POST',{url:address.value}).catch(error=>notice(error.message,true));});
for(const action of ['back','forward','reload'])$(action).addEventListener('click',()=>{if(activeId)void api(`/api/sessions/${activeId}/navigation`,'POST',{action}).catch(error=>notice(error.message,true));});
viewBack.addEventListener('click',()=>{if(!activeId)return;void api(`/api/sessions/${activeId}/${inChildWindow?'windows':'navigation'}`,'POST',inChildWindow?{id:mainWindowId}:{action:'back'}).catch(error=>notice(error.message,true));});
$('destroy').addEventListener('click',async()=>{if(!activeId||browserBusy)return;setBrowserBusy(true);const id=activeId;try{await api(`/api/sessions/${id}`,'DELETE');closing=true;clearTimeout(reconnectTimer);activeId='';resetViewBack();generation++;socket?.close();clearInterval(heartbeat);persistenceNotice();port.postMessage({type:'reset'});assetLoader.reset();epoch='';frame.hidden=true;$('empty').hidden=false;notice('会话已销毁，远端浏览器已关闭');$('connection').textContent='未连接';await refresh();}catch(error){notice((error as Error).message,true);}finally{setBrowserBusy(false);}});
$('resync').addEventListener('click',resync);
$('windows').addEventListener('change',()=>{if(activeId)void api(`/api/sessions/${activeId}/windows`,'POST',{id:$<HTMLSelectElement>('windows').value}).catch(error=>notice(error.message,true));});
$('close-window').addEventListener('click',()=>{if(activeId)void api(`/api/sessions/${activeId}/windows`,'POST',{action:'close'}).catch(error=>notice(error.message,true));});
$<HTMLSelectElement>('sessions').addEventListener('change',event=>{const id=(event.target as HTMLSelectElement).value;if(id){port.postMessage({type:'reset'});assetLoader.reset();connect(id);}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&connected)requestPoll?.();});
let resizeTimer:ReturnType<typeof setTimeout>|undefined;
function resize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!epoch||!connected)return;const size=viewportSize(),key=`${activeId}:${epoch}:${size.width}:${size.height}`;if(key===lastViewport)return;lastViewport=key;sendEvent({type:'event',action:'viewport',epoch,eventId:nextEventId(),...size});},35);}
new ResizeObserver(()=>{applyMirrorScale();resize();}).observe(stage);
void refresh().then(state=>{if(state.sessions.length){activeId=state.sessions[0].id;void ready.then(()=>{connect(activeId);$('empty').hidden=true;frame.hidden=false;});}}).catch(error=>notice(error.message,true));

const floatingTools=$('floating-tools'),floatingBall=$('floating-ball'),floatingMenu=$('floating-menu');
let ballDrag:{x:number;y:number;left:number;top:number;moved:boolean}|undefined;
let suppressBallClick=false;
function closeFloatingMenu(){floatingMenu.hidden=true;floatingBall.setAttribute('aria-expanded','false');}
floatingBall.addEventListener('click',()=>{if(suppressBallClick){suppressBallClick=false;return;}floatingMenu.hidden=!floatingMenu.hidden;floatingBall.setAttribute('aria-expanded',String(!floatingMenu.hidden));});
floatingBall.addEventListener('pointerdown',event=>{const rect=floatingTools.getBoundingClientRect();ballDrag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};floatingBall.setPointerCapture(event.pointerId);});
floatingBall.addEventListener('pointermove',event=>{if(!ballDrag)return;const dx=event.clientX-ballDrag.x,dy=event.clientY-ballDrag.y;if(Math.hypot(dx,dy)>5)ballDrag.moved=true;if(!ballDrag.moved)return;closeFloatingMenu();floatingTools.style.right='auto';floatingTools.style.bottom='auto';floatingTools.style.left=`${Math.max(8,Math.min(innerWidth-64,ballDrag.left+dx))}px`;floatingTools.style.top=`${Math.max(8,Math.min(innerHeight-64,ballDrag.top+dy))}px`;});
function endBallDrag(){suppressBallClick=!!ballDrag?.moved;ballDrag=undefined;}
floatingBall.addEventListener('pointerup',endBallDrag);floatingBall.addEventListener('pointercancel',endBallDrag);
floatingMenu.querySelectorAll<HTMLButtonElement>('[data-view-action]').forEach(button=>button.addEventListener('click',()=>{const target=$<HTMLButtonElement>(button.dataset.viewAction!);if(!target.disabled)target.click();closeFloatingMenu();}));
document.addEventListener('pointerdown',event=>{if(!floatingTools.contains(event.target as Node))closeFloatingMenu();});
window.addEventListener('resize',()=>{floatingTools.style.left='';floatingTools.style.top='';floatingTools.style.right='';floatingTools.style.bottom='';closeFloatingMenu();});

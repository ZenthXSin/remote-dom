import {createHash} from 'node:crypto';
import type {Page,Frame,CDPSession} from 'playwright-core';
import type {CapturedDocument,MirrorNode} from '../shared/protocol.js';

interface FrameDescription {id:string;parentId?:string}
interface FrameTree {frame:FrameDescription;childFrames?:FrameTree[]}
export interface CaptureFrame {id:string;parentId?:string;cdp:CDPSession;context?:number;owner?:{frame:CaptureFrame;nodeId:string}}
export interface NodeRoute {frame:CaptureFrame;localId:string}

// Every frame is read through an isolated CDP world. Only filtered node data
// travels to the client; target frame origins never become local iframe URLs.
export class FrameCapture {
  private frames=new Map<string,CaptureFrame>();
  private sessions=new Map<Frame,{url:string;cdp?:CDPSession}>();
  private watched=new WeakSet<CDPSession>();
  private svgContexts=new Map<CaptureFrame,Map<string,string>>();
  private ids=new Map<string,string>();private serial=0;
  private usedIds=new Set<string>();
  private activity=new Map<CaptureFrame,{context:number;revision:number}>();private capturedAt=0;
  private hiddenFrames=new Set<CaptureFrame>();
  routes=new Map<string,NodeRoute>();frameWindows=new Map<string,CaptureFrame>();
  main!:CaptureFrame;
  diagnostics:{operation:string;error:string}[]=[];
  constructor(private page:Page,private cdp:CDPSession,private source:string,private svgSources:ReadonlyMap<string,string>=new Map()){}
  private watch(cdp:CDPSession){
    if(this.watched.has(cdp))return;this.watched.add(cdp);
    cdp.on('Page.frameNavigated',({frame})=>{const state=this.frames.get(frame.id);if(state?.cdp===cdp)state.context=undefined;});
    cdp.on('Runtime.executionContextDestroyed',({executionContextId})=>{for(const state of this.frames.values())if(state.cdp===cdp&&state.context===executionContextId)state.context=undefined;});
    cdp.on('Runtime.executionContextsCleared',()=>{for(const state of this.frames.values())if(state.cdp===cdp)state.context=undefined;});
  }
  async resource(url:string):Promise<Buffer|undefined>{
    for(const frame of this.frames.values()){
      try{
        const result=await frame.cdp.send('Page.getResourceContent',{frameId:frame.id,url});
        const size=result.base64Encoded?Math.floor(result.content.length*3/4):Buffer.byteLength(result.content);
        if(size>2*1024*1024+2)return;
        const body=Buffer.from(result.content,result.base64Encoded?'base64':'utf8');
        if(body.length<=2*1024*1024)return body;
      }catch{}
    }
  }
  async inlineResource(hash:string):Promise<string|undefined>{
    // Re-read the live DOM/canvas only on a client cache miss. No data URL is
    // retained in the Node resource registry after its snapshot was sanitized.
    for(const frame of this.frames.values())if(frame.context){
      try{
        const raw=await this.evaluate(frame,'window.__remoteDom.capture()');
        const find=(value:unknown):string|undefined=>{
          if(typeof value==='string'&&value.includes('data:')){for(const match of value.matchAll(/data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/g)){const url=match[0];if(url.length<=2800000&&createHash('sha256').update(url).digest('hex')===hash)return url;}}
          else if(value&&typeof value==='object')for(const child of Object.values(value)){const url=find(child);if(url)return url;}
        };
        for(const node of raw?.nodes??[]){const url=find(node);if(url)return url;}
      }catch{}
    }
  }
  private async discover(){
    const selected=new Map<string,{description:FrameDescription;cdp:CDPSession}>();
    const add=(tree:FrameTree,cdp:CDPSession)=>{selected.set(tree.frame.id,{description:tree.frame,cdp});for(const child of tree.childFrames??[])add(child,cdp);};
    const root=await this.cdp.send('Page.getFrameTree');add(root.frameTree,this.cdp);
    for(const [frame,state]of this.sessions)if(frame.isDetached()){await state.cdp?.detach().catch(()=>{});this.sessions.delete(frame);}
    for(const frame of this.page.frames().slice(1,13)){
      let session=this.sessions.get(frame);
      if(!session||(!session.cdp&&session.url!==frame.url())){
        session={url:frame.url()};this.sessions.set(frame,session);
        try{session.cdp=await this.page.context().newCDPSession(frame);await session.cdp.send('Page.enable');await session.cdp.send('Runtime.enable');this.watch(session.cdp);}catch{session.cdp=undefined;}
      }
      if(session.cdp)try{add((await session.cdp.send('Page.getFrameTree')).frameTree,session.cdp);}catch{session.cdp=undefined;}
    }
    this.watch(this.cdp);
    for(const [id,{description,cdp}]of selected){
      const previous=this.frames.get(id);
      if(!previous||previous.cdp!==cdp)this.frames.set(id,{id,parentId:description.parentId,cdp});
      else previous.parentId=description.parentId;
    }
    for(const [id,frame]of this.frames)if(!selected.has(id)){this.frames.delete(id);this.svgContexts.delete(frame);this.activity.delete(frame);this.hiddenFrames.delete(frame);}
    this.main=this.frames.get(root.frameTree.frame.id)!;
    return [...this.frames.values()].slice(0,13);
  }
  private async context(frame:CaptureFrame){
    if(frame.context)return frame.context;
    const isolated=await frame.cdp.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'remote-dom-engine',grantUniveralAccess:false});
    const result=await frame.cdp.send('Runtime.evaluate',{contextId:isolated.executionContextId,expression:this.source});
    if(result.exceptionDetails)throw new Error('Frame capture initialization failed');
    frame.context=isolated.executionContextId;return frame.context;
  }
  private globalId(frame:CaptureFrame,id:string){
    const key=`${frame.id}:${frame.context}:${id}`;let global=this.ids.get(key);
    this.usedIds.add(key);
    if(!global){global=`n${++this.serial}`;this.ids.set(key,global);}return global;
  }
  async evaluate(frame:CaptureFrame,expression:string){
    if(!frame.context)throw new Error('Frame context is not ready');
    const result=await frame.cdp.send('Runtime.evaluate',{contextId:frame.context,expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error('Frame operation failed');return result.result.value;
  }
  async needsCapture(){
    const elapsed=Date.now()-this.capturedAt;
    // CSSOM edits and roots attached to existing hosts do not necessarily emit
    // observable DOM events. Keep a bounded full-discovery fallback.
    if(elapsed>=750||!this.main||this.page.frames().length!==this.frames.size)return true;
    for(const frame of this.frames.values()){
      if(this.hiddenFrames.has(frame))continue;
      const previous=this.activity.get(frame);if(!frame.context||previous?.context!==frame.context)return true;
      try{const state=await this.evaluate(frame,'window.__remoteDom.activity()');if(!state||state.revision!==previous.revision||state.paint&&elapsed>=180)return true;}catch{return true;}
    }
    return false;
  }
  async capture():Promise<CapturedDocument>{
    this.diagnostics=[];
    this.usedIds.clear();
    this.hiddenFrames.clear();
    const frames=await this.discover();const documents=new Map<string,CapturedDocument>();
    const hiddenOwners=new Map<string,{parent:CaptureFrame;localId:string}>();
    for(const frame of frames){
      try{
        const parent=frame.parentId?this.frames.get(frame.parentId):undefined;
        if(parent?.context){
          const {backendNodeId}=await parent.cdp.send('DOM.getFrameOwner',{frameId:frame.id});
          const {object}=await parent.cdp.send('DOM.resolveNode',{backendNodeId,executionContextId:parent.context});
          if(object.objectId){const result=await parent.cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect(),s=getComputedStyle(this);return {id:window.__remoteDom.idFor(this),hidden:s.display==="none"||s.visibility==="hidden"||r.width<2||r.height<2}}',returnByValue:true});await parent.cdp.send('Runtime.releaseObject',{objectId:object.objectId});
            if(result.result.value?.hidden){this.hiddenFrames.add(frame);hiddenOwners.set(frame.id,{parent,localId:result.result.value.id});continue;}
          }
        }
        const previousContext=frame.context;await this.context(frame);if(previousContext!==frame.context)this.svgContexts.delete(frame);
        const documentObject=await frame.cdp.send('Runtime.evaluate',{contextId:frame.context,expression:'document'});
        if(documentObject.result.objectId){
          const tree=await frame.cdp.send('DOM.describeNode',{objectId:documentObject.result.objectId,depth:32,pierce:true});await frame.cdp.send('Runtime.releaseObject',{objectId:documentObject.result.objectId});
          const closed:number[]=[];const scan=(node:any)=>{for(const root of node.shadowRoots??[]){if(root.shadowRootType==='closed'&&closed.length<32)closed.push(root.backendNodeId);scan(root);}for(const child of node.children??[])scan(child);};scan(tree.node);
          for(const backendNodeId of closed){const resolved=await frame.cdp.send('DOM.resolveNode',{backendNodeId,executionContextId:frame.context});if(resolved.object.objectId){await frame.cdp.send('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:'function(){window.__remoteDom.shadow(this.host,this)}'});await frame.cdp.send('Runtime.releaseObject',{objectId:resolved.object.objectId});}}
        }
        let registered=this.svgContexts.get(frame);if(!registered){registered=new Map();this.svgContexts.set(frame,registered);}
        for(const [url,source]of this.svgSources)if(registered.get(url)!==source){await this.evaluate(frame,`window.__remoteDom.svg(${JSON.stringify(url)},${JSON.stringify(source)})`);registered.set(url,source);}
        const state=await this.evaluate(frame,'window.__remoteDom.activity()');
        const raw=await this.evaluate(frame,'window.__remoteDom.capture()');if(raw?.root){documents.set(frame.id,raw);this.activity.set(frame,{context:frame.context!,revision:state.revision});}
      }
      catch(error){this.diagnostics.push({operation:'capture',error:error instanceof Error?error.message.slice(0,200):'unknown'});frame.context=undefined;if(frame===this.main)throw new Error('Main capture temporarily unavailable');}
    }
    const main=documents.get(this.main.id);if(!main)throw new Error('No main document');
    const translated=new Map<string,CapturedDocument>();const nextRoutes=new Map<string,NodeRoute>();
    for(const frame of frames){const doc=documents.get(frame.id);if(!doc)continue;
      const id=(local:string)=>this.globalId(frame,local);
      const nodes=doc.nodes.map(n=>{const global=id(n.id);nextRoutes.set(global,{frame,localId:n.id});return {...n,id:global,children:n.children?.map(id)};});
      translated.set(frame.id,{...doc,root:id(doc.root),focused:doc.focused?id(doc.focused):null,nodes});
    }
    const windows=new Map<string,CaptureFrame>();const connected=new Set([this.main.id]);
    for(const {parent,localId}of hiddenOwners.values()){
      const owner=translated.get(parent.id)?.nodes.find(n=>n.id===this.globalId(parent,localId));
      if(owner){owner.children=[];owner.attrs={role:'presentation','aria-hidden':'true'};}
    }
    // Associate each child frame with its actual owner element, without URL or
    // ordinal matching (several CAPTCHA frames can share the same URL).
    for(let round=0;round<frames.length;round++)for(const frame of frames){
      if(connected.has(frame.id)||!translated.has(frame.id)||!frame.parentId||!connected.has(frame.parentId))continue;
      const parent=this.frames.get(frame.parentId);if(!parent?.context)continue;
      try{
        const {backendNodeId}=await parent.cdp.send('DOM.getFrameOwner',{frameId:frame.id});
        const {object}=await parent.cdp.send('DOM.resolveNode',{backendNodeId,executionContextId:parent.context});
        if(!object.objectId)continue;
        const result=await parent.cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){return window.__remoteDom.idFor(this)}',returnByValue:true});
        await parent.cdp.send('Runtime.releaseObject',{objectId:object.objectId});
        const localId=result.result.value as string;const global=this.globalId(parent,localId);
        const owner=translated.get(parent.id)!.nodes.find(n=>n.id===global);if(!owner)continue;
        const child=translated.get(frame.id)!;owner.children=[child.root];owner.attrs={...owner.attrs,role:'group','aria-label':child.title||'嵌入页面'};
        owner.style={...owner.style,contain:'layout paint style','overflow-x':'auto','overflow-y':'auto'};
        owner.scrollTop=child.scrollY;owner.scrollLeft=child.scrollX;
        frame.owner={frame:parent,nodeId:localId};windows.set(global,frame);connected.add(frame.id);
      }catch(error){this.diagnostics.push({operation:'owner',error:error instanceof Error?error.message.slice(0,200):'unknown'});/* A navigating frame retains a placeholder. */}
    }
    const combined=translated.get(this.main.id)!;const nodes:MirrorNode[]=[];const unsupported=new Set<string>();
    for(const frame of frames){if(!connected.has(frame.id))continue;const doc=translated.get(frame.id)!;
      nodes.push(...doc.nodes);for(const capability of doc.unsupported)if(capability!=='iframe')unsupported.add(capability);
    }
    // Remove disconnected synthetic placeholder nodes; include only reachable nodes.
    const byId=new Map(nodes.map(n=>[n.id,n]));const reachable=new Set<string>();
    const visit=(id:string)=>{if(reachable.has(id)||!byId.has(id))return;reachable.add(id);for(const child of byId.get(id)!.children??[])visit(child);};visit(combined.root);
    const output=nodes.filter(n=>reachable.has(n.id));
    if(output.some(n=>n.attrs?.['aria-label']==='iframe 暂不支持'))unsupported.add('iframe');
    this.routes=new Map([...nextRoutes].filter(([id])=>reachable.has(id)));this.frameWindows=windows;
    let focused=combined.focused;let focusedFrame=this.main.id;
    for(let step=0;step<frames.length;step++){const child=frames.find(f=>connected.has(f.id)&&f.parentId===focusedFrame&&f.owner&&this.globalId(f.owner.frame,f.owner.nodeId)===focused);if(!child)break;focusedFrame=child.id;focused=translated.get(child.id)?.focused??focused;}
    this.capturedAt=Date.now();
    // Removed nodes and old execution contexts must not accumulate mappings
    // throughout a long-lived logged-in browser. Existing live IDs stay stable.
    for(const key of this.ids.keys())if(!this.usedIds.has(key))this.ids.delete(key);
    return {...combined,focused,nodes:output,unsupported:[...unsupported],truncated:[...translated.values()].some(d=>d.truncated)};
  }
  route(id?:string){return id?this.routes.get(id):{frame:this.main,localId:''};}
  async click(route:NodeRoute,x?:number,y?:number,hover=false,modifiers:{ctrl?:boolean;meta?:boolean;shift?:boolean;alt?:boolean;clickCount?:number}={}){
    const chain:CaptureFrame[]=[];let frame=route.frame;
    while(frame.owner){chain.unshift(frame);frame=frame.owner.frame;}
    if(!hover)for(const child of chain)await this.evaluate(child.owner!.frame,`window.__remoteDom.node(${JSON.stringify(child.owner!.nodeId)})?.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'})`);
    const relativeX=Number.isFinite(x)?Math.max(0,Math.min(1,x!)):.5,relativeY=Number.isFinite(y)?Math.max(0,Math.min(1,y!)):.5;
    const position=await this.evaluate(route.frame,`(()=>{let n=window.__remoteDom.node(${JSON.stringify(route.localId)});if(!(n instanceof Element))return null;while(n&&(!n.getBoundingClientRect().width||!n.getBoundingClientRect().height))n=n.parentElement??n.getRootNode().host;if(!n)return null;${hover?'':"n.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});"}const r=n.getBoundingClientRect();return {x:r.x+r.width*${relativeX},y:r.y+r.height*${relativeY}};})()`);
    if(!position)throw new Error('Missing node');
    for(const child of chain){const offset=await this.evaluate(child.owner!.frame,`(()=>{const n=window.__remoteDom.node(${JSON.stringify(child.owner!.nodeId)});const r=n.getBoundingClientRect();return {x:r.left+n.clientLeft,y:r.top+n.clientTop};})()`);position.x+=offset.x;position.y+=offset.y;}
    if(hover){await this.page.mouse.move(position.x,position.y);return;}
    const keys=[modifiers.ctrl||modifiers.meta?'Control':'',modifiers.shift?'Shift':'',modifiers.alt?'Alt':''].filter(Boolean);
    try{for(const key of keys)await this.page.keyboard.down(key);
      if((modifiers.clickCount??1)>1){
        // The first click was already forwarded. Dispatch only this second
        // down/up pair with its native count, rather than clicking twice again.
        await this.page.mouse.move(position.x,position.y);await this.page.mouse.down({clickCount:modifiers.clickCount});await this.page.mouse.up({clickCount:modifiers.clickCount});
      }else await this.page.mouse.click(position.x,position.y);
    }finally{for(const key of keys.reverse())await this.page.keyboard.up(key);}
  }
}

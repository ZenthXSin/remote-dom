import {STYLE_DEFAULTS,SAFE_TAGS,SAFE_ATTRS,SVG_TAGS,SVG_ATTRS,STYLE_PROPERTIES,type MirrorNode,type Snapshot,type Patch,type UserEvent} from '../shared/protocol.js';
import {MirrorRules} from './rules.js';
import {collectNodeAssets} from '../shared/assets.js';
const mount=document.getElementById('mirror-root')!;
const nodes=new Map<string,Node>();const reverse=new WeakMap<Node,string>();
const records=new Map<string,MirrorNode>();const assets=new Map<string,string>();
const properties=new Set<string>(STYLE_PROPERTIES);
const dirty=new Map<string,number>();let port:MessagePort;let epoch='';let seq=-1;let eventId=0;
const inputAcks=new Map<number,number>();let inputRevision=-1;let currentRoot='';
let applying=false,composing=false;let renderWork=Promise.resolve();
function scheduleWork(work:()=>void|Promise<void>){renderWork=renderWork.then(work).catch(()=>port.postMessage({type:'resync'}));}
function yieldToBrowser(){return new Promise<void>(resolve=>setTimeout(resolve,0));}
let inputTimer:ReturnType<typeof setTimeout>|undefined;
let pendingInput:HTMLElement|undefined;
const editableIntents=new Map<string,{value:string;at:number;eventId:number}>();
const fontFaces=new Map<string,FontFace>();
let currentFonts:NonNullable<Snapshot['fontFaces']>=[];
const assetNodes=new Map<string,Set<string>>();const nodeAssets=new Map<string,string[]>();
let assetVersion=0;let assetPaint:number|undefined;const pendingAssets=new Set<string>();
let findQuery='';let findIndex=-1;
function findText(query:string,direction:number){
  const textNodes:Text[]=[];const walker=document.createTreeWalker(mount,NodeFilter.SHOW_TEXT);let text='';
  while(walker.nextNode()){const node=walker.currentNode as Text;const parent=node.parentElement;if(!parent||parent.closest('textarea,script,style')||!parent.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))continue;textNodes.push(node);text+=node.data;if(text.length>1024*1024)break;}
  const matches:number[]=[];query=query.slice(0,200);if(query){const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');for(const match of text.matchAll(new RegExp(escaped,'giu'))){matches.push(match.index);if(matches.length>=500)break;}}
  if(query!==findQuery){findIndex=0;findQuery=query;}else if(direction)findIndex=(findIndex+direction+matches.length)%Math.max(1,matches.length);findIndex=Math.max(0,Math.min(findIndex,matches.length-1));
  if(matches.length){const position=(offset:number):[Node,number]=>{for(const node of textNodes){if(offset<=node.length)return [node,offset];offset-=node.length;}return [mount,mount.childNodes.length];};const range=document.createRange();range.setStart(...position(matches[findIndex]));range.setEnd(...position(matches[findIndex]+query.length));const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);const start=range.startContainer.parentElement;start?.scrollIntoView({block:'center',behavior:'instant'});}
  else getSelection()?.removeAllRanges();port.postMessage({type:'find-result',total:matches.length,index:matches.length?findIndex+1:0});
}
const mediaExpected=new WeakMap<HTMLMediaElement,Record<string,number|boolean>>();
const backdropSheet=document.createElement('style');document.head.append(backdropSheet);
const mirrorRules=new MirrorRules(backdropSheet.sheet!,resolveValue);
const scrollIntents=new Map<string,{x:number;y:number;at:number}>();
const expectedScrolls=new Map<string,{x:number;y:number;at:number}>();
let gestureUntil=0;
let zoom=1;
let bodyScrollsWindow=false;
let pointerGesture:{id:number;x:number;y:number;dragging:boolean}|undefined;let pointerWaiting=0;let pointerPending:{x:number;y:number}|undefined;let suppressClickUntil=0;
let pendingHover:{nodeId:string;x:number;y:number}|undefined;
let lastHover:{nodeId:string;x:number;y:number}|undefined;
let hoverWaiting=0;let hoverTimer:ReturnType<typeof setTimeout>|undefined;
const scrollKey=(node:HTMLElement|undefined)=>node?reverse.get(node)??'window':'window';
function ownsScroll(key:string,x:number,y:number){
  if(performance.now()<gestureUntil)return true;
  const intent=scrollIntents.get(key);if(!intent)return false;
  if(performance.now()-intent.at>5000){scrollIntents.delete(key);return false;}
  // Keep locally initiated movement until the authority has caught up, including
  // momentum scrolling and delayed HTTP updates. Do not rubber-band to stale data.
  if(Math.abs(intent.x-x)<2&&Math.abs(intent.y-y)<2&&performance.now()-intent.at>160){scrollIntents.delete(key);return false;}
  return true;
}
function reset(clearAssets=false){clearTimeout(scrollTimer);scrollTimer=undefined;pendingScrolls.clear();clearTimeout(inputTimer);clearTimeout(hoverTimer);if(assetPaint!==undefined)cancelAnimationFrame(assetPaint);assetPaint=undefined;pendingAssets.clear();assetNodes.clear();nodeAssets.clear();mirrorRules.clear();for(const face of fontFaces.values())document.fonts.delete(face);fontFaces.clear();currentFonts=[];pendingInput=undefined;pendingHover=undefined;lastHover=undefined;hoverWaiting=0;pointerGesture=undefined;pointerPending=undefined;pointerWaiting=0;composing=false;mount.replaceChildren();nodes.clear();records.clear();dirty.clear();inputAcks.clear();inputRevision=-1;currentRoot='';editableIntents.clear();scrollIntents.clear();expectedScrolls.clear();epoch='';seq=-1;if(clearAssets){for(const url of assets.values())URL.revokeObjectURL(url);assets.clear();}}
function emit(event:Omit<UserEvent,'type'|'epoch'|'eventId'>){if(!epoch)return 0;const id=++eventId;port.postMessage({type:'event',epoch,eventId:id,...event});return id;}
function retireInputs(){const released:string[]=[];for(const [id,sent]of dirty){const revision=inputAcks.get(sent);if(revision!==undefined&&inputRevision>=revision){dirty.delete(id);editableIntents.delete(id);inputAcks.delete(sent);released.push(id);}}const pending=new Set(dirty.values());for(const event of inputAcks.keys())if(!pending.has(event))inputAcks.delete(event);return released;}
function idFor(target:EventTarget|null){let n=target as Node|null;while(n&&!reverse.has(n))n=n.parentNode;return n?reverse.get(n):undefined;}
function pointerNode(target:EventTarget|null){let node=target instanceof Node?target:undefined;while(node){if(node instanceof Element&&reverse.has(node)){const rect=node.getBoundingClientRect();if(rect.width>0&&rect.height>0)return {nodeId:reverse.get(node)!,rect};}node=node.parentNode??undefined;}return;}
function editableTarget(target:EventTarget|null){return target instanceof HTMLElement?target.closest<HTMLElement>('[contenteditable="plaintext-only"]')??undefined:undefined;}
function input(){
  flushScroll();
  clearTimeout(inputTimer);const target=pendingInput;pendingInput=undefined;if(!target)return;
  const id=reverse.get(target);if(!id)return;
  let value:string,start:number|undefined,end:number|undefined;
  if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement){value=target.value;start=target.selectionStart??undefined;end=target.selectionEnd??undefined;}
  else{value=target.innerText;const selection=getSelection();if(selection?.anchorNode&&selection.focusNode&&target.contains(selection.anchorNode)&&target.contains(selection.focusNode)){
    const offset=(node:Node,offset:number)=>{const range=document.createRange();range.selectNodeContents(target);range.setEnd(node,offset);return range.toString().length;};
    start=offset(selection.anchorNode,selection.anchorOffset);end=offset(selection.focusNode,selection.focusOffset);if(start>end)[start,end]=[end,start];
  }}
  const sent=emit({action:'input',nodeId:id,value,selectionStart:start,selectionEnd:end});dirty.set(id,sent);
  if(target.isContentEditable)editableIntents.set(id,{value,at:performance.now(),eventId:sent});
}
function resolveValue(value:string){
  let valid=true;
  const result=value.replace(/url\(\s*["']?asset:([a-f0-9-]+)["']?\s*\)/gi,(_,id)=>{const blob=assets.get(id);if(!blob){valid=false;return 'none';}return `url("${blob}")`;});
  const remaining=result.replace(/url\("(blob:[^"]+)"\)/gi,(_whole,url)=>{if(![...assets.values()].includes(url))valid=false;return '';});
  if(/url\s*\(|expression\s*\(|@import|javascript:/i.test(remaining))valid=false;
  return valid?result:undefined;
}
function unindexAssets(id:string){for(const asset of nodeAssets.get(id)??[]){const users=assetNodes.get(asset);users?.delete(id);if(!users?.size)assetNodes.delete(asset);}nodeAssets.delete(id);}
function indexRecord(record:MirrorNode){
  unindexAssets(record.id);const ids=[...collectNodeAssets([record])];
  if(ids.length)nodeAssets.set(record.id,ids);for(const id of ids){let users=assetNodes.get(id);if(!users){users=new Set();assetNodes.set(id,users);}users.add(record.id);}
}
function syncFonts(fonts:NonNullable<Snapshot['fontFaces']>){
  currentFonts=fonts;const wanted=new Set(fonts.map(font=>JSON.stringify(font)));
  for(const [key,face]of fontFaces)if(!wanted.has(key)){document.fonts.delete(face);fontFaces.delete(key);}
  for(const font of fonts){
    const id=font.assetUrl.match(/^asset:([a-f0-9-]+)$/)?.[1],url=id?assets.get(id):undefined;
    if(!url||!font.family||font.family.length>200||!/^(normal|italic|oblique)$/.test(font.style)||!/^(normal|bold|[1-9]00(?: [1-9]00)?)$/.test(font.weight))continue;
    const key=JSON.stringify(font);if(fontFaces.has(key))continue;
    try{const face=new FontFace(font.family,`url("${url}")`,{style:font.style,weight:font.weight,unicodeRange:font.unicodeRange??'U+0-10FFFF',display:'swap'});fontFaces.set(key,face);document.fonts.add(face);void face.load().catch(()=>{});}catch{}
  }
}
function releaseUnusedAssets(){
  const fonts=new Set(currentFonts.map(font=>font.assetUrl.slice('asset:'.length))),released:string[]=[];
  for(const [id,url]of assets)if(!assetNodes.has(id)&&!fonts.has(id)){URL.revokeObjectURL(url);assets.delete(id);pendingAssets.delete(id);released.push(id);}
  if(released.length)port.postMessage({type:'release-assets',ids:released});
}
async function paintAssets(){
  assetPaint=undefined;const affected=new Set<string>();for(const id of pendingAssets)for(const node of assetNodes.get(id)??[])affected.add(node);pendingAssets.clear();
  syncFonts(currentFonts);const changed=[...affected].flatMap(id=>{const record=records.get(id);return record?[record]:[];});if(changed.length&&currentRoot)await applyRecords(changed,[],currentRoot);releaseUnusedAssets();
}
async function applyRecords(upserts:MirrorNode[],remove:string[],root:string){
  applying=true;let sliceStart=performance.now();
  const checkpoint=async()=>{await yieldToBrowser();sliceStart=performance.now();};
  try{
    for(const record of upserts){records.set(record.id,record);indexRecord(record);}
    const protectedNodes=new Set<string>();
    const protect=(id:string)=>{if(protectedNodes.has(id))return;protectedNodes.add(id);for(const child of records.get(id)?.children??[])protect(child);};
    for(const [id,intent]of editableIntents){if(!dirty.has(id)||performance.now()-intent.at>10000){editableIntents.delete(id);dirty.delete(id);}else protect(id);}
    // Keep the local caret and IME text while focused; native remote input still
    // updates the authoritative editor and all surrounding UI.
    const active=editableTarget(document.activeElement);const activeId=active?reverse.get(active):undefined;
    if(activeId&&(composing||dirty.has(activeId)))protect(activeId);
    for(const id of remove){const node=nodes.get(id);if(!(activeId&&protectedNodes.has(activeId)&&node&&active?.contains(node)))node?.parentNode?.removeChild(node);nodes.delete(id);records.delete(id);dirty.delete(id);unindexAssets(id);mirrorRules.remove(id);}
    for(const record of upserts){
      if(performance.now()-sliceStart>8)await checkpoint();
      let node=nodes.get(record.id);let replaced:Node|undefined;
      const tag=record.namespace==='svg'&&SVG_TAGS.has(record.tag??'')?record.tag:SAFE_TAGS.has(record.tag??'')?record.tag:'div';
      if(node&&(record.kind==='text'?node.nodeType!==Node.TEXT_NODE:!(node instanceof Element)||node.localName!==tag||(record.namespace==='svg')!==(node.namespaceURI==='http://www.w3.org/2000/svg'))){replaced=node;reverse.delete(node);nodes.delete(record.id);node=undefined;}
      if(!node){node=record.kind==='text'?document.createTextNode(''):record.namespace==='svg'&&SVG_TAGS.has(record.tag??'')?document.createElementNS('http://www.w3.org/2000/svg',record.tag!):document.createElement(SAFE_TAGS.has(record.tag??'')?record.tag!:'div');nodes.set(record.id,node);reverse.set(node,record.id);if(replaced?.parentNode)replaced.parentNode.replaceChild(node,replaced);}
      records.set(record.id,record);
      if(record.kind==='text'){if(!protectedNodes.has(record.id)&&node.textContent!==record.text)node.textContent=record.text??'';continue;}
      if(!(node instanceof HTMLElement||node instanceof SVGElement))continue;
      if(node instanceof HTMLDialogElement&&node.matches(':modal')&&record.topLayer!=='modal')node.close();
      if(node instanceof HTMLElement&&node.matches(':popover-open')&&record.topLayer!=='popover')node.hidePopover();
      const wanted=new Map(Object.entries(record.attrs??{}).filter(([key,value])=>SAFE_ATTRS.has(key)||(node instanceof SVGElement&&SVG_ATTRS.has(key)&&value.length<=16384&&!/url\s*\(|javascript:|data:|[<>]/i.test(value))));
      wanted.set('data-rd-node',record.id);
      if(record.topLayer){wanted.set('data-rd-layer',record.id);if(record.topLayer==='popover')wanted.set('popover','manual');else if(!node.matches(':modal'))wanted.delete('open');}
      if(record.editable&&node instanceof HTMLElement)wanted.set('contenteditable','plaintext-only');
      for(const attr of Array.from(node.attributes))if(attr.name!=='style'&&attr.name!=='src'&&!wanted.has(attr.name))node.removeAttribute(attr.name);
      for(const [key,value]of wanted)if(node.getAttribute(key)!==value)node.setAttribute(key,value);
      const styles={...STYLE_DEFAULTS,...record.style};if(record.id===root&&bodyScrollsWindow){styles['overflow-x']='visible';styles['overflow-y']='visible';}
      for(const key of Array.from(node.style))if(!(key in styles))node.style.removeProperty(key);
      for(const [key,value]of Object.entries(styles)){if(!properties.has(key))continue;const safe=resolveValue(value);if(safe!==undefined){if(node.style.getPropertyValue(key)!==safe)node.style.setProperty(key,safe);}else node.style.removeProperty(key);}
      if(node instanceof HTMLImageElement){const id=record.assetUrl?.match(/^asset:([a-f0-9-]+)$/)?.[1];const url=id?assets.get(id):undefined;if(url&&node.src!==url)node.src=url;else if(!url)node.removeAttribute('src');}
      if(node instanceof HTMLMediaElement&&record.media&&!dirty.has(record.id)){
        const media=record.media,id=record.assetUrl?.match(/^asset:([a-f0-9-]+)$/)?.[1],url=id?assets.get(id):undefined;
        node.controls=true;node.setAttribute('controlslist','nodownload nofullscreen noremoteplayback');node.disableRemotePlayback=true;
        if(url&&node.src!==url){node.src=url;node.preload='auto';}
        const expected=mediaExpected.get(node)??{};mediaExpected.set(node,expected);
        if(Math.abs(node.volume-media.volume)>.01){expected.volume=media.volume;node.volume=media.volume;}
        if(node.muted!==media.muted){expected.muted=media.muted;node.muted=media.muted;}
        if(node.playbackRate!==media.playbackRate){expected.rate=media.playbackRate;node.playbackRate=media.playbackRate;}
        node.loop=media.loop;
        if(node.readyState>0&&Math.abs(node.currentTime-media.currentTime)>1.5){expected.seek=media.currentTime;node.currentTime=media.currentTime;}
        if(node.paused!==media.paused){expected.paused=media.paused;if(media.paused)node.pause();else void node.play().catch(()=>{});}
      }
      if(node instanceof HTMLOptionElement&&record.value!==undefined)node.value=record.value;
      if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement){if(record.value!==undefined&&!dirty.has(record.id)&&node.value!==record.value)node.value=record.value;if(node instanceof HTMLInputElement&&record.checked!==undefined)node.checked=record.checked;}
    }
    // Place nodes after creating the entire batch; this supports moves and forward references.
    for(const record of upserts){if(performance.now()-sliceStart>8)await checkpoint();const node=nodes.get(record.id);if(record.kind!=='element'||!node||protectedNodes.has(record.id))continue;const wanted=(record.children??[]).map(id=>nodes.get(id)).filter((n):n is Node=>!!n);for(let i=0;i<wanted.length;i++)if(node.childNodes[i]!==wanted[i])node.insertBefore(wanted[i],node.childNodes[i]??null);while(node.childNodes.length>wanted.length)node.removeChild(node.lastChild!);}
    const rootNode=nodes.get(root);if(rootNode&&mount.firstChild!==rootNode)mount.replaceChildren(rootNode);
    for(const record of upserts){if(performance.now()-sliceStart>8)await checkpoint();mirrorRules.sync(record,assetVersion);}
    for(const [id,record]of records){if(!record.topLayer)continue;const node=nodes.get(id);if(!(node instanceof HTMLElement)||!node.isConnected)continue;
      try{if(record.topLayer==='modal'&&node instanceof HTMLDialogElement&&!node.matches(':modal')){node.removeAttribute('open');node.showModal();}else if(record.topLayer==='popover'&&!node.matches(':popover-open'))node.showPopover();}catch{}
    }
    for(const record of upserts){const node=nodes.get(record.id);if(node instanceof HTMLElement&&!ownsScroll(record.id,record.scrollLeft??0,record.scrollTop??0)){
      const x=record.scrollLeft??node.scrollLeft,y=record.scrollTop??node.scrollTop;
      if(Math.abs(node.scrollTop-y)>1||Math.abs(node.scrollLeft-x)>1){expectedScrolls.set(record.id,{x,y,at:performance.now()});node.scrollTo(x,y);}
    }if(node instanceof HTMLSelectElement&&record.selectedIndex!==undefined&&!dirty.has(record.id))node.selectedIndex=record.selectedIndex;}
  }finally{requestAnimationFrame(()=>{applying=false;});}
}
async function update(message:(Snapshot|Patch)&{renderToken?:number}){
  bodyScrollsWindow=message.bodyScrollsWindow===true;
  for(const key of ['overflow-x','overflow-y','direction','writing-mode','color-scheme']){const value=message.viewportStyle?.[key];if(value!==undefined)document.documentElement.style.setProperty(key,value);else document.documentElement.style.removeProperty(key);}
  document.documentElement.lang=message.language??'';
  if(message.type==='snapshot'){
    const sameDocument=message.epoch===epoch;
    if(sameDocument&&message.seq<seq){port.postMessage({type:'rendered',epoch,seq,nodeCount:nodes.size,renderToken:message.renderToken});return;}
    const present=new Set(message.nodes.map(n=>n.id));
    const remove=sameDocument?[...nodes.keys()].filter(id=>!present.has(id)):[];
    if(!sameDocument)reset();
    currentRoot=message.root;inputRevision=message.inputRevision??-1;retireInputs();
    epoch=message.epoch;seq=message.seq;await applyRecords(message.nodes,remove,message.root);
  }
  else {if(message.epoch!==epoch||message.base!==seq){port.postMessage({type:'resync'});return;}inputRevision=message.inputRevision??-1;const released=retireInputs();seq=message.seq;const changed=new Map(message.upsert.map(n=>[n.id,n]));for(const id of released){const add=(id:string)=>{const record=changed.get(id)??records.get(id);if(record){changed.set(id,record);for(const child of record.children??[])add(child);}};add(id);}await applyRecords([...changed.values()],message.remove,message.root);}
  syncFonts(message.fontFaces??[]);releaseUnusedAssets();
  if(document.hasFocus()&&!dirty.size&&message.focused){const node=nodes.get(message.focused);if(node instanceof HTMLElement&&document.activeElement!==node)node.focus({preventScroll:true});}
  if(document.hasFocus()&&message.focused&&!dirty.has(message.focused)&&!composing){const record=records.get(message.focused),node=nodes.get(message.focused);if(record?.selectionStart!==undefined&&record.selectionEnd!==undefined){try{if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement)node.setSelectionRange(record.selectionStart,record.selectionEnd);else if(node instanceof HTMLElement&&node.isContentEditable){const walk=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);const text:Node[]=[];while(walk.nextNode())text.push(walk.currentNode);const position=(offset:number):[Node,number]=>{for(const item of text){if(offset<=(item.textContent?.length??0))return [item,offset];offset-=item.textContent?.length??0;}return [node,node.childNodes.length];};const range=document.createRange();range.setStart(...position(record.selectionStart));range.setEnd(...position(record.selectionEnd));const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);}}catch{}}}
  const x=message.scrollX*zoom,y=message.scrollY*zoom;
  if(!ownsScroll('window',x,y)&&(Math.abs(window.scrollY-y)>2||Math.abs(window.scrollX-x)>2)){expectedScrolls.set('window',{x,y,at:performance.now()});window.scrollTo(x,y);}
  port.postMessage({type:'rendered',epoch,seq,nodeCount:nodes.size,renderToken:message.renderToken});
}
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.type!=='initialize'||!event.ports[0]||port)return;
  port=event.ports[0];port.onmessage=event=>{const message=event.data;scheduleWork(async()=>{
    if(message.type==='find'){findText(String(message.query??''),Number(message.direction)||0);return;}
    if(message.type==='zoom'){
      const next=Math.max(.1,Math.min(4,Number(message.scale)||1));
      const x=scrollX/zoom*next,y=scrollY/zoom*next;zoom=next;mount.style.setProperty('zoom',String(zoom));mount.style.minHeight=`${100/zoom}vh`;
      gestureUntil=performance.now()+300;scrollIntents.set('window',{x,y,at:performance.now()});window.scrollTo(x,y);return;
    }
    if(message.type==='asset'){if(assets.has(message.id))return;assets.set(message.id,URL.createObjectURL(new Blob([message.bytes],{type:message.mime})));assetVersion++;pendingAssets.add(message.id);if(assetPaint===undefined)assetPaint=requestAnimationFrame(()=>scheduleWork(paintAssets));return;}
    if(message.type==='snapshot'||message.type==='patch')await update(message);
    if(message.type==='reset')reset(true);
    if(message.type==='ack'||message.type==='error'){
      if(message.type==='error')lastHover=undefined;
      if(pointerWaiting===message.eventId){pointerWaiting=0;sendPointerMove();}
      if(hoverWaiting===message.eventId){hoverWaiting=0;clearTimeout(hoverTimer);hoverTimer=setTimeout(sendHover,100);}
      if(message.type==='ack'&&message.inputRevision!==undefined){if([...dirty.values()].includes(message.eventId))inputAcks.set(message.eventId,message.inputRevision);const released=retireInputs();const changed=new Map<string,MirrorNode>();const add=(id:string)=>{const record=records.get(id);if(record&&!changed.has(id)){changed.set(id,record);for(const child of record.children??[])add(child);}};for(const id of released)add(id);if(changed.size)await applyRecords([...changed.values()],[],currentRoot);}
      else for(const [id,sent]of dirty)if(sent===message.eventId&&!editableIntents.has(id))dirty.delete(id);
      if(message.type==='error')for(const [id,intent]of editableIntents)if(intent.eventId===message.eventId){editableIntents.delete(id);dirty.delete(id);port.postMessage({type:'resync'});}
    }
  });};
  port.start();port.postMessage({type:'ready'});
});
document.addEventListener('click',event=>{
  if(performance.now()<suppressClickUntil){event.preventDefault();return;}
  const target=pointerNode(event.target);if(!target)return;input();
  const control=nodes.get(target.nodeId);if(control instanceof HTMLMediaElement)return;if(control instanceof HTMLSelectElement||control instanceof HTMLInputElement&&['range','color','date','time','datetime-local','month','week'].includes(control.type)){emit({action:'focus',nodeId:target.nodeId});return;}
  event.preventDefault();
  const {nodeId,rect}=target;
  // A native remote click already moves its pointer to this position. Sending
  // the preceding deferred hover afterwards only blocks the next interaction.
  lastHover={nodeId,x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
  pendingHover=undefined;clearTimeout(hoverTimer);
  const button=(event.target as Element)?.closest('button,[role="button"],a');const label=(button?.getAttribute('aria-label')??'')+' '+(button?.textContent??'');
  emit({action:'click',nodeId,x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height,clickCount:Math.max(1,Math.min(3,event.detail)),ctrl:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,alt:event.altKey,clipboard:/\bcopy\b|复制|複製/i.test(label)});
},true);
function sameHover(hover:{nodeId:string;x:number;y:number}){return lastHover?.nodeId===hover.nodeId&&Math.abs(lastHover.x-hover.x)<.0001&&Math.abs(lastHover.y-hover.y)<.0001;}
function sendHover(){if(hoverWaiting||!pendingHover||!epoch)return;const hover=pendingHover;pendingHover=undefined;if(sameHover(hover))return;lastHover=hover;hoverWaiting=emit({action:'hover',...hover});hoverTimer=setTimeout(()=>{hoverWaiting=0;sendHover();},2500);}
document.addEventListener('mousemove',event=>{if(pointerGesture){lastHover=undefined;return;}const target=pointerNode(event.target);if(!target){lastHover=undefined;return;}const {nodeId,rect}=target;const hover={nodeId,x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};if(sameHover(hover)){pendingHover=undefined;if(!hoverWaiting)clearTimeout(hoverTimer);return;}pendingHover=hover;if(!hoverWaiting){clearTimeout(hoverTimer);hoverTimer=setTimeout(sendHover,100);}});
document.addEventListener('submit',event=>event.preventDefault());
document.addEventListener('compositionstart',()=>{composing=true;});
document.addEventListener('compositionend',event=>{composing=false;const target=editableTarget(event.target)??event.target;if(target instanceof HTMLElement&&(target.isContentEditable||target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement)){pendingInput=target;input();}});
document.addEventListener('input',event=>{
  const target=editableTarget(event.target)??event.target;if(!(target instanceof HTMLElement)||(!(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement)&&!target.isContentEditable)||(target instanceof HTMLInputElement&&!['text','password','email','search','url','tel','number'].includes(target.type)))return;
  const id=reverse.get(target);if(!id)return;dirty.set(id,Number.MAX_SAFE_INTEGER);pendingInput=target;clearTimeout(inputTimer);if(!composing)inputTimer=setTimeout(input,45);
});
document.addEventListener('focusout',event=>{if(editableTarget(event.target))setTimeout(()=>port.postMessage({type:'resync'}),0);});
function selectControl(event:Event){const target=event.target;if(target instanceof HTMLSelectElement||target instanceof HTMLInputElement&&['range','color','date','time','datetime-local','month','week'].includes(target.type)){const id=reverse.get(target);if(id)dirty.set(id,emit({action:'select',nodeId:id,value:target.value}));}}
document.addEventListener('change',selectControl);document.addEventListener('input',event=>{if(event.target instanceof HTMLInputElement&&event.target.type==='range')selectControl(event);});
document.addEventListener('keydown',event=>{
  if(composing||event.isComposing)return;
  const target=event.target;const editing=target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||!!editableTarget(target);
  const command=event.ctrlKey||event.metaKey;
  if(command&&event.key.toLowerCase()==='f'){event.preventDefault();port.postMessage({type:'open-find'});return;}
  if(command&&event.key.toLowerCase()==='l'){event.preventDefault();port.postMessage({type:'focus-address'});return;}
  if(event.altKey&&['ArrowLeft','ArrowRight'].includes(event.key)||event.key==='F5'||command&&event.key.toLowerCase()==='r'){event.preventDefault();input();emit({action:'navigation',key:event.key==='ArrowLeft'?'back':event.key==='ArrowRight'?'forward':'reload'});return;}
  if(command&&['a','c','v','x','z','y'].includes(event.key.toLowerCase()))return;
  const mandatory=['Enter','Tab','Escape'].includes(event.key);
  const movement=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key);
  if(!mandatory&&!movement&&!command&&!event.altKey&&editing)return;
  if(!/^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete|F[1-9]|F1[0-2]|[\x20-\x7e])$/.test(event.key))return;
  if(mandatory||command||event.altKey||!editing)event.preventDefault();input();emit({action:'key',nodeId:idFor(event.target),key:event.key,shift:event.shiftKey,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey});
});
let scrollTimer:ReturnType<typeof setTimeout>|undefined;
const pendingScrolls=new Map<string,{nodeId?:string;x:number;y:number}>();
function flushScroll(){
  clearTimeout(scrollTimer);scrollTimer=undefined;
  for(const scroll of pendingScrolls.values())emit({action:'scroll',...scroll});
  pendingScrolls.clear();
}
for(const event of ['wheel','touchstart','touchmove','touchend'])document.addEventListener(event,()=>{gestureUntil=performance.now()+300;},{passive:true,capture:true});
document.addEventListener('scroll',event=>{
  const node=event.target instanceof HTMLElement?event.target:undefined;
  const x=node?.scrollLeft??window.scrollX,y=node?.scrollTop??window.scrollY;
  const key=scrollKey(node);const expected=expectedScrolls.get(key);
  if(expected&&performance.now()-expected.at<700&&Math.abs(expected.x-x)<2&&Math.abs(expected.y-y)<2){expectedScrolls.delete(key);return;}
  scrollIntents.set(key,{x,y,at:performance.now()});
  pendingScrolls.set(key,{nodeId:node?reverse.get(node):undefined,x:node?x:x/zoom,y:node?y:y/zoom});
  if(!scrollTimer)scrollTimer=setTimeout(flushScroll,45);
},true);

for(const kind of ['play','pause','seeking','volumechange','ratechange'])document.addEventListener(kind,event=>{
  const node=event.target;if(!(node instanceof HTMLMediaElement))return;const nodeId=reverse.get(node);if(!nodeId)return;
  const expected=mediaExpected.get(node)??{};
  if(kind==='play'||kind==='pause'){if(expected.paused===node.paused){delete expected.paused;return;}dirty.set(nodeId,emit({action:'media',nodeId,key:kind}));}
  else if(kind==='seeking'){if(typeof expected.seek==='number'&&Math.abs(expected.seek-node.currentTime)<.3){delete expected.seek;return;}dirty.set(nodeId,emit({action:'media',nodeId,key:'seek',mediaValue:node.currentTime}));}
  else if(kind==='ratechange'){if(expected.rate===node.playbackRate){delete expected.rate;return;}dirty.set(nodeId,emit({action:'media',nodeId,key:'rate',mediaValue:node.playbackRate}));}
  else{if(expected.volume===node.volume||expected.muted===node.muted){delete expected.volume;delete expected.muted;return;}emit({action:'media',nodeId,key:'volume',mediaValue:node.volume});dirty.set(nodeId,emit({action:'media',nodeId,key:'muted',accept:node.muted}));}
},true);

function sendPointerMove(){if(pointerWaiting||!pointerGesture?.dragging||!pointerPending)return;const point=pointerPending;pointerPending=undefined;pointerWaiting=emit({action:'pointer',key:'move',x:point.x/zoom,y:point.y/zoom});}
document.addEventListener('dragstart',event=>event.preventDefault());
document.addEventListener('pointerdown',event=>{if(event.button!==0||!['mouse','pen'].includes(event.pointerType)||(event.target as Element)?.closest('input,textarea,select,audio,video,[contenteditable]'))return;pointerGesture={id:event.pointerId,x:event.clientX,y:event.clientY,dragging:false};},true);
document.addEventListener('pointermove',event=>{const gesture=pointerGesture;if(!gesture||event.pointerId!==gesture.id||!(event.buttons&1))return;if(!gesture.dragging&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<5)return;
  if(!gesture.dragging){gesture.dragging=true;input();pendingHover=undefined;emit({action:'pointer',key:'down',x:gesture.x/zoom,y:gesture.y/zoom});(event.target as Element)?.setPointerCapture?.(event.pointerId);}event.preventDefault();pointerPending={x:event.clientX,y:event.clientY};sendPointerMove();},true);
function finishPointer(event:PointerEvent){const gesture=pointerGesture;if(!gesture||gesture.id!==event.pointerId)return;if(gesture.dragging){event.preventDefault();emit({action:'pointer',key:'up',x:event.clientX/zoom,y:event.clientY/zoom});suppressClickUntil=performance.now()+300;}pointerGesture=undefined;pointerPending=undefined;}
document.addEventListener('pointerup',finishPointer,true);document.addEventListener('pointercancel',finishPointer,true);

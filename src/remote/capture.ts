import {STYLE_DEFAULTS,STYLE_PROPERTIES,SAFE_ATTRS,SAFE_TAGS,SVG_TAGS,SVG_ATTRS,type CapturedDocument,type MirrorNode} from '../shared/protocol.js';
declare global {interface Window {__remoteDom:{capture:()=>CapturedDocument;activity:()=>{revision:number;paint:boolean};dispose:()=>void;node:(id:string)=>Node|undefined;idFor:(node:Node)=>string;svg:(url:string,source:string)=>void;shadow:(host:Element,root:ShadowRoot)=>void}}}
window.__remoteDom?.dispose?.();
let activityRevision=0,continuousPaint=false,controlState='';
const observers:MutationObserver[]=[];const observed=new WeakSet<Node>();const roots:(Document|ShadowRoot)[]=[];
const changed=()=>{activityRevision++;};
const activityEvents=['input','change','scroll','focusin','focusout','load','toggle','animationstart','animationend','transitionrun','transitionend','play','pause','seeked','timeupdate','volumechange','ratechange'];
function watch(root:Document|ShadowRoot){
  if(observed.has(root)||roots.length>=128)return;observed.add(root);roots.push(root);
  const observer=new MutationObserver(changed);observer.observe(root,{subtree:true,attributes:true,childList:true,characterData:true});observers.push(observer);
  for(const event of activityEvents)root.addEventListener(event,changed,true);
}
function releaseDetachedRoots(){
  for(let index=roots.length-1;index>=0;index--){const root=roots[index];if(!(root instanceof ShadowRoot)||root.host.isConnected)continue;observers[index].disconnect();observers.splice(index,1);for(const event of activityEvents)root.removeEventListener(event,changed,true);roots.splice(index,1);observed.delete(root);}
}
watch(document);window.addEventListener('resize',changed);document.fonts.addEventListener('loadingdone',changed);
const ids=new WeakMap<Node,string>();
let serial=0;
let live=new Map<string,Node>();
const idFor=(node:Node)=>{let id=ids.get(node);if(!id){id=`n${++serial}`;ids.set(node,id);}return id;};
const svgDocuments=new Map<string,Document>();
const closedRoots=new WeakMap<Element,ShadowRoot>();
const referenceIds=new WeakMap<Node,WeakMap<Node,string>>();
const referenceId=(owner:Node,node:Node)=>{let map=referenceIds.get(owner);if(!map){map=new WeakMap();referenceIds.set(owner,map);}let id=map.get(node);if(!id){id=`n${++serial}`;map.set(node,id);}return id;};
const skipped=new Set(['script','style','link','meta','base','noscript','template','head']);
const unsupportedTags=new Set(['iframe','canvas','video','audio','object','embed']);

window.__remoteDom={
  idFor,
  activity:()=>{
    releaseDetachedRoots();
    // Native property changes (value/checked) need not produce DOM mutations.
    // Compare locally; no raw control contents leave this isolated world here.
    const controls=roots.flatMap(root=>[...root.querySelectorAll('input:not([type=password]),textarea,select')]).map(node=>{const n=node as HTMLInputElement;return [idFor(n),n.value,n.checked,(node as HTMLSelectElement).selectedIndex];});
    const state=JSON.stringify(controls);if(state!==controlState){controlState=state;changed();}
    return {revision:activityRevision,paint:continuousPaint||roots.some(root=>root.getAnimations().some(animation=>animation.playState==='running'||animation.pending))};
  },
  dispose:()=>{for(const observer of observers)observer.disconnect();for(const root of roots)for(const event of activityEvents)root.removeEventListener(event,changed,true);window.removeEventListener('resize',changed);document.fonts.removeEventListener('loadingdone',changed);},
  node:(id)=>live.get(id),
  shadow:(host,root)=>{closedRoots.set(host,root);watch(root);},
  svg:(url,source)=>{
    if(source.length>2*1024*1024||svgDocuments.size>=32&&!svgDocuments.has(url))return;
    // A document may enforce Trusted Types on DOMParser, including in this
    // isolated world. An unavailable SVG must not prevent capturing the page.
    try{const doc=new DOMParser().parseFromString(source,'image/svg+xml');if(!doc.querySelector('parsererror'))svgDocuments.set(url,doc);}catch{}
  },
  capture() {
    continuousPaint=false;
    const nodes:MirrorNode[]=[];
    const nextLive=new Map<string,Node>();
    const unsupported=new Set<string>();
    let truncated=false;
    const reference=(element:Element,base:string)=>{
      try{const url=new URL(element.getAttribute('href')??element.getAttributeNS('http://www.w3.org/1999/xlink','href')??'',base);if(!url.hash)return;const fragment=decodeURIComponent(url.hash.slice(1));url.hash='';const current=new URL(element.ownerDocument===document?location.href:base);current.hash='';const doc=url.href===current.href?element.ownerDocument:svgDocuments.get(url.href);return {element:doc?.getElementById(fragment),base:url.href};}catch{return;}
    };
    function svgShape(element:Element,owner:Element,base:string,ancestors:Set<Element>,depth=0):string|null {
      if(depth>32||nodes.length>=5000){truncated=true;return null;}
      if(ancestors.has(element))return null;
      if(element.namespaceURI!=='http://www.w3.org/2000/svg')return null;
      const name=element.localName;
      if(name!=='symbol'&&name!=='use'&&!SVG_TAGS.has(name))return null;
      const id=referenceId(owner,element);nextLive.set(id,owner);
      const attrs:Record<string,string>={};for(const attr of element.attributes)if(SVG_ATTRS.has(attr.name))attrs[attr.name]=attr.value;
      const style:Record<string,string>={};if(element instanceof SVGElement)for(const key of STYLE_PROPERTIES){const value=element.style.getPropertyValue(key);if(value)style[key]=value;}
      const record:MirrorNode={id,kind:'element',namespace:'svg',tag:name==='symbol'?'svg':name==='use'?'g':name,attrs,style,children:[]};nodes.push(record);
      if(name==='symbol'){style.width='100%';style.height='100%';}
      const next=new Set(ancestors);next.add(element);
      if(name==='use'){const target=reference(element,base);if(target?.element){const child=svgShape(target.element,owner,target.base,next,depth+1);if(child)record.children!.push(child);}else unsupported.add('svg-reference');return id;}
      for(const child of element.childNodes){
        if(nodes.length>=5000){truncated=true;break;}
        if(child instanceof Element){const childId=svgShape(child,owner,base,next,depth+1);if(childId)record.children!.push(childId);}
        else if(child.nodeType===Node.TEXT_NODE&&child.textContent?.trim()){const childId=referenceId(owner,child);nextLive.set(childId,owner);nodes.push({id:childId,kind:'text',text:child.textContent.slice(0,65536)});record.children!.push(childId);}
      }
      return id;
    }
    function walk(node:Node):string|null {
      if(nodes.length>=5000){truncated=true;return null;}
      if(node.nodeType!==Node.ELEMENT_NODE&&node.nodeType!==Node.TEXT_NODE)return null;
      const element=node instanceof Element?node:null;
      const tag=element?.tagName.toLowerCase();
      const svg=element?.namespaceURI==='http://www.w3.org/2000/svg';
      if(svg&&element!.localName!=='use'&&!SVG_TAGS.has(element!.localName))return null;
      if(tag&&(skipped.has(tag)||(tag==='input'&&(element as HTMLInputElement).type==='hidden')))return null;
      const id=idFor(node);nextLive.set(id,node);
      if(!element){nodes.push({id,kind:'text',text:node.textContent?.slice(0,65536)??''});return id;}
      const styles=getComputedStyle(element);
      const style:Record<string,string>={};
      for(const key of STYLE_PROPERTIES){const value=styles.getPropertyValue(key);if(value&&value!==STYLE_DEFAULTS[key])style[key]=value;}
      const attrs:Record<string,string>={};
      for(const attr of element.attributes)if(SAFE_ATTRS.has(attr.name)||(svg&&SVG_ATTRS.has(attr.name)))attrs[attr.name]=attr.value;
      const record:MirrorNode={id,kind:'element',tag:svg?element.localName:tag==='body'?'div':SAFE_TAGS.has(tag!)?tag:'div',namespace:svg?'svg':undefined,attrs,style,children:[]};
      nodes.push(record);
      if(styles.display==='none'&&!(element instanceof HTMLOptionElement||element instanceof HTMLOptGroupElement))return id;
      for(const pseudo of ['before','after','placeholder'] as const){
        if(pseudo==='placeholder'&&!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement))continue;
        const computed=getComputedStyle(element,`::${pseudo}`);if(pseudo!=='placeholder'&&['none','normal',''].includes(computed.content))continue;
        const declaration:Record<string,string>={};for(const key of STYLE_PROPERTIES){const value=computed.getPropertyValue(key);if(value&&value!==STYLE_DEFAULTS[key])declaration[key]=value;}
        const attr=declaration.content?.match(/^attr\(([a-z0-9_-]+)\)$/i);if(attr)declaration.content=JSON.stringify(element.getAttribute(attr[1])??'');
        record.pseudoStyles??={};record.pseudoStyles[pseudo]=declaration;
      }
      if(element instanceof HTMLElement){
        record.topLayer=element.matches(':modal')?'modal':element.matches(':popover-open')?'popover':undefined;
        if(record.topLayer){const backdrop=getComputedStyle(element,'::backdrop');record.backdropStyle={};for(const key of STYLE_PROPERTIES){const value=backdrop.getPropertyValue(key);if(value&&value!==STYLE_DEFAULTS[key])record.backdropStyle[key]=value;}}
      }
      if(svg&&element.localName==='use'){
        record.tag='g';const target=reference(element,location.href);
        if(target?.element){const child=svgShape(target.element,element,target.base,new Set());if(child)record.children!.push(child);}else{const bounds=element.getBoundingClientRect();if(bounds.width>0&&bounds.height>0)unsupported.add('svg-reference');}
        return id;
      }
      if(element instanceof HTMLCanvasElement){
        continuousPaint=true;
        try{if(element.width*element.height>4194304)throw new Error('large');const data=element.toDataURL('image/png');if(data.length>2800000)throw new Error('large');record.tag='img';record.attrs={alt:attrs['aria-label']??'Canvas 内容'};record.assetUrl=data;return id;}
        catch{unsupported.add('protected-canvas');}
      }
      if(element instanceof HTMLMediaElement){
        if(!element.paused)continuousPaint=true;
        record.assetUrl=element.currentSrc||element.src;
        record.media={paused:element.paused,currentTime:Math.round(element.currentTime*4)/4,volume:element.volume,muted:element.muted,loop:element.loop,playbackRate:element.playbackRate};
        return id;
      }
      if(unsupportedTags.has(tag!)){
        unsupported.add(tag!);record.attrs={role:'note','aria-label':`${tag} 暂不支持`};
        // Synthetic node IDs use a disjoint suffix to avoid colliding with live IDs.
        const textId=`n${1000000000+Number(id.slice(1))}`;
        nodes.push({id:textId,kind:'text',text:`[ ${tag}：该能力尚未接入 ]`});record.children=[textId];
        return id;
      }
      if(element instanceof HTMLElement&&element.isContentEditable&&!element.parentElement?.isContentEditable){record.editable=true;record.editableValue=element.innerText;}
      if(element instanceof HTMLImageElement){
        const source=element.currentSrc||element.src;let doc:Document|undefined;
        try{const url=new URL(source,location.href);url.hash='';doc=svgDocuments.get(url.href);}catch{}
        if(doc?.documentElement.localName==='svg'){
          record.tag='svg';record.namespace='svg';record.attrs={'role':'img','aria-label':attrs.alt??attrs['aria-label']??'Image'};
          const viewBox=doc.documentElement.getAttribute('viewBox');if(viewBox)record.attrs.viewBox=viewBox;
          const child=svgShape(doc.documentElement,element,source,new Set());if(child){const root=nodes.find(n=>n.id===child);if(root){root.tag='g';delete root.attrs?.width;delete root.attrs?.height;delete root.attrs?.viewBox;}record.children!.push(child);}return id;
        }
        record.assetUrl=source;
      }
      if(element instanceof HTMLInputElement){if(!['password','file'].includes(element.type))record.value=element.value;record.checked=element.checked;}
      if(element instanceof HTMLTextAreaElement)record.value=element.value;
      if((element instanceof HTMLTextAreaElement||element instanceof HTMLInputElement&&!['password','file'].includes(element.type))&&element.selectionStart!==null){record.selectionStart=element.selectionStart;record.selectionEnd=element.selectionEnd??element.selectionStart;}
      if(record.editable&&document.activeElement===element){const selection=getSelection();if(selection?.anchorNode&&selection.focusNode&&element.contains(selection.anchorNode)&&element.contains(selection.focusNode)){const offset=(node:Node,offset:number)=>{const range=document.createRange();range.selectNodeContents(element);range.setEnd(node,offset);return range.toString().length;};record.selectionStart=Math.min(offset(selection.anchorNode,selection.anchorOffset),offset(selection.focusNode,selection.focusOffset));record.selectionEnd=Math.max(offset(selection.anchorNode,selection.anchorOffset),offset(selection.focusNode,selection.focusOffset));}}
      if(element instanceof HTMLOptionElement)record.value=element.value;
      if(element instanceof HTMLSelectElement){record.value=element.value;record.selectedIndex=element.selectedIndex;}
      if(element instanceof HTMLElement){record.scrollTop=element.scrollTop;record.scrollLeft=element.scrollLeft;}
      // Textarea state travels as a value, not as a duplicate text child.
      const shadow=element.shadowRoot??closedRoots.get(element);if(shadow)watch(shadow);
      const children=shadow?.childNodes??(element instanceof HTMLSlotElement&&element.assignedNodes().length?element.assignedNodes({flatten:true}):element.childNodes);
      if(!(element instanceof HTMLTextAreaElement))for(const child of children){const childId=walk(child);if(childId)record.children!.push(childId);}
      return id;
    }
    const root=walk(document.body??document.documentElement)??'';
    const rootNode=nodes.find(n=>n.id===root);
    if(rootNode?.style){const html=getComputedStyle(document.documentElement);if(rootNode.style['background-color']==='rgba(0, 0, 0, 0)')rootNode.style['background-color']=html.backgroundColor;}
    live=nextLive;
    let active=document.activeElement;for(let depth=0;active&&depth<32;depth++){const child=(active.shadowRoot??closedRoots.get(active))?.activeElement;if(!child)break;active=child;}
    const html=getComputedStyle(document.documentElement),body=document.body?getComputedStyle(document.body):html;
    const bodyScrollsWindow=html.overflowX==='visible'&&html.overflowY==='visible';
    const viewportStyle={'overflow-x':bodyScrollsWindow?body.overflowX:html.overflowX,'overflow-y':bodyScrollsWindow?body.overflowY:html.overflowY,direction:html.direction,'writing-mode':html.writingMode,'color-scheme':html.colorScheme};
    return {root,nodes,viewportStyle,bodyScrollsWindow,language:document.documentElement.lang,title:document.title,url:location.href,scrollX:window.scrollX,scrollY:window.scrollY,focused:active?ids.get(active)??null:null,unsupported:[...unsupported],truncated};
  }
};

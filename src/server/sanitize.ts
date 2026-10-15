import * as css from 'css-tree';
import {SAFE_ATTRS,SAFE_TAGS,SVG_TAGS,SVG_ATTRS,STYLE_PROPERTIES,type CapturedDocument,type MirrorNode} from '../shared/protocol.js';
const properties=new Set<string>(STYLE_PROPERTIES);
const styleCache=new Map<string,string|undefined>();
export function safeSvgAttribute(key:string,value:string):string|undefined {
  if(!SVG_ATTRS.has(key)||value.length>16384||/[\\]|url\s*\(|javascript:|data:|[<>]/i.test(value))return;
  return value;
}
export function safeStyle(property:string,value:string,resource:(url:string)=>string|undefined):string|undefined {
  if(!properties.has(property)||value.length>4096)return;
  // Resource mappings belong to a session. Cache only values without URLs or
  // escapes, including rejected values, so another session cannot reuse an asset.
  const cacheable=!/[\\]|url\s*\(/i.test(value);
  const key=`${property}\0${value}`;
  if(cacheable&&styleCache.has(key))return styleCache.get(key);
  let result:string|undefined;
  try {
    const ast=css.parse(value,{context:'value'});
    let valid=true;
    css.walk(ast,node=>{
      if(node.type==='Raw'||node.type==='Atrule')valid=false;
      if(node.type==='Function'&&!new Set(['rgb','rgba','hsl','hsla','oklab','oklch','lab','lch','color','color-mix','linear-gradient','radial-gradient','conic-gradient','repeating-linear-gradient','repeating-radial-gradient','matrix','matrix3d','translate','translatex','translatey','translate3d','scale','scalex','scaley','scale3d','rotate','rotatex','rotatey','rotatez','rotate3d','skew','skewx','skewy','perspective','calc','min','max','clamp','fit-content','repeat','minmax','rect','inset','polygon','circle','ellipse','path','blur','brightness','contrast','grayscale','hue-rotate','invert','opacity','saturate','sepia','drop-shadow','counter','counters']).has(node.name.toLowerCase()))valid=false;
      if(node.type==='Url') {
        const id=resource(node.value);
        if(!id)valid=false;
        else node.value=`asset:${id}`;
      }
    });
    result=valid?css.generate(ast):undefined;
  }catch{}
  if(cacheable){if(styleCache.size>=10000)styleCache.clear();styleCache.set(key,result);}
  return result;
}
export function sanitizeDocument(raw:CapturedDocument,resource:(url:string)=>string|undefined):CapturedDocument {
  const nodes:MirrorNode[]=[];
  const seen=new Set<string>();
  const unsupported=new Set(raw.unsupported);
  for(const n of raw.nodes.slice(0,5000)) {
    if(!/^n\d+$/.test(n.id)||seen.has(n.id))continue;
    seen.add(n.id);
    if(n.kind==='text'){nodes.push({id:n.id,kind:'text',text:String(n.text??'').slice(0,65536)});continue;}
    const svg=n.namespace==='svg'&&SVG_TAGS.has(n.tag??'');
    const tag=svg?n.tag!:SAFE_TAGS.has(n.tag??'')?n.tag!:'div';
    const attrs:Record<string,string>={};
    for(const [key,value]of Object.entries(n.attrs??{}))if(SAFE_ATTRS.has(key))attrs[key]=String(value).slice(0,1024);
    if(svg)for(const [key,value]of Object.entries(n.attrs??{})){const safe=safeSvgAttribute(key,String(value));if(safe!==undefined)attrs[key]=safe;}
    if(tag==='a'){attrs.role='link';attrs.tabindex=attrs.tabindex??'0';}
    if(tag==='input'&&attrs.type&&!['text','password','email','search','url','tel','number','checkbox','radio','submit','button','reset','range','date','time','datetime-local','month','week','color','file'].includes(attrs.type))attrs.type='text';
    const style:Record<string,string>={};
    for(const [key,value]of Object.entries(n.style??{})){const filtered=safeStyle(key,String(value),resource);if(filtered!==undefined)style[key]=filtered;}
    const node:MirrorNode={id:n.id,kind:'element',tag,namespace:svg?'svg':undefined,attrs,style,children:(n.children??[]).filter(id=>/^n\d+$/.test(id))};
    if(!svg&&(n.topLayer==='popover'||n.topLayer==='modal'&&tag==='dialog')){
      node.topLayer=n.topLayer;node.backdropStyle={};
      for(const [key,value]of Object.entries(n.backdropStyle??{})){const filtered=safeStyle(key,String(value),resource);if(filtered!==undefined)node.backdropStyle[key]=filtered;}
    }
    if(n.pseudoStyles){node.pseudoStyles={};for(const pseudo of ['before','after','placeholder'] as const){const source=n.pseudoStyles[pseudo];if(!source)continue;const declaration:Record<string,string>={};for(const [key,value]of Object.entries(source)){const filtered=safeStyle(key,String(value),resource);if(filtered!==undefined)declaration[key]=filtered;}node.pseudoStyles[pseudo]=declaration;}}
    if(n.editable===true&&!svg){node.editable=true;node.editableValue=String(n.editableValue??'').slice(0,10000);}
    if(n.assetUrl){const id=resource(n.assetUrl);if(id)node.assetUrl=`asset:${id}`;}
    if(['audio','video'].includes(tag)&&style.display==='none')node.tag='div';
    else if(['audio','video'].includes(tag)){
      const media=n.media;
      if(node.assetUrl&&media&&Number.isFinite(media.currentTime)&&Number.isFinite(media.volume)&&Number.isFinite(media.playbackRate)){
        node.media={paused:media.paused!==false,currentTime:Math.max(0,Math.min(86400,media.currentTime)),volume:Math.max(0,Math.min(1,media.volume)),muted:media.muted===true,loop:media.loop===true,playbackRate:Math.max(.25,Math.min(4,media.playbackRate))};
      }else{node.tag='div';unsupported.add(`${tag}-stream`);const child='n'+(2000000000+Number(n.id.slice(1)));node.children=[child];nodes.push({id:child,kind:'text',text:'[ '+tag+'：此媒体流暂不支持 ]'});}
    }
    if(typeof n.value==='string'&&!['password','file'].includes(attrs.type)&&['input','textarea','select','option'].includes(tag))node.value=n.value.slice(0,10000);
    if(!['password','file'].includes(attrs.type)&&(tag==='input'||tag==='textarea'||node.editable)){for(const key of ['selectionStart','selectionEnd'] as const)if(Number.isInteger(n[key])&&n[key]!>=0&&n[key]!<=10000)node[key]=n[key];}
    if(typeof n.checked==='boolean')node.checked=n.checked;
    if(Number.isInteger(n.selectedIndex))node.selectedIndex=n.selectedIndex;
    if(Number.isFinite(n.scrollTop))node.scrollTop=n.scrollTop;
    if(Number.isFinite(n.scrollLeft))node.scrollLeft=n.scrollLeft;
    nodes.push(node);
  }
  const ids=new Set(nodes.map(n=>n.id));
  for(const node of nodes)if(node.children)node.children=node.children.filter(id=>ids.has(id));
  const viewportStyle:Record<string,string>={};for(const key of ['overflow-x','overflow-y','direction','writing-mode','color-scheme']){const value=raw.viewportStyle?.[key];if(value){const safe=safeStyle(key,value,()=>undefined);if(safe!==undefined)viewportStyle[key]=safe;}}
  return {...raw,unsupported:[...unsupported],viewportStyle,bodyScrollsWindow:raw.bodyScrollsWindow===true,language:/^[a-z0-9-]{1,100}$/i.test(raw.language??'')?raw.language:undefined,title:String(raw.title).slice(0,200),nodes};
}

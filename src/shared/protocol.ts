export const VERSION = 1;
export const STYLE_PROPERTIES = [
  'display','position','top','right','bottom','left','z-index','box-sizing',
  'width','height','min-width','max-width','min-height','max-height',
  'margin-top','margin-right','margin-bottom','margin-left',
  'padding-top','padding-right','padding-bottom','padding-left',
  'border-top','border-right','border-bottom','border-left','border-radius',
  'background-color','background-image','background-size','background-position','background-repeat',
  'color','font-family','font-size','font-weight','font-style','line-height','letter-spacing',
  'text-align','text-decoration','text-transform','white-space','word-break','overflow-wrap',
  'vertical-align','opacity','visibility','overflow-x','overflow-y','box-shadow',
  'flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis','align-items',
  'align-self','justify-content','gap','row-gap','column-gap','order',
  'grid-template-columns','grid-template-rows','grid-template-areas','grid-column','grid-row',
  'grid-auto-flow','grid-auto-columns','grid-auto-rows','justify-items','justify-self','align-content',
  'list-style-type','list-style-position','border-collapse','table-layout',
  'transform','transform-origin','translate','rotate','scale','object-fit','object-position','cursor','user-select','contain',
  'pointer-events','outline','outline-offset','resize','appearance','caret-color','text-indent',
  'clip','clip-path','filter','backdrop-filter','isolation','text-overflow','aspect-ratio',
  'background-clip','background-origin','background-attachment','perspective','perspective-origin',
  'direction','writing-mode','unicode-bidi','hyphens','tab-size','overflow-clip-margin',
  'overscroll-behavior-x','overscroll-behavior-y','touch-action','scrollbar-gutter','color-scheme',
  'content','counter-reset','counter-increment',
  'fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule'
] as const;
// Computed defaults omitted on the wire and restored by the trusted renderer.
// Keep inherited properties explicit, since flattened shadow trees change ancestry.
export const STYLE_DEFAULTS:Record<string,string>={
  position:'static',top:'auto',right:'auto',bottom:'auto',left:'auto','z-index':'auto',
  'max-width':'none','max-height':'none',
  'margin-top':'0px','margin-right':'0px','margin-bottom':'0px','margin-left':'0px',
  'padding-top':'0px','padding-right':'0px','padding-bottom':'0px','padding-left':'0px',
  'background-image':'none','background-size':'auto','background-position':'0% 0%',
  opacity:'1','overflow-x':'visible','overflow-y':'visible','box-shadow':'none',
  'flex-direction':'row','flex-wrap':'nowrap','flex-grow':'0','flex-shrink':'1','flex-basis':'auto',
  'align-items':'normal','align-self':'auto','justify-content':'normal',gap:'normal','row-gap':'normal','column-gap':'normal',order:'0',
  'grid-template-columns':'none','grid-template-rows':'none','grid-template-areas':'none','grid-column':'auto','grid-row':'auto',
  'grid-auto-flow':'row','grid-auto-columns':'auto','grid-auto-rows':'auto','justify-items':'normal','justify-self':'auto','align-content':'normal',
  'table-layout':'auto',transform:'none',translate:'none',rotate:'none',scale:'none','object-fit':'fill','object-position':'50% 50%',contain:'none',
  'outline-offset':'0px','text-indent':'0px',clip:'auto','clip-path':'none',filter:'none','backdrop-filter':'none',isolation:'auto','text-overflow':'clip','aspect-ratio':'auto',
  'background-clip':'border-box','background-origin':'padding-box','background-attachment':'scroll',perspective:'none',
  'overflow-clip-margin':'0px','overscroll-behavior-x':'auto','overscroll-behavior-y':'auto','touch-action':'auto','scrollbar-gutter':'auto',
  'counter-reset':'none','counter-increment':'none'
};
export const SAFE_TAGS = new Set(('div span p a button input textarea select option optgroup label form fieldset legend section main article header footer nav aside h1 h2 h3 h4 h5 h6 ul ol li dl dt dd pre code blockquote strong em b i u s small sub sup br hr img audio video table thead tbody tfoot tr td th caption colgroup col details summary dialog progress meter figure figcaption time mark samp kbd abbr address').split(' '));
export const SAFE_ATTRS = new Set(('alt title type placeholder disabled readonly required checked selected multiple min max step rows cols colspan rowspan open role aria-label aria-hidden aria-expanded aria-disabled aria-checked aria-selected aria-live aria-valuenow aria-valuemin aria-valuemax tabindex').split(' '));
export const SVG_TAGS=new Set('svg g path rect circle ellipse line polyline polygon text tspan title desc'.split(' '));
export const SVG_ATTRS=new Set('viewBox d fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset fill-rule clip-rule cx cy r rx ry x y x1 y1 x2 y2 width height points preserveAspectRatio transform opacity'.split(' '));
export interface MirrorNode {
  id: string;
  kind: 'element' | 'text';
  tag?: string;
  namespace?:'svg';
  editable?:boolean;
  editableValue?:string;
  topLayer?:'modal'|'popover';
  backdropStyle?:Record<string,string>;
  pseudoStyles?:Partial<Record<'before'|'after'|'placeholder',Record<string,string>>>;
  text?: string;
  attrs?: Record<string,string>;
  style?: Record<string,string>;
  children?: string[];
  value?: string;
  selectionStart?:number;
  selectionEnd?:number;
  checked?: boolean;
  selectedIndex?: number;
  scrollTop?: number;
  scrollLeft?: number;
  assetUrl?: string;
  media?:{paused:boolean;currentTime:number;volume:number;muted:boolean;loop:boolean;playbackRate:number};
}
export interface DocumentState {
  persistenceError?:string;
  inputRevision?:number;
  viewportStyle?:Record<string,string>;
  bodyScrollsWindow?:boolean;
  language?:string;
  windows?:{id:string;title:string;active:boolean}[];
  filePicker?:{id:string;accept:string;multiple:boolean};
  downloads?:{id:string;name:string;size:number}[];
  fontFaces?:{family:string;style:string;weight:string;assetUrl:string;unicodeRange?:string}[];
  root: string;
  title: string;
  url: string;
  scrollX: number;
  scrollY: number;
  focused: string | null;
  unsupported: string[];
  truncated: boolean;
}
export interface CapturedDocument extends DocumentState { nodes: MirrorNode[] }
export interface Snapshot extends CapturedDocument { type:'snapshot'; protocol:1; epoch:string; seq:number }
export interface Patch extends DocumentState { type:'patch'; protocol:1; epoch:string; base:number; seq:number; upsert:MirrorNode[]; remove:string[] }
export interface UserEvent {
  type:'event'; epoch:string; eventId:number; nodeId?:string;
  action:'click'|'hover'|'focus'|'input'|'key'|'scroll'|'viewport'|'select'|'navigation'|'dialog'|'media'|'pointer';
  mediaValue?:number;
  dialogId?:string;accept?:boolean;
  clipboard?:boolean;
  clickCount?:number;
  pointerType?:'mouse'|'touch'|'pen';
  nativePointer?:boolean;
  keyPhase?:'down'|'up'|'cancel';
  offsetX?:number;offsetY?:number;
  pressure?:number;tiltX?:number;tiltY?:number;
  value?:string; key?:string; shift?:boolean; ctrl?:boolean; alt?:boolean; meta?:boolean;
  selectionStart?:number; selectionEnd?:number;
  x?:number; y?:number; width?:number; height?:number;
}
export interface BrowserDialogMessage {type:'dialog';epoch:string;id:string;kind:'alert'|'confirm'|'prompt'|'beforeunload';message:string;defaultValue:string;origin:string}
export type ServerMessage = Snapshot | Patch | BrowserDialogMessage | {type:'pong'} | {type:'clipboard';text:string;eventId:number;inputRevision?:number} | {type:'ack';eventId:number;inputRevision?:number} | {type:'error';message:string;eventId?:number} | {type:'closed'};

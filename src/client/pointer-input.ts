import type {UserEvent} from '../shared/protocol.js';

type Outgoing=Omit<UserEvent,'type'|'epoch'|'eventId'>;
type Target={nodeId:string;rect:DOMRect};
type Active={id:number;type:'mouse'|'touch'|'pen';target:Target;startX:number;startY:number;sent:boolean;dragging:boolean;count:number;last:PointerEvent;directTouch:boolean};

// Forward actual press/release boundaries. Scrolling remains local to the DOM
// mirror: the browser's pointercancel cancels the remote contact, then the
// existing scroll channel synchronizes the resulting scroll position.
export class PointerInput {
  private active?:Active;
  private clicks=new Map<number,number>();
  private cancelled=new Set<number>();
  private fallbackClickUntil=0;
  private pending?:PointerEvent;
  private moveFlight?:number;
  private moveTimer?:ReturnType<typeof setTimeout>;
  constructor(private emit:(event:Outgoing)=>number,private target:(target:EventTarget|null)=>Target|undefined,private before:()=>void,private zoom:()=>number){
    document.addEventListener('pointerdown',e=>this.down(e),true);
    document.addEventListener('mousedown',e=>{const a=this.active;if(a&&a.type!=='touch'&&!a.sent){a.count=Math.max(1,Math.min(3,e.detail));this.start(a);}},true);
    document.addEventListener('pointermove',e=>this.move(e),true);
    document.addEventListener('pointerup',e=>this.up(e),true);
    document.addEventListener('pointercancel',e=>{if(this.active?.id===e.pointerId)this.cancel();},true);
    window.addEventListener('blur',()=>this.cancel());
    window.addEventListener('pagehide',()=>this.cancel());
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.cancel();});
  }
  get held(){return !!this.active;}
  acknowledge(eventId:number,failed=false){
    if(this.moveFlight!==eventId)return;
    this.moveFlight=undefined;
    if(failed){this.cancel();return;}
    if(this.pending)this.flush();
  }
  handlesClick(event:MouseEvent){
    const now=performance.now();for(const [id,until] of this.clicks)if(until<now)this.clicks.delete(id);
    if(event.detail<=0)return false;
    return event instanceof PointerEvent&&event.pointerType?this.clicks.has(event.pointerId):now<this.fallbackClickUntil;
  }
  reset(){this.cancel();}
  private data(event:PointerEvent):Outgoing{
    return {action:'pointer',nativePointer:true,pointerType:event.pointerType as Active['type'],x:event.clientX/this.zoom(),y:event.clientY/this.zoom(),ctrl:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,alt:event.altKey,pressure:event.pressure,tiltX:event.tiltX,tiltY:event.tiltY};
  }
  private down(event:PointerEvent){
    this.clicks.delete(event.pointerId);this.cancelled.delete(event.pointerId);this.fallbackClickUntil=0;
    if(this.active){this.cancel();return;}
    if(event.button!==0||!event.isPrimary||!['mouse','touch','pen'].includes(event.pointerType))return;
    // Editable/native controls and clipboard actions retain their specialized
    // local handlers. Sending a second native activation would duplicate them.
    const element=event.target instanceof Element?event.target:undefined;
    if(element?.closest('input,textarea,select,audio,video,[contenteditable]'))return;
    const button=element?.closest('button,[role="button"],a');
    if(/\bcopy\b|复制|複製/i.test((button?.getAttribute('aria-label')??'')+' '+(button?.textContent??'')))return;
    const target=this.target(event.target);if(!target)return;
    // Only touch-action:none surfaces accept a remote touch drag. Normal touch
    // scrolling is owned by the local browser, without scrolling twice.
    let directTouch=false;for(let node=element;node;node=node.parentElement??undefined)if(getComputedStyle(node).touchAction==='none'){directTouch=true;break;}
    this.active={id:event.pointerId,type:event.pointerType as Active['type'],target,startX:event.clientX,startY:event.clientY,sent:false,dragging:false,count:1,last:event,directTouch};
    if(event.pointerType==='touch')this.start(this.active);
  }
  private start(active:Active){
    this.before();active.sent=true;
    const e=active.last,r=active.target.rect;
    this.emit({...this.data(e),key:'down',nodeId:active.target.nodeId,offsetX:(e.clientX-r.left)/r.width,offsetY:(e.clientY-r.top)/r.height,clickCount:active.count});
  }
  private flush(force=false){
    clearTimeout(this.moveTimer);this.moveTimer=undefined;
    if(this.moveFlight!==undefined&&!force)return;
    const event=this.pending;this.pending=undefined;
    if(event&&this.active?.sent)this.moveFlight=this.emit({...this.data(event),key:'move'});
  }
  private move(event:PointerEvent){
    const a=this.active;if(!a||event.pointerId!==a.id||!a.sent)return;a.last=event;
    if(a.type==='touch'&&!a.directTouch)return;
    if(!a.dragging&&Math.hypot(event.clientX-a.startX,event.clientY-a.startY)>=5){a.dragging=true;(event.target as Element)?.setPointerCapture?.(event.pointerId);}
    if(a.dragging)event.preventDefault();
    // Keep one unacknowledged move and the newest real sample. Slow links must
    // not accumulate old coordinates ahead of release or the next click.
    this.pending=event;if(!this.moveTimer&&this.moveFlight===undefined)this.moveTimer=setTimeout(()=>this.flush(),16);
  }
  private up(event:PointerEvent){
    const a=this.active;if(!a||event.pointerId!==a.id){if(this.cancelled.delete(event.pointerId)){this.fallbackClickUntil=performance.now()+1000;this.clicks.set(event.pointerId,this.fallbackClickUntil);}return;}
    this.flush(true);if(a.sent){this.emit({...this.data(event),key:'up',clickCount:a.count});this.fallbackClickUntil=performance.now()+1000;this.clicks.set(a.id,this.fallbackClickUntil);}
    this.active=undefined;this.moveFlight=undefined;
  }
  private cancel(){
    const a=this.active;clearTimeout(this.moveTimer);this.moveTimer=undefined;this.pending=undefined;this.active=undefined;this.moveFlight=undefined;
    if(a?.sent){this.cancelled.add(a.id);while(this.cancelled.size>16)this.cancelled.delete(this.cancelled.values().next().value!);this.emit({...this.data(a.last),key:'cancel'});this.fallbackClickUntil=performance.now()+1000;this.clicks.set(a.id,this.fallbackClickUntil);}
  }
}

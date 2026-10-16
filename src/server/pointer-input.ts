import type {CDPSession} from 'playwright-core';
import type {UserEvent} from '../shared/protocol.js';

type Point={x:number;y:number};
type Contact={peer:string;cdp:CDPSession;type:'mouse'|'touch'|'pen';offset:Point;point:Point;count:number};
const modifiers=(e:UserEvent)=>(e.alt?1:0)|(e.ctrl?2:0)|(e.meta?4:0)|(e.shift?8:0);

// One live contact per browser, bound to its originating connection and CDP
// target. No synthetic movement or randomized timings are added.
export class RemotePointerInput {
  private contact?:Contact;
  private timer?:NodeJS.Timeout;
  constructor(private expire:(peer:string)=>void){}
  private lease(contact:Contact){clearTimeout(this.timer);this.timer=setTimeout(()=>this.expire(contact.peer),30000);this.timer.unref();}
  async dispatch(event:UserEvent,peer:string,cdp:CDPSession,hasTouch:boolean,position?:Point){
    if(event.key==='cancel'){await this.cancel(peer);return;}
    if(event.key==='down'){
      if(this.contact&&this.contact.peer!==peer)throw new Error('Pointer belongs to another connection');
      await this.cancel(peer);
      const point=position??{x:event.x!,y:event.y!};
      const type=event.pointerType==='touch'&&hasTouch?'touch':event.pointerType==='pen'?'pen':'mouse';
      this.contact={peer,cdp,type,point,offset:{x:point.x-event.x!,y:point.y-event.y!},count:event.clickCount??1};
    }
    const a=this.contact;if(!a)return;
    if(a.peer!==peer)throw new Error('Pointer belongs to another connection');
    a.point={x:event.x!+a.offset.x,y:event.y!+a.offset.y};this.lease(a);
    try{
      if(a.type==='touch'){
        await a.cdp.send('Input.dispatchTouchEvent',{type:event.key==='down'?'touchStart':event.key==='up'?'touchEnd':'touchMove',modifiers:modifiers(event),touchPoints:event.key==='up'?[]:[{...a.point,id:0,force:event.pressure??.5}]});
      }else{
        // CDP carries pen identity, pressure, tilt and independent modifier bits.
        await a.cdp.send('Input.dispatchMouseEvent',{type:event.key==='down'?'mousePressed':event.key==='up'?'mouseReleased':'mouseMoved',...a.point,button:'left',buttons:event.key==='up'?0:1,clickCount:a.count,modifiers:modifiers(event),pointerType:a.type,force:event.key==='up'?0:event.pressure??.5,tiltX:event.tiltX??0,tiltY:event.tiltY??0});
      }
    }catch(error){await this.cancel(peer);throw error;}
    if(event.key==='up'){clearTimeout(this.timer);this.contact=undefined;}
  }
  async cancel(peer?:string){
    const a=this.contact;if(!a||peer!==undefined&&a.peer!==peer)return;
    this.contact=undefined;clearTimeout(this.timer);
    // Chromium exposes native touch cancellation. For mouse/pen, release
    // outside the viewport so connection loss cannot activate the pressed item.
    if(a.type==='touch')await a.cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(()=>{});
    else{
      await a.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:-1,y:-1,button:'left',buttons:1,pointerType:a.type}).catch(()=>{});
      await a.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0,clickCount:0,pointerType:a.type}).catch(()=>{});
    }
  }
}

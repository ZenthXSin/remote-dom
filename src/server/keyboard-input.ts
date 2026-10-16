import type {Page} from 'playwright-core';
import type {UserEvent} from '../shared/protocol.js';
const modifierNames=['Control','Meta','Alt','Shift'] as const;
export class RemoteKeyboardInput {
  private owner?:{peer:string;page:Page};
  private keys=new Set<string>();
  private modifiers=new Set<string>();
  private timer?:NodeJS.Timeout;
  constructor(private expire:(peer:string)=>void){}
  held(peer:string,key:string){return this.owner?.peer===peer&&this.keys.has(key);}
  async dispatch(event:UserEvent,peer:string,page:Page){
    if(event.keyPhase==='cancel'){await this.cancel(peer);return;}
    if(this.owner&&this.owner.peer!==peer)throw new Error('Keyboard belongs to another connection');
    this.owner??={peer,page};
    const keyboard=this.owner.page.keyboard,key=event.key!;
    const desired=[event.ctrl,event.meta,event.alt,event.shift];
    try{
      for(let i=0;i<modifierNames.length;i++){
        const name=modifierNames[i];
        if(desired[i]&&!this.modifiers.has(name)){await keyboard.down(name);this.modifiers.add(name);}
        if(!desired[i]&&this.modifiers.has(name)){await keyboard.up(name);this.modifiers.delete(name);}
      }
      if(!modifierNames.includes(key as typeof modifierNames[number])){
        if(event.keyPhase==='down'){await keyboard.down(key);this.keys.add(key);}
        else if(this.keys.has(key)){await keyboard.up(key);this.keys.delete(key);}
      }
      clearTimeout(this.timer);
      if(this.keys.size||this.modifiers.size){this.timer=setTimeout(()=>this.expire(peer),30000);this.timer.unref();}
      else this.owner=undefined;
    }catch(error){await this.cancel(peer);throw error;}
  }
  async cancel(peer?:string){
    const owner=this.owner;if(!owner||peer!==undefined&&owner.peer!==peer)return;
    this.owner=undefined;clearTimeout(this.timer);
    const keys=[...this.keys,...this.modifiers];this.keys.clear();this.modifiers.clear();
    for(const key of keys)await owner.page.keyboard.up(key).catch(()=>{});
  }
}

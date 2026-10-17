// A sent resize is not a confirmed resize. Keep retries independent of DOM
// updates, since a failed request may leave the page completely unchanged.
export class ViewportSync {
  private confirmed='';
  private pending?:{id:number;key:string};
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private retry:()=>void,private timeout=1500){}
  update(key:string,send:()=>number){
    if(key===this.pending?.key||!this.pending&&key===this.confirmed)return;
    clearTimeout(this.timer);this.pending={id:send(),key};
    this.timer=setTimeout(()=>{this.pending=undefined;this.confirmed='';this.retry();},this.timeout);
  }
  acknowledge(id:number,ok:boolean){
    if(this.pending?.id!==id)return;
    clearTimeout(this.timer);this.confirmed=ok?this.pending.key:'';this.pending=undefined;
    if(!ok)this.timer=setTimeout(()=>this.retry(),200);
  }
  observe(key:string){if(!this.pending&&this.confirmed!==key)this.confirmed='';}
  reset(){clearTimeout(this.timer);this.pending=undefined;this.confirmed='';}
}

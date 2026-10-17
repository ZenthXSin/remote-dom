// Keep a single ordered socket per browser, but perform network receive, JSON
// parsing and patch coalescing off the DOM thread. Unsupported/blocked Workers
// fall back to native WebSocket without replaying unconfirmed input.
let workerUnavailable=false;
export class StreamSocket {
  readyState:number=WebSocket.CONNECTING;
  onopen:(()=>void)|null=null;
  onmessage:((event:{data:any})=>void)|null=null;
  onclose:(()=>void)|null=null;
  private worker?:Worker;
  private native?:WebSocket;
  private pendingBytes=0;
  private workerBuffered=0;
  private startup?:ReturnType<typeof setTimeout>;
  private shutdown?:ReturnType<typeof setTimeout>;
  constructor(private url:string){
    if(workerUnavailable||typeof Worker==='undefined'){this.fallback();return;}
    try{
      this.worker=new Worker('/stream-worker.js',{name:'remote-dom-stream'});
      this.startup=setTimeout(()=>this.workerFailed(),2000);
      this.worker.onerror=event=>{event.preventDefault();this.workerFailed();};
      this.worker.onmessage=event=>{
        const m=event.data;
        if(m.type==='ready'){clearTimeout(this.startup);this.worker?.postMessage({type:'connect',url});}
        else if(m.type==='open'){if(this.readyState!==WebSocket.CONNECTING)return;this.readyState=WebSocket.OPEN;this.onopen?.();}
        else if(m.type==='message'){if(this.readyState===WebSocket.OPEN)this.onmessage?.({data:m.data});}
        else if(m.type==='sent'){this.pendingBytes=Math.max(0,this.pendingBytes-m.bytes);this.workerBuffered=m.buffered;}
        else if(m.type==='closed')this.finish();
      };
    }catch{this.workerFailed();}
  }
  get bufferedAmount(){return this.native?.bufferedAmount??this.pendingBytes+this.workerBuffered;}
  private workerFailed(){
    workerUnavailable=true;clearTimeout(this.startup);this.worker?.terminate();this.worker=undefined;
    if(this.readyState===WebSocket.CONNECTING)this.fallback();else this.finish();
  }
  private fallback(){
    const socket=this.native=new WebSocket(this.url);
    socket.onopen=()=>{this.readyState=WebSocket.OPEN;this.onopen?.();};
    socket.onmessage=event=>this.onmessage?.(event);
    socket.onclose=()=>this.finish();
  }
  send(data:string){
    if(this.readyState!==WebSocket.OPEN)return;
    if(this.native){this.native.send(data);return;}
    this.pendingBytes+=data.length*2;this.worker?.postMessage({type:'send',data});
  }
  close(code?:number,reason?:string){
    if(this.readyState>=WebSocket.CLOSING)return;
    if(this.native){this.readyState=WebSocket.CLOSING;this.native.close(code,reason);return;}
    if(this.readyState===WebSocket.CONNECTING){this.finish();return;}
    this.readyState=WebSocket.CLOSING;this.worker?.postMessage({type:'close',code,reason});
    this.shutdown=setTimeout(()=>this.finish(),1000);
  }
  private finish(){
    if(this.readyState===WebSocket.CLOSED)return;
    this.readyState=WebSocket.CLOSED;clearTimeout(this.startup);clearTimeout(this.shutdown);
    this.worker?.terminate();this.worker=undefined;this.pendingBytes=0;this.workerBuffered=0;
    queueMicrotask(()=>this.onclose?.());
  }
}

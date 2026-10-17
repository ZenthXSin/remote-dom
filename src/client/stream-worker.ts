import {RenderQueue} from './render-queue.js';
import type {Snapshot,Patch} from '../shared/protocol.js';
let socket:WebSocket|undefined;
let flight:{epoch:string;seq:number;token:number}|undefined;
const post=(message:unknown)=>self.postMessage(message);
const renders=new RenderQueue((update,token)=>{
  flight={epoch:update.epoch,seq:update.seq,token};
  post({type:'message',data:update});
},()=>{flight=undefined;renders.reset();socket?.send(JSON.stringify({type:'resync'}));});
self.onmessage=(event:MessageEvent)=>{
  const message=event.data;
  if(message.type==='connect'){
    if(socket)return;
    const url=new URL(message.url),origin=new URL(self.location.href);
    if(url.host!==origin.host||url.protocol!==(origin.protocol==='https:'?'wss:':'ws:')||!/^\/api\/sessions\/[a-f0-9-]+\/stream$/.test(url.pathname)){post({type:'closed'});return;}
    socket=new WebSocket(url);
    socket.onopen=()=>post({type:'open'});
    socket.onmessage=event=>{
      try{
        const data=JSON.parse(event.data);
        if(data.type==='snapshot'||data.type==='patch')renders.push(data as Snapshot|Patch);
        else post({type:'message',data});
      }catch{socket?.close(1002,'Invalid stream response');}
    };
    socket.onclose=()=>{renders.reset();post({type:'closed'});self.close();};
    return;
  }
  if(message.type==='close'){socket?.close(message.code,message.reason);return;}
  if(message.type==='send'&&socket?.readyState===WebSocket.OPEN){
    const data=JSON.parse(message.data);
    // Input and control messages bypass the visual queue. Only a matching
    // rendered cursor releases the next merged visual update to the UI thread.
    if(data.type==='resync'){renders.reset();flight=undefined;}
    socket.send(message.data);
    if(data.type==='rendered'&&flight&&flight.epoch===data.epoch&&flight.seq===data.seq){const token=flight.token;flight=undefined;renders.done(token);}
    post({type:'sent',bytes:message.data.length*2,buffered:socket.bufferedAmount});
  }
};
post({type:'ready'});

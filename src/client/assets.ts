type AssetTask={id:string;state:'queued'|'loading'|'retrying'|'failed';attempts:number;controller?:AbortController;timer?:ReturnType<typeof setTimeout>};

// Resource downloads never hold the document/event queue. A context version
// prevents an old browser's bytes or completion from affecting its successor.
export class AssetLoader {
  private session='';private version=0;private active=0;
  private loaded=new Set<string>();private tasks=new Map<string,AssetTask>();
  private queue:AssetTask[]=[];
  constructor(private deliver:(id:string,mime:string,bytes:ArrayBuffer)=>void,private status:(pending:number,failed:number)=>void){}
  begin(session:string){const same=session===this.session;this.stop();if(!same)this.loaded.clear();this.session=session;this.report();}
  reset(){this.stop();this.session='';this.loaded.clear();this.report();}
  private stop(){this.version++;for(const task of this.tasks.values()){task.controller?.abort();clearTimeout(task.timer);}this.tasks.clear();this.queue=[];this.active=0;}
  enqueue(ids:readonly string[]){
    if(!this.session)return;
    for(const id of ids){if(!/^[a-f0-9-]{36}$/.test(id)||this.loaded.has(id)||this.tasks.has(id))continue;const task:AssetTask={id,state:'queued',attempts:0};this.tasks.set(id,task);this.queue.push(task);}
    this.report();this.pump();
  }
  retry(){for(const task of this.tasks.values())if(task.state==='failed'){task.state='queued';task.attempts=0;this.queue.push(task);}this.report();this.pump();}
  private report(){let pending=0,failed=0;for(const task of this.tasks.values())if(task.state==='failed')failed++;else pending++;this.status(pending,failed);}
  private pump(){while(this.active<4&&this.queue.length){const task=this.queue.shift()!;this.active++;task.state='loading';void this.load(task,this.session,this.version);}this.report();}
  private async load(task:AssetTask,session:string,version:number){
    const controller=new AbortController();task.controller=controller;task.attempts++;
    const timeout=setTimeout(()=>controller.abort(),12000);let transient=true;
    try{
      const response=await fetch(`/api/sessions/${session}/assets/${task.id}`,{cache:'no-store',signal:controller.signal});
      transient=response.status>=500||response.status===408||response.status===429;
      if(!response.ok)throw new Error('Resource unavailable');
      transient=true;
      const reader=response.body?.getReader();if(!reader)throw new Error('Resource empty');
      const chunks:Uint8Array[]=[];let length=0;
      for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2*1024*1024){transient=false;await reader.cancel();throw new Error('Resource too large');}chunks.push(value);}
      if(version!==this.version)return;
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      this.deliver(task.id,response.headers.get('Content-Type')??'application/octet-stream',bytes.buffer);
      this.loaded.add(task.id);this.tasks.delete(task.id);
    }catch{
      if(version!==this.version)return;
      if(transient&&task.attempts<2){task.state='retrying';task.timer=setTimeout(()=>{if(version!==this.version)return;task.state='queued';this.queue.push(task);this.pump();},400);}
      else task.state='failed';
    }finally{
      clearTimeout(timeout);
      if(version===this.version){task.controller=undefined;this.active--;this.pump();}
    }
  }
}

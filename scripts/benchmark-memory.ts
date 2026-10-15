import {createApp} from '../src/server/app.js';
import {readConfig} from '../src/server/config.js';
import {readFile} from 'node:fs/promises';
const app=await createApp(readConfig({...process.env,PORT:'0',ENGINE_MODE:'demo',DEVICE_PROFILE_DIR:'/tmp/profile'}));
let touch:ReturnType<typeof setInterval>|undefined;
try {
 const state=await fetch(app.origin+'/api/state');const cookie=state.headers.get('set-cookie')!.split(';')[0];
 const res=await fetch(app.origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({url:app.fixtureOrigin+'/edge-menu'})});
 if(res.status!==201)throw new Error('Start failed '+res.status);
 const session=app.sessions.get((await res.json()).id)!;
 touch=setInterval(()=>session.view(),500);
 for(const phase of ['simple','dynamic']){
  if(phase==='dynamic')await session.page.evaluate(()=>{const list=document.createElement('div');list.id='benchmark';for(let i=0;i<500;i++){const row=document.createElement('p');row.textContent='Message '+i+' — streaming conversation benchmark';list.append(row);}document.body.append(list);setInterval(()=>{list.lastElementChild!.textContent='Updated '+Date.now();},200);});
  const samples=[];
  for(let i=0;i<12;i++){
   await new Promise(r=>setTimeout(r,1000));const stat=await readFile('/sys/fs/cgroup/memory.stat','utf8');const inactive=Number(stat.match(/^inactive_file (\d+)/m)![1]);
   const current=Number(await readFile('/sys/fs/cgroup/memory.current','utf8'));samples.push({workingMiB:Math.round((current-inactive)/1048576),totalMiB:Math.round(current/1048576),nodeMiB:Math.round(process.memoryUsage().rss/1048576),heapMiB:Math.round(process.memoryUsage().heapUsed/1048576)});
  }
  console.log(JSON.stringify({phase,samples}));
 }
 clearInterval(touch);
}finally{clearInterval(touch);await app.close();}

import {spawn} from 'node:child_process';
import {connect} from 'node:net';

// A local X display for Chromium's regular windowed rendering path. No VNC or
// display TCP listener is exposed; users still receive the DOM mirror.
export async function startDisplay(headless:boolean){
  if(headless||process.env.DISPLAY)return ()=>{};
  const display=':99',socket='/tmp/.X11-unix/X99';
  const child=spawn('Xvfb',[display,'-screen','0','1280x900x24','-nolisten','tcp'],{stdio:'ignore'});
  let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
  const stop=()=>{child.kill('SIGTERM');};
  for(let attempt=0;attempt<50&&!failed;attempt++){
    const ready=await new Promise<boolean>(resolve=>{const s=connect(socket);const finish=(ok:boolean)=>{s.destroy();resolve(ok);};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));s.setTimeout(100,()=>finish(false));});
    if(ready&&!failed){process.env.DISPLAY=display;return stop;}
    await new Promise(r=>setTimeout(r,100));
  }
  stop();throw new Error('Local browser display could not start');
}

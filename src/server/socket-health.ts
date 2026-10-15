import type {WebSocket} from 'ws';
// Protocol ping/pong works even when a mobile tab throttles JavaScript timers.
export function monitorSocket(socket:WebSocket,intervalMs=15000){
  let alive=true;const pong=()=>{alive=true;};socket.on('pong',pong);
  const timer=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;if(socket.readyState===1)socket.ping();},intervalMs);timer.unref();
  socket.once('close',()=>{clearInterval(timer);socket.off('pong',pong);});
}

// Diagnostic metadata only: never retain headers, cookies, bodies or raw URLs.
export function diagnosticTarget(value:string){try{const u=new URL(value);return {origin:u.origin,route:u.pathname.startsWith('/cdn-cgi/')?'cloudflare-challenge':u.hostname==='challenges.cloudflare.com'?'cloudflare-widget':'page-or-resource'};}catch{return {origin:'unavailable',route:'unknown'};}}
export class Diagnostics {
 private entries:Record<string,unknown>[]=[];private timer?:NodeJS.Timeout;private started?:string;private stopped?:string;private dropped=0;
 get active(){return !!this.timer;}
 start(){clearTimeout(this.timer);this.entries=[];this.dropped=0;this.started=new Date().toISOString();this.stopped=undefined;this.timer=setTimeout(()=>this.stop(),5*60*1000);this.timer.unref();this.add('recording-start');}
 add(kind:string,data:Record<string,unknown>={}){if(!this.active)return;if(this.entries.length>=3000){this.dropped++;return;}this.entries.push({at:new Date().toISOString(),kind,...data});}
 stop(){if(this.active){this.add('recording-stop');clearTimeout(this.timer);this.timer=undefined;this.stopped=new Date().toISOString();}return this.report();}
 report(){return {schema:1,active:this.active,started:this.started,stopped:this.stopped,dropped:this.dropped,limits:{seconds:300,entries:3000},events:this.entries};}
 clear(){clearTimeout(this.timer);this.timer=undefined;this.entries=[];}
}

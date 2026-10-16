import {createHash} from 'node:crypto';
// Diagnostic metadata only: never retain headers, cookies, bodies or raw URLs.
export function diagnosticTarget(value:string){try{const u=new URL(value);return {pathId:createHash('sha256').update(u.origin+u.pathname).digest('hex').slice(0,16),origin:u.origin,route:u.pathname.includes('/challenge-platform/')&&u.pathname.includes('/pat/')?'cloudflare-pat':u.pathname.startsWith('/cdn-cgi/')?'cloudflare-challenge':u.hostname==='challenges.cloudflare.com'?'cloudflare-widget':u.pathname.startsWith('/api/')?'api':'page-or-resource'};}catch{return {origin:'unavailable',route:'unknown'};}}
export class Diagnostics {
 private entries:Record<string,unknown>[]=[];private timer?:NodeJS.Timeout;private started?:string;private stopped?:string;private dropped=0;
 constructor(private onStop:()=>void=()=>{}){}
 get active(){return !!this.timer;}
 start(){clearTimeout(this.timer);this.entries=[];this.dropped=0;this.started=new Date().toISOString();this.stopped=undefined;this.timer=setTimeout(()=>this.stop(),5*60*1000);this.timer.unref();this.add('recording-start');}
 add(kind:string,data:Record<string,unknown>={}){if(!this.active)return;if(this.entries.length>=3000){this.dropped++;return;}this.entries.push({at:new Date().toISOString(),kind,...data});}
 stop(){if(this.active){this.add('recording-stop');clearTimeout(this.timer);this.timer=undefined;this.stopped=new Date().toISOString();this.onStop();}return this.report();}
 report(){return {schema:3,active:this.active,started:this.started,stopped:this.stopped,dropped:this.dropped,limits:{seconds:300,entries:3000},events:this.entries};}
 clear(){clearTimeout(this.timer);this.timer=undefined;this.entries=[];}
}

export function diagnosticCookies(header:string|undefined){return {clearance:/(?:^|;\s*)cf_clearance=/.test(header??''),botManagement:/(?:^|;\s*)__cf_bm=/.test(header??'')};}
export function diagnosticSetCookies(headers:{name:string;value:string}[]){const cookies=headers.filter(h=>h.name.toLowerCase()==='set-cookie');return {clearance:cookies.some(h=>/^cf_clearance=/.test(h.value)),botManagement:cookies.some(h=>/^__cf_bm=/.test(h.value))};}

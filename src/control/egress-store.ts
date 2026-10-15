import {randomUUID} from 'node:crypto';
import {mkdir,readFile,stat,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {isIP} from 'node:net';
import {isPublicAddress} from '../server/policy.js';
export interface PersonalProxyInput {server:string;username?:string;password?:string;clearCredentials?:boolean}
export interface EgressProfile {id:string;name:string;mode:'server'|'custom';enabled:boolean;server?:string;username?:string;password?:string;maxAccounts:number;ownerAccountId?:string}
interface State {version:1;defaultSelection:string;profiles:EgressProfile[];bindings:Record<string,string>}
export const publicProfile=(p:EgressProfile)=>({id:p.id,name:p.name,mode:p.mode,enabled:p.enabled,server:p.server,maxAccounts:p.maxAccounts,ownerAccountId:p.ownerAccountId,hasCredentials:!!(p.username||p.password)});
function validate(p:EgressProfile){if(p.ownerAccountId!==undefined&&(!/^[a-f0-9-]{36}$/.test(p.ownerAccountId)||p.mode!=='custom'||p.maxAccounts!==1))throw new Error('个人出口身份不正确');if(!p||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.enabled!=='boolean'||!Number.isInteger(p.maxAccounts)||p.maxAccounts<1||p.maxAccounts>1000)throw new Error('代理参数不正确');if(p.mode==='server'){if(p.id!=='server'||p.server||p.username||p.password)throw new Error('默认出口配置不正确');return;}
 if(p.mode!=='custom'||!/^[a-f0-9-]{36}$/.test(p.id)||typeof p.server!=='string')throw new Error('代理参数不正确');let u:URL;try{u=new URL(p.server);}catch{throw new Error('代理地址不正确');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('请输入 HTTP/HTTPS 代理地址，用户名密码分别填写');if(p.ownerAccountId){const host=u.hostname.replace(/^\[|\]$/g,'');if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||isIP(host)&&!isPublicAddress(host))throw new Error('个人代理需使用公网地址');}for(const v of [p.username,p.password])if(v!==undefined&&(typeof v!=='string'||v.length>512||/[\x00-\x1f\x7f]/.test(v)))throw new Error('代理凭据格式不正确');if(p.username?.includes(':')||p.password&&!p.username)throw new Error('代理用户名格式不正确');}
export class EgressStore {
 existed=false;
 private state:State={version:1,defaultSelection:'server',profiles:[{id:'server',name:'服务器默认出口',mode:'server',enabled:true,maxAccounts:1000}],bindings:{}};private tail:Promise<unknown>=Promise.resolve();
 constructor(private file:string){}
 async initialize(){await mkdir(dirname(this.file),{recursive:true,mode:0o700});try{if((await stat(this.file)).mode&0o077)throw new Error('Egress database must have mode 0600');const s=JSON.parse(await readFile(this.file,'utf8')) as State;if(s.version!==1||!Array.isArray(s.profiles)||!s.bindings||typeof s.bindings!=='object'||Array.isArray(s.bindings)||s.profiles.length>1100)throw new Error('Invalid egress database');const ids=new Set<string>();for(const p of s.profiles){validate(p);if(ids.has(p.id))throw new Error('Duplicate egress profile');ids.add(p.id);}if(!ids.has('server')||s.defaultSelection!=='pool'&&!ids.has(s.defaultSelection)||Object.entries(s.bindings).some(([id,profile])=>!/^[a-f0-9-]{36}$/.test(id)||!ids.has(profile)))throw new Error('Invalid egress binding');if(s.profiles.filter(p=>!p.ownerAccountId).length>100||s.profiles.some(p=>p.ownerAccountId&&p.id===s.defaultSelection)||Object.entries(s.bindings).some(([account,id])=>{const p=s.profiles.find(p=>p.id===id)!;return p.ownerAccountId&&p.ownerAccountId!==account;}))throw new Error('Invalid private egress ownership');this.state=s;this.existed=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private async change<T>(fn:(s:State)=>T){const run=this.tail.then(async()=>{const s=structuredClone(this.state),result=fn(s),temp=this.file+'.'+randomUUID()+'.tmp';try{const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(s)+'\n');await f.sync();}finally{await f.close();}await rename(temp,this.file);const d=await open(dirname(this.file),'r');try{await d.sync();}finally{await d.close();}this.state=s;return result;}finally{await unlink(temp).catch(()=>{});}});this.tail=run.catch(()=>{});return run;}
 snapshot(){return {defaultSelection:this.state.defaultSelection,profiles:this.state.profiles.map(p=>({...publicProfile(p),assigned:Object.values(this.state.bindings).filter(id=>id===p.id).length})),bindings:{...this.state.bindings}};}
 profile(id:string|undefined){return this.state.profiles.find(p=>p.id===id);}
 binding(id:string){return this.state.bindings[id];}
 affected(profileId:string){return Object.entries(this.state.bindings).filter(([,v])=>v===profileId).map(([id])=>id);}
 async add(input:Omit<EgressProfile,'id'|'mode'|'enabled'>){const p:EgressProfile={...input,ownerAccountId:undefined,id:randomUUID(),mode:'custom',enabled:true};validate(p);return this.change(s=>{if(s.profiles.filter(p=>!p.ownerAccountId).length>=100)throw new Error('代理数量达到上限');s.profiles.push(p);return publicProfile(p);});}

 private ownedProfile(s:State,accountId:string){return s.profiles.find(p=>p.ownerAccountId===accountId&&p.id===s.bindings[accountId])??s.profiles.find(p=>p.ownerAccountId===accountId);}
 personal(accountId:string){
  const personal=this.ownedProfile(this.state,accountId);
  const current=this.profile(this.binding(accountId));
  return {personal:personal?{...publicProfile(personal),username:personal.username??''}:null,current:current?{name:current.name,mode:current.mode,server:current.server,enabled:current.enabled,personal:current.ownerAccountId===accountId}:null};
 }
 testProfile(accountId:string,input:PersonalProxyInput){
  const old=this.ownedProfile(this.state,accountId);
  const p:EgressProfile={id:randomUUID(),name:'个人代理测试',mode:'custom',enabled:true,maxAccounts:1,ownerAccountId:accountId,server:input.server,username:input.clearCredentials?undefined:input.username??old?.username,password:input.clearCredentials?undefined:input.password??old?.password};validate(p);return p;
 }
 async setPersonal(accountId:string,input:PersonalProxyInput){
  if(!/^[a-f0-9-]{36}$/.test(accountId))throw new Error('账号身份不正确');
  return this.change(s=>{
   const old=this.ownedProfile(s,accountId);
   const p:EgressProfile={id:randomUUID(),name:'个人出口',mode:'custom',enabled:true,maxAccounts:1,ownerAccountId:accountId,server:input.server,username:input.clearCredentials?undefined:input.username??old?.username,password:input.clearCredentials?undefined:input.password??old?.password};
   validate(p);if(!old&&s.profiles.length>=1100)throw new Error('代理数量达到上限');
   s.profiles=s.profiles.filter(p=>p.id!==old?.id);s.profiles.push(p);s.bindings[accountId]=p.id;
   return publicProfile(p);
  });
 }
 async setDefault(selection:string){await this.change(s=>{if(selection!=='pool'&&!s.profiles.some(p=>p.id===selection&&p.enabled&&!p.ownerAccountId))throw new Error('出口不存在或已停用');s.defaultSelection=selection;});}
 async setEnabled(id:string,enabled:boolean){await this.change(s=>{const p=s.profiles.find(p=>p.id===id);if(!p||typeof enabled!=='boolean'||id==='server'&&!enabled)throw new Error('出口状态不正确');p.enabled=enabled;});}
 private select(s:State,accountId:string,selection:string){if(selection==='default')selection=s.defaultSelection;const counts=(id:string)=>Object.entries(s.bindings).filter(([account,p])=>account!==accountId&&p===id).length;let p: EgressProfile|undefined;if(selection==='pool')p=s.profiles.filter(p=>p.mode==='custom'&&!p.ownerAccountId&&p.enabled&&counts(p.id)<p.maxAccounts).sort((a,b)=>counts(a.id)-counts(b.id)||a.id.localeCompare(b.id))[0];else p=s.profiles.find(p=>p.id===selection&&(!p.ownerAccountId||p.ownerAccountId===accountId)&&p.enabled&&counts(p.id)<p.maxAccounts);if(!p)throw new Error('代理池没有可用线路或该线路分配已满，不会回退默认出口');s.bindings[accountId]=p.id;return p;}
 async assign(accountId:string,selection:string){if(!/^[a-f0-9-]{36}$/.test(accountId))throw new Error('账号身份不正确');return this.change(s=>this.select(s,accountId,selection));}
 async resolve(accountId:string){if(!/^[a-f0-9-]{36}$/.test(accountId))throw new Error('账号身份不正确');const id=this.binding(accountId);if(id){const p=this.profile(id);if(!p?.enabled)throw new Error('固定代理已停用，请管理员重新分配出口');return p;}return this.change(s=>{const current=s.bindings[accountId];if(current){const p=s.profiles.find(p=>p.id===current&&p.enabled);if(!p)throw new Error('固定代理已停用，请管理员重新分配出口');return p;}return this.select(s,accountId,s.defaultSelection);});}
}

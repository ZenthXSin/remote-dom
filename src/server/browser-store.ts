import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {BrowserContext} from 'playwright-core';
export type LoginState=Awaited<ReturnType<BrowserContext['storageState']>>;
interface SavedBrowser {id:string;owner:string;url:string;title:string;savedAt:string;state:LoginState}
interface Registry {owners:Record<string,{expires:number;recovery:string}>;browsers:Record<string,SavedBrowser>}
export class BrowserStore {
  private key!:Buffer;private registry:Registry={owners:{},browsers:{}};private writes=Promise.resolve();
  constructor(private directory:string){}
  async initialize(){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const keyPath=join(this.directory,'key');
    try{this.key=await readFile(keyPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;try{await stat(join(this.directory,'state'));throw new Error('浏览器存储密钥缺失，未覆盖已有数据');}catch(check){if((check as NodeJS.ErrnoException).code!=='ENOENT')throw check;}this.key=randomBytes(32);try{await writeFile(keyPath,this.key,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;this.key=await readFile(keyPath);}}
    if(this.key.length!==32)throw new Error('浏览器存储密钥损坏');
    try{const bytes=await readFile(join(this.directory,'state'));if(bytes.length>64*1024*1024||bytes.length<28)throw new Error('浏览器存储损坏');const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));this.registry=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());if(!this.registry.owners||!this.registry.browsers)throw new Error('浏览器存储损坏');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('浏览器存储无法验证，未覆盖已有数据');}
  }
  owners(){return new Map(Object.entries(this.registry.owners).filter(([,data])=>data.expires>Date.now()).map(([owner,data])=>[owner,data.expires]));}
  async rememberOwner(owner:string,expires:number){await this.change(next=>{next.owners[owner]={expires,recovery:next.owners[owner]?.recovery??randomBytes(32).toString('hex')};});}
  recovery(owner:string){return this.registry.owners[owner]?.recovery;}
  ownerForRecovery(token:string){if(!/^[a-f0-9]{64}$/.test(token))return;return Object.entries(this.registry.owners).find(([,data])=>data.recovery===token)?.[0];}
  list(owner:string){return Object.values(this.registry.browsers).filter(b=>b.owner===owner).map(({state,owner,...metadata})=>metadata);}
  read(owner:string,id:string){const browser=this.registry.browsers[id];return browser?.owner===owner?browser:undefined;}
  async save(browser:SavedBrowser){const copy=structuredClone(browser);if(Buffer.byteLength(JSON.stringify(copy))>8*1024*1024)throw new Error('浏览器登录存储超过 8 MiB');await this.change(next=>{next.browsers[copy.id]=copy;});}
  async forget(owner:string,id:string){await this.change(next=>{if(next.browsers[id]?.owner===owner)delete next.browsers[id];});}
  async persist(){await this.change(()=>{});}
  private async change(update:(next:Registry)=>void){
    const operation=this.writes.then(async()=>{
      const next=structuredClone(this.registry);update(next);
      const plain=Buffer.from(JSON.stringify(next));if(plain.length>48*1024*1024)throw new Error('浏览器存储已达到容量上限');
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
      const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
      const payload=Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
      const temporary=join(this.directory,`state.${randomBytes(8).toString('hex')}.tmp`);
      try{
        const file=await open(temporary,'wx',0o600);try{await file.writeFile(payload);await file.sync();}finally{await file.close();}
        await rename(temporary,join(this.directory,'state'));
        this.registry=next;
        const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
      }finally{await unlink(temporary).catch(()=>{});}
    });
    this.writes=operation.catch(()=>{});await operation;
  }
}

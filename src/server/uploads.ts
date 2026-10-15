import {randomUUID} from 'node:crypto';
import type {FileChooser} from 'playwright-core';
export interface PendingFilePicker {id:string;chooser:FileChooser;accept:string;multiple:boolean}
interface Upload {id:string;picker:PendingFilePicker;epoch:string;expires:number;files:{name:string;mimeType:string;buffer:Buffer;received:number}[]}
export class Uploads {
 private active?:Upload;
 async handle(request:Record<string,unknown>,epoch:string,picker?:PendingFilePicker){
  if(this.active&&this.active.expires<Date.now())this.active=undefined;
  if(request.action==='begin'){
   if(!picker||request.pickerId!==picker.id||request.epoch!==epoch)throw new Error('文件选择请求已失效');
   if(this.active)throw new Error('已有上传进行中');
   const files=request.files as {name:string;size:number;mimeType:string}[];
   if(!Array.isArray(files)||!files.length||files.length>4||(!picker.multiple&&files.length>1))throw new Error('文件数量不合法');
   let total=0;
   for(const file of files){if(!file||typeof file.name!=='string'||!file.name||file.name.length>200||/[\\/\x00-\x1f]/.test(file.name)||['.','..'].includes(file.name)||!Number.isSafeInteger(file.size)||file.size<0||typeof file.mimeType!=='string'||file.mimeType.length>200||/[\r\n]/.test(file.mimeType))throw new Error('文件信息不合法');total+=file.size;}
   if(total>16*1024*1024)throw new Error('一次上传最多 16 MiB');
   this.active={id:randomUUID(),picker,epoch,expires:Date.now()+300000,files:files.map(f=>({name:f.name,mimeType:f.mimeType||'application/octet-stream',buffer:Buffer.alloc(f.size),received:0}))};
   return {id:this.active.id};
  }
  const upload=this.active;if(!upload||upload.id!==request.id)throw new Error('上传不存在或已过期');
  if(request.action==='cancel'){this.active=undefined;return {ok:true};}
  if(epoch!==upload.epoch||picker?.id!==upload.picker.id){this.active=undefined;throw new Error('页面已改变，上传已取消');}
  if(request.action==='chunk'){
   if(!Number.isInteger(request.index)||typeof request.data!=='string'||request.data.length>48000||!/^[A-Za-z0-9+/]*={0,2}$/.test(request.data))throw new Error('无效文件分块');
   const file=upload.files[request.index as number];if(!file||request.offset!==file.received)throw new Error('文件分块顺序不正确');
   const chunk=Buffer.from(request.data,'base64');if(!chunk.length||chunk.length>32768||file.received+chunk.length>file.buffer.length)throw new Error('文件分块超出范围');
   chunk.copy(file.buffer,file.received);file.received+=chunk.length;upload.expires=Date.now()+300000;return {received:file.received};
  }
  if(request.action==='finish'){
   if(upload.files.some(f=>f.received!==f.buffer.length))throw new Error('文件未上传完整');
   try{await upload.picker.chooser.setFiles(upload.files.map(({name,mimeType,buffer})=>({name,mimeType,buffer})));return {ok:true,finished:true};}
   finally{this.active=undefined;}
  }
  throw new Error('未知上传操作');
 }
 clear(){this.active=undefined;}
}

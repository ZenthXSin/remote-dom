import {randomBytes,randomInt} from 'node:crypto';
import {hostname,availableParallelism} from 'node:os';
import {readFile,writeFile,mkdir,open,link,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {DeviceProfile} from './device-profile.js';
export interface ContainerEnvironment {
 readonly version:1;readonly scope:'container';readonly hostname:string;readonly machineId:string;
 readonly os:Readonly<{id:'debian';version:'12'}>;readonly locale:'en_US.UTF-8';readonly timezoneId:string;
 readonly cpuIds:readonly number[];readonly memoryLimitBytes:number;readonly createdAt:string;
}
export function parseCpuSet(value:string):number[]{
 const cpus=new Set<number>();
 for(const part of value.trim().split(',')){const match=part.match(/^(\d+)(?:-(\d+))?$/);if(!match)throw new Error('Invalid CPU set');const start=Number(match[1]),end=Number(match[2]??match[1]);if(end<start||end-start>1024||end>65535)throw new Error('Invalid CPU range');for(let cpu=start;cpu<=end;cpu++)cpus.add(cpu);}
 return [...cpus].sort((a,b)=>a-b);
}
export function generateContainerEnvironment(profile:DeviceProfile,containerHostname:string,availableCpus:number[],memoryLimitBytes:number):ContainerEnvironment{
 if(!/^[a-z][a-z0-9-]{3,62}$/.test(containerHostname)||!availableCpus.length||!Number.isSafeInteger(memoryLimitBytes)||memoryLimitBytes<512*1024*1024)throw new Error('Invalid container environment');
 const count=Math.min(2,availableCpus.length),start=randomInt(availableCpus.length-count+1);
 return freeze({version:1,scope:'container',hostname:containerHostname,machineId:randomBytes(16).toString('hex'),os:{id:'debian',version:'12'},locale:'en_US.UTF-8',timezoneId:profile.timezoneId,cpuIds:availableCpus.slice(start,start+count),memoryLimitBytes,createdAt:new Date().toISOString()});
}
function freeze(value:ContainerEnvironment){Object.freeze(value.os);Object.freeze(value.cpuIds);return Object.freeze(value);}
function validate(value:ContainerEnvironment,profile:DeviceProfile){
 if(value?.version!==1||value.scope!=='container'||!/^[a-z][a-z0-9-]{3,62}$/.test(value.hostname)||!/^[a-f0-9]{32}$/.test(value.machineId)||value.os?.id!=='debian'||value.os.version!=='12'||value.locale!=='en_US.UTF-8'||value.timezoneId!==profile.timezoneId||!Array.isArray(value.cpuIds)||!value.cpuIds.length||value.cpuIds.length>2||value.cpuIds.some(n=>!Number.isSafeInteger(n)||n<0||n>65535)||new Set(value.cpuIds).size!==value.cpuIds.length||!Number.isSafeInteger(value.memoryLimitBytes)||value.memoryLimitBytes<512*1024*1024||!Number.isFinite(Date.parse(value.createdAt)))throw new Error('容器系统档案损坏或与浏览器档案不一致');
 return freeze(value);
}
export async function provisionEnvironment(path:string,create:()=>ContainerEnvironment,profile:DeviceProfile){
 try{return validate(JSON.parse(await readFile(path,'utf8')),profile)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await mkdir(dirname(path),{recursive:true});const temp=`${path}.${randomBytes(8).toString('hex')}.tmp`;
 try{await writeFile(temp,JSON.stringify(create(),null,2)+'\n',{flag:'wx',mode:0o644});const file=await open(temp,'r');try{await file.sync()}finally{await file.close()}
  try{await link(temp,path)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  return validate(JSON.parse(await readFile(path,'utf8')),profile);
 }finally{await unlink(temp).catch(()=>{})}
}
export async function verifyContainerEnvironment(path:string,profile:DeviceProfile){
 const environment=validate(JSON.parse(await readFile(path,'utf8')),profile);
 const [machineId,release,cgroupMemory,locale]=await Promise.all([readFile('/etc/machine-id','utf8'),readFile('/etc/os-release','utf8'),readFile('/sys/fs/cgroup/memory.max','utf8'),readFile('/usr/lib/locale/locale-archive').then(()=>true).catch(()=>false)]);
 if(hostname()!==environment.hostname||machineId.trim()!==environment.machineId||!/^ID=debian$/m.test(release)||!/^VERSION_ID="12"$/m.test(release)||process.env.LANG!==environment.locale||process.env.LC_ALL!==environment.locale||process.env.TZ!==environment.timezoneId||!locale||availableParallelism()!==environment.cpuIds.length||Number(cgroupMemory.trim())!==environment.memoryLimitBytes)throw new Error('系统环境与固定档案不一致，拒绝启动');
 return environment;
}

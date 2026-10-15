import {randomInt,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {mkdir,readFile,open,link,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';

const displays=[
  {name:'Linux desktop · 1080p',width:1920,height:1080,scale:1},
  {name:'Linux desktop · 1440p',width:2560,height:1440,scale:1},
  {name:'Linux laptop · FHD',width:1920,height:1080,scale:1.25},
  {name:'Linux laptop · HiDPI',width:1920,height:1200,scale:2},
] as const;
const zones=['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'] as const;
export interface DeviceProfile {
  readonly version:1;readonly id:string;readonly createdAt:string;readonly scope:'container';
  readonly device:string;readonly platform:'Linux'|'Android';readonly browser:'native Chromium';
  readonly screen:Readonly<{width:number;height:number}>;readonly deviceScaleFactor:number;
  readonly locale:'en-US';readonly timezoneId:string;readonly colorScheme:'light'|'dark';
  readonly isMobile:boolean;readonly hasTouch:boolean;
}
export function generateDeviceProfile():DeviceProfile {
  const display=displays[randomInt(displays.length)];
  return freezeProfile({version:1,id:randomUUID(),createdAt:new Date().toISOString(),scope:'container',
    device:display.name,platform:'Linux',browser:'native Chromium',screen:{width:display.width,height:display.height},
    deviceScaleFactor:display.scale,locale:'en-US',timezoneId:zones[randomInt(zones.length)],
    colorScheme:randomInt(2)?'light':'dark',isMobile:false,hasTouch:false});
}
function freezeProfile(profile:DeviceProfile):DeviceProfile {Object.freeze(profile.screen);return Object.freeze(profile);}
function parseProfile(value:unknown,containerKey:string):DeviceProfile {
  const record=value as {containerKey?:string;profile?:DeviceProfile};const p=record?.profile;
  if(record?.containerKey!==containerKey)throw new Error('设备档案属于其他容器；请使用该容器独立的档案路径');
  if(!p||p.version!==1||p.scope!=='container'||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(p.id)
    ||!Number.isFinite(Date.parse(p.createdAt))||!['Linux','Android'].includes(p.platform)||p.browser!=='native Chromium'
    ||p.locale!=='en-US'||!zones.some(z=>z===p.timezoneId)||!['light','dark'].includes(p.colorScheme)
    ||(p.platform==='Android'?!(p.device==='Pixel 7 · Android 模拟'&&p.isMobile===true&&p.hasTouch===true&&p.screen?.width===412&&p.screen?.height===915&&p.deviceScaleFactor===2.625):p.isMobile!==false||p.hasTouch!==false||!displays.some(d=>d.name===p.device&&d.width===p.screen?.width&&d.height===p.screen?.height&&d.scale===p.deviceScaleFactor)))
    throw new Error('容器设备档案损坏或版本不兼容；拒绝自动生成替代档案');
  return freezeProfile({version:1,id:p.id,createdAt:p.createdAt,scope:'container',device:p.device,
    platform:p.platform,browser:'native Chromium',screen:{width:p.screen.width,height:p.screen.height},deviceScaleFactor:p.deviceScaleFactor,
    locale:'en-US',timezoneId:p.timezoneId,colorScheme:p.colorScheme,isMobile:p.isMobile,hasTouch:p.hasTouch});
}
export async function loadContainerProfile(path:string,containerKey=hostname()):Promise<DeviceProfile> {
  const read=async()=>parseProfile(JSON.parse(await readFile(path,'utf8')),containerKey);
  try{return await read();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(dirname(path),{recursive:true});
  const temp=`${path}.${randomUUID()}.tmp`;const profile=generateDeviceProfile();
  try{
    const file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify({containerKey,profile},null,2)+'\n');await file.sync();}finally{await file.close();}
    // Publish a complete file without overwriting another startup's winner.
    try{await link(temp,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
    return await read();
  }finally{await unlink(temp).catch(()=>{});}
}

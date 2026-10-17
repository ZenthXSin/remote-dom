import {devices} from 'playwright-core';
import type {DeviceProfile} from './device-profile.js';
import type {DevicePreset} from '../shared/device-presets.js';

export function deviceEmulation(preset:DevicePreset,base:DeviceProfile,version:string){
  const desktop=(os:string)=>`Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  const android=devices['Pixel 7'];
  const screenOf=(device:typeof android)=>({...((device as typeof android & {screen?:{width:number;height:number}}).screen??device.viewport)});
  const defaults={screen:{...base.screen},deviceScaleFactor:base.deviceScaleFactor,isMobile:base.isMobile,hasTouch:base.hasTouch,
    userAgent:base.platform==='Android'?android.userAgent.replace(/Chrome\/[\d.]+/,`Chrome/${version}`):desktop('X11; Linux x86_64'),platform:'Linux x86_64'};
  if(preset==='default')return defaults;
  if(preset==='android')return {screen:screenOf(android),deviceScaleFactor:android.deviceScaleFactor,isMobile:true,hasTouch:true,userAgent:android.userAgent.replace(/Chrome\/[\d.]+/,`Chrome/${version}`),platform:'Linux armv8l'};
  if(preset==='ipad'||preset==='iphone'){
    const device=devices[preset==='ipad'?'iPad Pro 11':'iPhone 13'];
    return {screen:screenOf(device),deviceScaleFactor:device.deviceScaleFactor,isMobile:true,hasTouch:true,userAgent:device.userAgent,platform:preset==='ipad'?'iPad':'iPhone'};
  }
  return {screen:{width:1920,height:1080},deviceScaleFactor:preset==='macos'?2:1,isMobile:false,hasTouch:false,
    userAgent:desktop(preset==='windows'?'Windows NT 10.0; Win64; x64':preset==='macos'?'Macintosh; Intel Mac OS X 10_15_7':'X11; Linux x86_64'),
    platform:preset==='windows'?'Win32':preset==='macos'?'MacIntel':'Linux x86_64'};
}

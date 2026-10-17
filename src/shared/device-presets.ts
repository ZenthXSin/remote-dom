export const DEVICE_PRESETS=[
  {id:'default',label:'默认设备'},
  {id:'windows',label:'Windows'},
  {id:'android',label:'Android · Pixel 7'},
  {id:'macos',label:'macOS'},
  {id:'ipad',label:'iPad'},
  {id:'iphone',label:'iPhone'},
  {id:'linux',label:'Linux'},
] as const;
export type DevicePreset=typeof DEVICE_PRESETS[number]['id'];
export function isDevicePreset(value:unknown):value is DevicePreset{return DEVICE_PRESETS.some(p=>p.id===value);}

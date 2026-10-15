import {readConfig} from './config.js';
import {createApp} from './app.js';
const app=await createApp(readConfig());
console.log(`Remote DOM development engine: ${app.origin}`);
console.log('Development runner only. Chromium sandbox required; production startup is disabled.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});

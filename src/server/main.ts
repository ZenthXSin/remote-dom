import {readConfig} from './config.js';
import {createApp} from './app.js';
import {startDisplay} from './display.js';
const config=readConfig();const stopDisplay=await startDisplay(config.headless);
const app=await createApp(config).catch(error=>{stopDisplay();throw error;});
console.log(`Remote DOM development engine: ${app.origin}`);
console.log('Development runner only. Chromium sandbox required; production startup is disabled.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>{stopDisplay();process.exit(0);});});

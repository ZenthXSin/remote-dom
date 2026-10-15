import {readFile} from 'node:fs/promises';
import {createGateway} from './server.js';
import {persistentAccessKey} from './access-key.js';
const tls=process.env.GATEWAY_TLS_CERT&&process.env.GATEWAY_TLS_KEY?{cert:await readFile(process.env.GATEWAY_TLS_CERT),key:await readFile(process.env.GATEWAY_TLS_KEY)}:undefined;
const keyFile=process.env.GATEWAY_ACCESS_KEY_FILE,hours=Number(process.env.GATEWAY_TTL_HOURS??2);if(hours===0&&!keyFile)throw new Error('An unlimited gateway requires a persistent private access key');
const gateway=await createGateway({upstream:process.env.GATEWAY_UPSTREAM??'http://127.0.0.1:4173',publicOrigin:process.env.GATEWAY_PUBLIC_ORIGIN,host:process.env.GATEWAY_HOST??'127.0.0.1',port:Number(process.env.GATEWAY_PORT??4174),ttlMs:hours*3600000,capability:keyFile?await persistentAccessKey(keyFile):undefined,tls});
console.log(JSON.stringify({accessUrl:gateway.accessUrl,expiresAt:gateway.expiresAt,transport:'websocket'}));
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void gateway.close().then(()=>process.exit(0));});

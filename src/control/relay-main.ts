import {createUpstreamRelay} from './upstream-relay.js';
const relay=await createUpstreamRelay({profile:{id:process.env.PROFILE_ID!,name:'custom',ownerAccountId:process.env.UPSTREAM_PROXY_OWNER,mode:'custom',enabled:true,maxAccounts:1000,server:process.env.UPSTREAM_PROXY_SERVER,username:process.env.UPSTREAM_PROXY_USERNAME,password:process.env.UPSTREAM_PROXY_PASSWORD},ipv4Only:process.env.UPSTREAM_IPV4_ONLY==='1',host:'0.0.0.0',port:3128});
console.log('Fixed upstream relay ready; direct fallback is disabled.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void relay.close().then(()=>process.exit(0));});

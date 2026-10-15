import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {AccountStore} from './accounts.js';
import {DockerClient,DockerWorkers} from './workers.js';
import {createControl} from './server.js';
import {EgressStore} from './egress-store.js';

const state=process.env.CONTROL_STATE_DIR??'/var/lib/remote-dom-control';
const store=new AccountStore(join(state,'accounts.json'));await store.initialize();
const docker=new DockerClient(process.env.DOCKER_SOCKET),prefix=process.env.WORKER_PREFIX??'rd-browser';
if(!/^[a-z][a-z0-9-]{2,30}$/.test(prefix))throw new Error('Invalid worker prefix');
if(!store.list().length){const old=await docker.call<{Volumes:unknown[]|null}>('GET','/volumes?filters='+encodeURIComponent(JSON.stringify({label:[`remote-dom.project=${prefix}`]})));if(old.Volumes?.length)throw new Error('Account database is missing but tenant volumes exist; restore the control-state backup');const path=process.env.ADMIN_PASSWORD_FILE;if(!path)throw new Error('ADMIN_PASSWORD_FILE is required for first startup');await store.bootstrap(process.env.ADMIN_USERNAME??'admin',(await readFile(path,'utf8')).trim());}
const egress=new EgressStore(join(state,'egress.json'));await egress.initialize();
if(!egress.existed){const existing=await docker.call<{Labels:Record<string,string>}[]>('GET','/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify({label:['remote-dom.egress-profile']})));if(existing.some(c=>(c.Labels['remote-dom.project']===prefix||c.Labels['remote-dom.relay-project']===prefix)&&c.Labels['remote-dom.egress-profile']!=='server'))throw new Error('Egress database is missing for existing custom routes; restore the control-state backup');}
const workers=new DockerWorkers(docker,{
 prefix,image:process.env.WORKER_IMAGE??'remote-dom-engine:0.2',
 controller:process.env.CONTROLLER_CONTAINER??'remote-dom-control',proxy:process.env.PROXY_CONTAINER??'remote-dom-egress',
 seccomp:await readFile(process.env.WORKER_SECCOMP_FILE??resolve('deploy/chromium-seccomp.json'),'utf8'),
 maxRunning:Number(process.env.MAX_RUNNING_CONTAINERS??4),idleMs:Number(process.env.WORKER_IDLE_MINUTES??30)*60000,
 memoryBytes:Number(process.env.WORKER_MEMORY_MB??2048)*1024**2,cpus:Number(process.env.WORKER_CPUS??2),defaultUrl:process.env.DEFAULT_TARGET_URL,caFile:process.env.WORKER_CA_FILE,egress,relayImage:process.env.RELAY_IMAGE,egressNetwork:process.env.WORKER_EGRESS_NETWORK,
});await workers.start();
const [html,script]=await Promise.all(['account.html','account.js'].map(f=>readFile(resolve('dist/public',f),'utf8')));
const control=await createControl({store,workers,egress,html,script,host:process.env.CONTROL_HOST??'127.0.0.1',port:Number(process.env.CONTROL_PORT??4174),publicOrigin:process.env.CONTROL_PUBLIC_ORIGIN});
console.log('Remote DOM account control ready; browser containers remain development runners.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void control.close().then(()=>process.exit(0));});

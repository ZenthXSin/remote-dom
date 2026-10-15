import {mkdir,open,readFile,stat} from 'node:fs/promises';import {dirname} from 'node:path';import {randomBytes} from 'node:crypto';
export async function persistentAccessKey(path:string){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 try{const handle=await open(path,'wx',0o600);try{await handle.writeFile(randomBytes(32).toString('hex'));}finally{await handle.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const metadata=await stat(path);if(metadata.mode&0o077)throw new Error('Gateway access key must have private file permissions');
 const key=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Gateway access key is invalid; existing data was not replaced');return key;
}

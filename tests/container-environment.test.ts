import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {generateDeviceProfile} from '../src/server/device-profile.js';
import {parseCpuSet,generateContainerEnvironment,provisionEnvironment} from '../src/server/container-environment.js';
test('CPU affinity plan uses only allocated CPUs and stable container system identity',async t=>{
 assert.deepEqual(parseCpuSet('0-2,5,7-8'),[0,1,2,5,7,8]);for(const invalid of ['2-1','0-9999','-1','1;command'])assert.throws(()=>parseCpuSet(invalid));
 const profile=generateDeviceProfile();const create=()=>generateContainerEnvironment(profile,'desktop-abcdef',[0,1,2],2*1024**3);
 const dir=await mkdtemp(join(tmpdir(),'rd-env-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'environment.json');
 const first=await provisionEnvironment(path,create,profile);const second=await provisionEnvironment(path,create,profile);assert.deepEqual(first,second);assert.equal(first.cpuIds.length,2);assert.ok(first.cpuIds.every(id=>[0,1,2].includes(id)));assert.match(first.machineId,/^[a-f0-9]{32}$/);assert.equal(first.timezoneId,profile.timezoneId);assert.ok(Object.isFrozen(first.cpuIds));
 await writeFile(path,JSON.stringify({...first,timezoneId:'UTC'}));await assert.rejects(provisionEnvironment(path,create,profile),/不一致/);
});

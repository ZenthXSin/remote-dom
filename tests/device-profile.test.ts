import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadContainerProfile,generateDeviceProfile} from '../src/server/device-profile.js';

test('container profile survives repeated and concurrent startup; new containers have separate identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rd-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'one.json');
  const results=await Promise.all(Array.from({length:8},()=>loadContainerProfile(path,'container-one')));
  for(const profile of results)assert.deepEqual(profile,results[0]);
  assert.deepEqual(await loadContainerProfile(path,'container-one'),results[0]);
  assert.equal(Object.isFrozen(results[0]),true);assert.equal(Object.isFrozen(results[0].screen),true);
  const another=await loadContainerProfile(join(dir,'two.json'),'container-two');
  assert.notEqual(another.id,results[0].id);
  await assert.rejects(loadContainerProfile(path,'container-two'),/其他容器/);
});
test('corrupted profile is never regenerated or overwritten',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rd-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'broken.json');const p=generateDeviceProfile();
  const invalid=JSON.stringify({containerKey:'one',profile:{...p,deviceScaleFactor:9}});
  await writeFile(path,invalid);await assert.rejects(loadContainerProfile(path,'one'),/损坏/);
  assert.equal(await readFile(path,'utf8'),invalid);
  await writeFile(path,'{');await assert.rejects(loadContainerProfile(path,'one'));
  assert.equal(await readFile(path,'utf8'),'{');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectNodeAssets} from '../src/shared/assets.js';
test('resource discovery covers image, media, CSS and pseudo-elements without downloading literal text',()=>{
 const image='11111111-1111-4111-8111-111111111111',background='22222222-2222-4222-8222-222222222222',pseudo='33333333-3333-4333-8333-333333333333',literal='44444444-4444-4444-8444-444444444444';
 const ids=collectNodeAssets([{id:'n1',kind:'element',assetUrl:'asset:'+image,style:{'background-image':`url("asset:${background}")`},backdropStyle:{'background-image':`url(asset:${background})`},pseudoStyles:{before:{content:`url("asset:${pseudo}")`}},value:'asset:'+literal,attrs:{title:'asset:'+literal}},{id:'n2',kind:'text',text:'asset:'+literal}]);
 assert.deepEqual([...ids],[image,background,pseudo]);
 assert.equal(collectNodeAssets([{id:'n1',kind:'element',assetUrl:'asset:'+image+'-bad'}]).size,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packCapture,unpackCapture} from '../src/shared/capture-codec.js';
import type {CapturedDocument} from '../src/shared/protocol.js';
test('capture dictionaries preserve normal, SVG, pseudo and backdrop declarations without cross-document state',()=>{
 const style={color:'rgb(12, 34, 56)',width:'123.5px',transform:'matrix(1, 0, 0, 1, 0, 0)'};
 const doc={root:'n1',title:'test',url:'https://example.com/',scrollX:0,scrollY:0,focused:null,unsupported:[],truncated:false,nodes:[
  {id:'n1',kind:'element',tag:'div',style,children:['n2'],pseudoStyles:{before:{content:'"before"',...style}},backdropStyle:{'background-color':'rgba(0,0,0,0.5)'}},
  {id:'n2',kind:'element',namespace:'svg',tag:'path',style,attrs:{d:'M 0 0 L 1 1'}},
  {id:'n3',kind:'text',text:'你好'},
 ]} as CapturedDocument;
 const packed=packCapture(doc);assert.equal(packed.nodes[0].style,packed.nodes[1].style);
 assert.deepEqual(JSON.parse(JSON.stringify(unpackCapture(packed))),doc);
 const next=structuredClone(doc);next.nodes[0].style={color:'blue'};
 assert.deepEqual(JSON.parse(JSON.stringify(unpackCapture(packCapture(next)))),next);
 assert.deepEqual(JSON.parse(JSON.stringify(unpackCapture(packed))),doc);
});
test('invalid dictionary references fail rather than silently losing styles',()=>{
 assert.throws(()=>unpackCapture({codec:'styles-v1',strings:[],declarations:[[0,1]],nodes:[]} as any));
 assert.throws(()=>unpackCapture({codec:'styles-v1',strings:[],declarations:[],nodes:[{id:'n1',style:12}]} as any));
});

test('shared declarations are validated once and resource mappings stay document-local',async()=>{
 const {sanitizeDocument}=await import('../src/server/sanitize.js');
 const style={'background-image':'url(https://example.com/image.png)',position:'fixed',behavior:'url(evil)'};
 const raw={nodes:[{id:'n1',kind:'element',tag:'div',style},{id:'n2',kind:'element',tag:'div',style}],unsupported:[],title:''} as unknown as CapturedDocument;
 let calls=0;const first=sanitizeDocument(raw,()=>{calls++;return 'first';});
 assert.equal(calls,1);assert.equal(first.nodes[0].style,first.nodes[1].style);assert.equal(first.nodes[0].style?.behavior,undefined);
 const second=sanitizeDocument(raw,()=> 'second');assert.match(second.nodes[0].style!['background-image'],/asset:second/);
 assert.match(first.nodes[0].style!['background-image'],/asset:first/);
});

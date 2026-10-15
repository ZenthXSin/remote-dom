import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fontsFromCss} from '../src/server/fonts.js';
test('font rules resolve only HTTP assets and preserve safe native font descriptors',()=>{
 const fonts=fontsFromCss('@font-face{font-family:"Example Font";font-style:italic;font-weight:100 900;src:url(../font.woff2) format("woff2");unicode-range:U+0000-00FF}@font-face{font-family:Unsafe;src:url(file:///etc/passwd)}','https://public.test/css/site.css');
 assert.deepEqual(fonts,[{family:'Example Font',style:'italic',weight:'100 900',urls:['https://public.test/font.woff2'],unicodeRange:'U+0000-00FF'}]);
});

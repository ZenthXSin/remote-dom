import {test} from 'node:test';import assert from 'node:assert/strict';
import {Diagnostics,diagnosticTarget,diagnosticCookies,diagnosticSetCookies} from '../src/server/diagnostics.js';
test('diagnostics correlate paths without emitting credentials, query values or cookie bodies',()=>{
 const first=diagnosticTarget('https://user:secret@example.com/api/private?token=secret#secret');
 assert.equal(first.origin,'https://example.com');assert.equal(first.route,'api');assert.ok(!JSON.stringify(first).includes('secret'));assert.ok(!JSON.stringify(first).includes('/private'));
 assert.equal(first.pathId,diagnosticTarget('https://example.com/api/private?different=yes').pathId);assert.notEqual(first.pathId,diagnosticTarget('https://example.com/api/other').pathId);
 assert.equal(diagnosticTarget('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/pat/secret').route,'cloudflare-pat');
 assert.deepEqual(diagnosticCookies('other=secret; cf_clearance=secret; __cf_bm=secret'),{clearance:true,botManagement:true});assert.deepEqual(diagnosticCookies('fake_cf_clearance=secret'),{clearance:false,botManagement:false});
 assert.deepEqual(diagnosticSetCookies([{name:'Set-Cookie',value:'cf_clearance=secret; HttpOnly'},{name:'Set-Cookie',value:'other=secret'}]),{clearance:true,botManagement:false});
});
test('diagnostics stop releases instrumentation and retains bounded metadata',()=>{let stops=0;const d=new Diagnostics(()=>stops++);d.start();for(let i=0;i<3100;i++)d.add('test');const report=d.stop();assert.equal(report.events.length,3000);assert.ok(report.dropped>0);assert.equal(stops,1);d.stop();assert.equal(stops,1);d.add('ignored');assert.equal(d.report().events.length,3000);});

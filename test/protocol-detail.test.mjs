import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {safeProtocolName,ProtocolEvidence}=createRequire(import.meta.url)('../src/protocol-detail.cjs');

test('preserves unfamiliar machine field and event names without promoting opaque keys',()=>{
 for(const name of ['conversation_settings','completionOption','MessageBlock','CHUNK_DELTA','Chat.Message:Delta-v2','2001','x-bogus','msToken'])assert.equal(safeProtocolName(name),name);
 for(const name of ['person@example.com','https://example.com','c0f8d982-91c2-4132-a032-a63871f93024','john123456789','abcdef1234567890abcdef','sk-secrettokenvalue','a name','a\nname'])assert.equal(safeProtocolName(name),null);
});

test('unknown static schema is retained while all payload values and dynamic identifiers stay private',()=>{
 const e=new ProtocolEvidence();
 const d=e.inspect(JSON.stringify({completionOptions:{conversation_id:'PRIVATE_CONVERSATION_987654321',need_new_message:true},messages:[{local_message_id:'PRIVATE_MESSAGE_123456789',content_block:[{block_type:1,content:{text_block:{text:'PRIVATE_PROMPT',nonce:'PRIVATE_NONCE'}},account_name:'PRIVATE_ACCOUNT'}]}], 'person@example.com':{'839251625183251625':'PRIVATE_MAP_VALUE'},auth_token:'PRIVATE_TOKEN'}),{channel:'request-1'});
 assert.ok(d.fields.some(f=>f.path==='$.messages[*].content_block[*].content.text_block.text'));
 assert.ok(d.observations.some(o=>o.path.endsWith('conversation_id')&&o.alias==='id1'));
 assert.ok(d.observations.some(o=>o.path.endsWith('block_type')&&o.value===1));
 const output=JSON.stringify(d);assert.doesNotMatch(output,/PRIVATE_|person@example|839251625183251625/);assert.match(output,/\[key1\]/);
});

test('ID aliases remain equal across requests and responses without exposing actual values',()=>{
 const e=new ProtocolEvidence();
 const a=e.inspect('{"conversation_id":"PRIVATE_ID","local_message_id":"PRIVATE_MESSAGE"}',{channel:'request-1'});
 const b=e.inspect('{"meta":{"conversation_id":"PRIVATE_ID","message_id":"PRIVATE_MESSAGE"}}',{channel:'response-1'});
 assert.deepEqual(a.observations.map(o=>o.alias),b.observations.map(o=>o.alias));
 const c=e.inspect('{"conversation_id":"PRIVATE_ID","local_message_id":"OTHER_PRIVATE_MESSAGE"}',{channel:'request-2'});
 assert.equal(c.observations[0].alias,a.observations[0].alias);assert.notEqual(c.observations[1].alias,a.observations[1].alias);
 assert.doesNotMatch(JSON.stringify([a,b,c]),/PRIVATE_/);
});

test('probe observations distinguish streamed fragments from snapshots and repeated values',()=>{
 const marker='APG_PROBE_8dcf90e1';const e=new ProtocolEvidence({probes:[{id:'probe-1',marker}]});
 const a=e.inspect(JSON.stringify({text:'APG_PROBE_'}),{channel:'response-1'}).observations[0];
 const b=e.inspect(JSON.stringify({text:'8dcf90e1'}),{channel:'response-1'}).observations[0];
 assert.equal(a.relation,'first');assert.equal(b.relation,'changed');assert.deepEqual(b.matches,[]);assert.deepEqual(b.accumulatedMatches,[{probe:'probe-1',match:'exact'}]);
 const s1=e.inspect(JSON.stringify({text:'APG_'}),{channel:'response-2'}).observations[0];
 const s2=e.inspect(JSON.stringify({text:marker}),{channel:'response-2'}).observations[0];
 const s3=e.inspect(JSON.stringify({text:marker}),{channel:'response-2'}).observations[0];
 assert.equal(s1.relation,'first');assert.equal(s2.relation,'extends');assert.equal(s3.relation,'same');assert.deepEqual(s2.matches,[{probe:'probe-1',match:'exact'}]);
 assert.doesNotMatch(JSON.stringify([a,b,s1,s2,s3]),/8dcf90e1|APG_PROBE_/);
});

test('only explicit bounded control values are emitted',()=>{
 const e=new ProtocolEvidence();const d=e.inspect(JSON.stringify({status:200,code:91234567890,content_type:3,block_type:-1,is_finish:true,done:'1',type:'PRIVATE_TYPE',action:'append',role:'assistant',arbitrary_number:123456789012,arbitrary_text:'PRIVATE_BODY'}));
 assert.equal(d.observations.filter(o=>o.kind==='control').length,7);
 assert.doesNotMatch(JSON.stringify(d),/91234567890|123456789012|PRIVATE_TYPE|PRIVATE_BODY/);
});

test('timeline preserves original event case, frame order, and safe per-channel provenance',()=>{
 const e=new ProtocolEvidence();e.record('CHUNK_DELTA','{"text":"PRIVATE_ONE"}',{channel:'response-1'});e.record('MessageUpdate','{"is_finish":true}',{channel:'response-1'});e.record('2001','{}',{channel:'response-2'});
 const report=e.report();assert.deepEqual(report.timeline.map(x=>x.event),['CHUNK_DELTA','MessageUpdate','2001']);assert.deepEqual(report.timeline.map(x=>x.seq),[1,2,3]);assert.equal(report.markerSemantics,'unverified');assert.doesNotMatch(JSON.stringify(report),/PRIVATE_ONE/);
});

test('bounded evidence keeps final frames with explicit gaps and no sensitive caches in JSON',()=>{
 const marker='APG_PRIVATE_PROBE_8dcf';const e=new ProtocolEvidence({probes:[{id:'probe-1',marker}],maxTimeline:3,maxIds:1,maxNames:1,maxTextPaths:1,maxTextBytes:128});
 for(let i=0;i<8;i++)e.record('EVT_'+String(i),JSON.stringify({conversation_id:'PRIVATE_ID_'+i,text:'PRIVATE_TEXT_'+i}),{channel:'response-1'});
 const report=e.report();assert.equal(report.timeline.length,3);assert.equal(report.timeline.at(-1).seq,8);assert.ok(report.droppedFrames>0);assert.equal(report.truncated,true);
 assert.doesNotMatch(JSON.stringify(e),/PRIVATE_ID|PRIVATE_TEXT|APG_PRIVATE_PROBE/);
 const large=e.inspect(JSON.stringify({text:'x'.repeat(256)}),{channel:'response-2',maxBytes:128});assert.equal(large.format,'oversize');
 e.dispose();assert.equal(e.ids.size,0);assert.equal(e.names.size,0);assert.equal(e.texts.size,0);assert.deepEqual(e.probes,[]);assert.equal(e.inspect('{}').format,'disposed');assert.equal(e.report().timeline.length,3);
});

test('depth, arrays, getters, cycles and tiny timeline byte budgets are bounded',()=>{
 const e=new ProtocolEvidence({maxTimelineBytes:128});const v={items:Array.from({length:30},()=>({text:'PRIVATE'}))};v.self=v;Object.defineProperty(v,'getter',{enumerable:true,get(){throw Error('must not run')}});
 const d=e.inspect(v,{maxDepth:2,maxNodes:8,maxArray:2});assert.equal(d.truncated,true);assert.doesNotMatch(JSON.stringify(d),/PRIVATE/);
 e.record('DELTA',JSON.stringify(v.items),{channel:'response-1'});assert.equal(e.report().timeline.length,0);assert.equal(e.report().droppedFrames,1);
});

test('numeric dynamic object keys use stable aliases rather than exposing account IDs',()=>{
 const e=new ProtocolEvidence();const a=e.inspect('{"123456":{"message_id":"PRIVATE_ID"}}');const b=e.inspect('{"123456":{"message_id":"PRIVATE_ID"}}');
 assert.equal(a.fields[1].path,b.fields[1].path);assert.doesNotMatch(JSON.stringify([a,b]),/123456|PRIVATE_ID/);
});
test('SSE DONE is an explicit unverified sentinel and no-probe histories stay bounded',()=>{
 const e=new ProtocolEvidence({maxTextBytes:128});for(let i=0;i<5;i++)e.inspect(JSON.stringify({text:'x'.repeat(100)}),{channel:'response-1'});
 assert.equal(e.texts.get('response-1\0$.text').combined,'');
 const d=e.record('message','[DONE]',{channel:'response-1'});assert.equal(d.format,'sentinel');assert.equal(d.observations[0].value,'[DONE]');assert.equal(e.report().markerSemantics,'unverified');
});
test('control strings keep exact case and unknown boolean settings remain useful',()=>{
 const e=new ProtocolEvidence();const d=e.inspect('{"finish_reason":"STOP","status":"Completed","use_search":true,"EnableThinking":false,"type":"PRIVATE_TYPE"}');
 assert.equal(d.observations.find(o=>o.path==='$.finish_reason').value,'STOP');assert.equal(d.observations.find(o=>o.path==='$.status').value,'Completed');
 assert.equal(d.observations.find(o=>o.path==='$.use_search').kind,'boolean');assert.equal(d.observations.find(o=>o.path==='$.EnableThinking').value,false);assert.doesNotMatch(JSON.stringify(d),/PRIVATE_TYPE/);
});

test('encoded JSON strings reveal bounded nested schema and probe metadata without string contents',()=>{
 const marker='APG_PRIVATE_PROBE_123';const e=new ProtocolEvidence({probes:[{id:'probe-1',marker}]});
 const level3=JSON.stringify({third_level_secret:'PRIVATE_THIRD'});
 const level2=JSON.stringify({text:marker,hidden:level3});
 const level1=JSON.stringify({text_block:{serialized:level2},message_id:'PRIVATE_ID'});
 const d=e.inspect(JSON.stringify({message:{content:level1}}),{channel:'response-1'});
 assert.equal(d.observations.filter(o=>o.kind==='encoded-json').length,2);
 assert.ok(d.fields.some(f=>f.path==='$.message.content::<json>.text_block.serialized::<json>.text'));
 assert.ok(!d.fields.some(f=>f.path.includes('third_level_secret')));
 assert.ok(d.observations.some(o=>o.path.endsWith('::<json>.text')&&o.matches?.some(m=>m.probe==='probe-1')));
 assert.doesNotMatch(JSON.stringify(d),/PRIVATE_THIRD|PRIVATE_ID|APG_PRIVATE_PROBE_123/);
 const oversized=e.inspect(JSON.stringify({content:JSON.stringify({payload:'x'.repeat(17000)})}));assert.ok(!oversized.observations.some(o=>o.kind==='encoded-json'));
 const invalid=e.inspect('{"content":"{invalid PRIVATE_JSON"}');assert.ok(!invalid.observations.some(o=>o.kind==='encoded-json'));assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE_JSON/);
});

test('patch paths expose only known schema segments and small array indices',()=>{
 const e=new ProtocolEvidence();const d=e.inspect(JSON.stringify({patch:{path:'/message/blocks/0/content/text'},message:{blocks:[{content:{text:'PRIVATE_BODY'}}]}}));
 const path=d.observations.find(o=>o.kind==='protocol-path');assert.equal(path.validated,true);assert.deepEqual(path.segments,[{field:'message'},{field:'blocks'},{index:0},{field:'content'},{field:'text'}]);
 const next=e.inspect(JSON.stringify({jsonPath:'$.message["blocks"][0].content.text',other_path:'/users/PRIVATE_USERNAME',target_path:'https://private.example/token',field_path:'/message/blocks/123456/text'}));
 assert.equal(next.observations.find(o=>o.path==='$.jsonPath').validated,true);
 for(const field of ['other_path','target_path','field_path'])assert.equal(next.observations.find(o=>o.path==='$.'+field).validated,false);
 assert.doesNotMatch(JSON.stringify([d,next]),/PRIVATE_BODY|PRIVATE_USERNAME|private\.example|123456/);
});

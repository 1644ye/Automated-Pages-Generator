import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {setImmediate as nextTurn} from 'node:timers/promises';

const require=createRequire(import.meta.url);
const {installFetchProbe}=require('../src/doubao-fetch-probe.cjs');
const {createAnswerRuntime}=require('../src/doubao-answer.cjs');

// All requests, IDs, responses, headers, timestamps and numeric controls here
// are synthetic. This VM does not launch a browser or access the network.
const endpoint='https://www.doubao.com/chat/completion';
const key='__apg_probe_synthetic_0123456789';
const makeProbe=(id,label)=>{const marker='APG_PROBE_'+label+'_0123456789abcdef';return {id,marker,prompt:'请严格只回复这一行文字，不要添加解释、引号或代码块：\n'+marker}};
const config={key,probes:[makeProbe('probe-1','ONE'),makeProbe('probe-2','TWO')],test:makeProbe('probe-3','THREE'),durationMs:180000};
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function body(number,patch={},probeConfig=config){
 const initial=number===1;
 const value={client_meta:{conversation_id:initial?'':'synthetic-conversation',bot_id:'synthetic-bot',last_section_id:initial?'':'synthetic-section',last_message_index:initial?null:1},messages:[{local_message_id:uid(number*3),content_block:[{block_id:uid(number*3+1),block_type:10000,content:{text_block:{text:probeConfig.probes[number-1].prompt}}}]}],option:{need_create_conversation:initial,unique_key:uid(number*3+2),create_time_ms:Date.now(),start_seq:0,recovery_option:{req_create_time_sec:0}}};
 return Object.assign(value,patch);
}
function sse(request,number,change){
 const text=request.messages[0].content_block[0].content.text_block.text.split('\n').at(-1),question='synthetic-question-'+number,answer='synthetic-answer-'+number;
 const block=(text,finish=false)=>({block_type:10000,block_id:'synthetic-block-'+number,content:{text_block:text===undefined?{}:{text}},is_finish:finish,patch_type:finish?9:4});
 const patch=v=>({patch_object:7,patch_type:8,patch_value:v});
 const events=[
  ['SSE_ACK',{query_list:[{local_message_id:request.messages[0].local_message_id,question_id:question,message_index:(number-1)*2}],ack_client_meta:{conversation_id:'synthetic-conversation',section_id:'synthetic-section'}}],
  ['FULL_MSG_NOTIFY',{message:{message_id:question,local_message_id:request.messages[0].local_message_id,conversation_id:'synthetic-conversation',section_id:'synthetic-section',index_in_conv:(number-1)*2,content_block:[{block_type:10000,content:{text_block:{text:request.messages[0].content_block[0].content.text_block.text}}}]}}],
  ['STREAM_MSG_NOTIFY',{meta:{message_id:answer,bot_reply_message_id:question,conversation_id:'synthetic-conversation',section_id:'synthetic-section',sender_id:request.client_meta.bot_id,index_in_conv:(number-1)*2+1},content:{content_block:[block(text.slice(0,2))]}}],
  ['STREAM_CHUNK',{message_id:answer,patch_op:[patch({content_block:[block(text.slice(2,3))]})]}],
  ['STREAM_CHUNK',{message_id:answer,patch_op:[patch({tts_content:'synthetic-tts-ignored'})]}],
  ['CHUNK_DELTA',{text:text.slice(3)}],
  ['STREAM_CHUNK',{message_id:answer,patch_op:[patch({content_block:[block(undefined,true)]})]}],
  ['STREAM_CHUNK',{message_id:answer,patch_op:[patch({ext:{is_finish:'1'}})]}],
  ['SSE_REPLY_END',{end_type:20,msg_finish_attr:{msgid:answer,brief:text}}],
  ['SSE_REPLY_END',{end_type:21,answer_finish_attr:{has_suggest:true}}],
  ['SSE_REPLY_END',{end_type:22}],
 ];
 change?.(events,number);
 return events.map(([event,value])=>'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n').join('');
}
function setup({change,status=()=>200,reject=()=>false,probeConfig=config}={}){
 const calls=[],timers=new Map();let timerId=0,uuidSeq=100;
 const original=function(input,init){
  const n=calls.length+1;calls.push({input,init});
  if(reject(n))return Promise.reject(Error('secret URL and credential must not appear'));
  if(input instanceof Request)return Promise.resolve(new Response('synthetic passthrough'));
  const request=JSON.parse(init.body),data=sse(request,n,change);
  return Promise.resolve(new Response(data,{status:status(n),headers:{'content-type':'text/event-stream; charset=utf-8'}}));
 };
 const window={fetch:original,location:{origin:'https://www.doubao.com',href:'https://www.doubao.com/chat/'}};
 const sandbox={window,URL,Headers,Response,Request,ReadableStream,TextDecoder,TextEncoder,Uint8Array,AbortController,crypto:{randomUUID:()=>uid(uuidSeq++)},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},config:probeConfig};
 const initial=runInNewContext('('+installFetchProbe.toString()+')(config,('+createAnswerRuntime.toString()+'))',sandbox);
 const api=window[key];
 const plain=()=>JSON.parse(JSON.stringify(api.snapshot()));
 async function send(n,{request=body(n,{},probeConfig),url=endpoint,headers={'content-type':'application/json','x-synthetic-secret':'not-for-report'}}={}){const response=await window.fetch(url,{method:'POST',headers,body:JSON.stringify(request)});await response.text();for(let i=0;i<20&&['observing','testing'].includes(plain().phase);i++){if(n===1&&plain().probes[0].complete)break;await nextTurn()}return plain()}
 async function settle(){for(let i=0;i<20&&plain().phase==='testing';i++)await nextTurn();return plain()}
 return {api,window,original,initial,calls,timers,plain,send,settle};
}

test('install only observes; two manual exact replies permit one background synthetic test',async()=>{
 const app=setup();assert.equal(app.calls.length,0);assert.equal(app.initial.phase,'observing');assert.notEqual(app.window.fetch,app.original);
 await app.send(1);const ready=await app.send(2);assert.equal(ready.phase,'ready');assert.equal(ready.requestShapeReady,true);
 const first=app.api.test();assert.equal(first.phase,'testing');assert.equal(app.calls.length,3);
 assert.throws(()=>app.api.test(),/不会重复发送/);
 const result=await app.settle();assert.equal(result.phase,'passed');assert.equal(result.test.exact,true);assert.equal(result.test.complete,true);assert.equal(app.window.fetch,app.original);
 const sent=JSON.parse(app.calls[2].init.body);assert.equal(sent.messages[0].content_block[0].content.text_block.text,config.test.prompt);assert.equal(sent.client_meta.last_message_index,3);assert.equal(sent.client_meta.conversation_id,'synthetic-conversation');assert.notEqual(sent.messages[0].local_message_id,uid(6));
 assert.ok(app.calls[2].init.signal instanceof AbortSignal);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-conversation|synthetic-bot|not-for-report|local_message_id|a_bogus|unique_key|00000000/);
 app.api.dispose();
});

test('an input URL carrying a signature blocks replay without altering manual calls',async()=>{
 const app=setup();await app.send(1,{url:endpoint+'?a_bogus=synthetic-secret-one'});const result=await app.send(2,{url:endpoint+'?a_bogus=synthetic-secret-two'});
 assert.equal(result.phase,'blocked');assert.equal(result.preSignInput,false);assert.match(result.reason,/已带签名/);assert.equal(app.calls.length,2);assert.throws(()=>app.api.test(),/尚未就绪/);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);assert.equal(app.window.fetch,app.original);
});

test('protected headers also block background replay and never enter report',async()=>{
 const app=setup();await app.send(1,{headers:{authorization:'synthetic-secret'}});const result=await app.send(2,{headers:{authorization:'synthetic-secret'}});
 assert.equal(result.phase,'blocked');assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);assert.equal(app.calls.length,2);
});

test('unknown last-message relation is rejected rather than inferred by adding one',async()=>{
 const app=setup();await app.send(1);const request=body(2);request.client_meta.last_message_index=101;const result=await app.send(2,{request});assert.equal(result.phase,'blocked');assert.match(result.reason,/序号.*映射/);assert.equal(app.calls.length,2);
});

test('unsupported request object is passed through but disables experiment',async()=>{
 const app=setup();await app.window.fetch(new Request(endpoint,{method:'POST',body:JSON.stringify(body(1))}));assert.equal(app.calls.length,1);assert.equal(app.plain().phase,'blocked');assert.match(app.plain().reason,/Request/);assert.equal(app.window.fetch,app.original);
});

test('ordinary conversation or out-of-order probe invalidates pending calibration',async()=>{
 for(const n of [0,2]){const app=setup(),request=body(n||1);if(!n)request.messages[0].content_block[0].content.text_block.text='ordinary unrelated task';await app.send(1,{request});assert.equal(app.plain().phase,'blocked');assert.equal(app.calls.length,1);assert.equal(app.window.fetch,app.original)}
});

test('profile changes or non-exact answers cannot enable a background test',async()=>{
 for(const mode of ['profile','text']){const app=setup({change(events,n){if(n===2){if(mode==='profile')events[3][1].patch_op[0].patch_type=99;else events[5][1].text+='unexpected'}}});await app.send(1);await app.send(2);assert.equal(app.plain().phase,'blocked');assert.equal(app.calls.length,2);assert.throws(()=>app.api.test(),/尚未就绪/)}
});

test('HTTP failure and rejection pause once without leaking error text or retrying',async()=>{
 for(const fail of ['http','throw']){const app=setup({status:n=>n===3&&fail==='http'?429:200,reject:n=>n===3&&fail==='throw'});await app.send(1);await app.send(2);app.api.test();await app.settle();assert.equal(app.plain().phase,'blocked');assert.equal(app.calls.length,3);assert.doesNotMatch(JSON.stringify(app.plain()),/secret URL/);assert.throws(()=>app.api.test(),/不会重复发送/)}
});

test('timeout and dispose restore only the owned fetch and clear readiness',async()=>{
 const app=setup();const timer=[...app.timers.values()][0];timer.fn();assert.equal(app.plain().phase,'blocked');assert.equal(app.window.fetch,app.original);assert.equal(app.calls.length,0);
 const second=setup();const replacement=()=>{};second.window.fetch=replacement;second.api.dispose();assert.equal(second.window.fetch,replacement);assert.equal(second.plain().phase,'disposed');assert.equal(second.plain().requestShapeReady,false);assert.equal(second.timers.size,0);
});

test('unsafe dynamic values fail closed before background traffic',async()=>{
 for(const field of ['time','recovery','uuid','seq']){const app=setup();await app.send(1);const request=body(2);if(field==='time')request.option.create_time_ms=42;if(field==='recovery')request.option.recovery_option.req_create_time_sec=42;if(field==='uuid')request.option.unique_key='opaque-unadapted';if(field==='seq')request.option.start_seq=19;await app.send(2,{request});assert.equal(app.plain().phase,'blocked',field);assert.equal(app.calls.length,2,field)}
});

test('UUID relationships and the observed question-index mapping are preserved',async()=>{
 for(const relation of ['message','block']){
  const app=setup();const a=body(1),b=body(2);
  for(const request of [a,b])request.option.unique_key=relation==='message'?request.messages[0].local_message_id:request.messages[0].content_block[0].block_id;
  b.client_meta.last_message_index=0;
  await app.send(1,{request:a});await app.send(2,{request:b});assert.equal(app.plain().phase,'ready');app.api.test();await app.settle();
  const sent=JSON.parse(app.calls[2].init.body);assert.equal(sent.client_meta.last_message_index,2);assert.equal(sent.option.unique_key,relation==='message'?sent.messages[0].local_message_id:sent.messages[0].content_block[0].block_id);assert.equal(app.plain().phase,'passed');
 }
});

test('dispose during the background test aborts its signal and never retries',async()=>{
 const app=setup();await app.send(1);await app.send(2);app.api.test();const signal=app.calls[2].init.signal;app.api.dispose();assert.equal(signal.aborted,true);await nextTurn();assert.equal(app.calls.length,3);assert.equal(app.plain().phase,'disposed');assert.equal(app.window.fetch,app.original);
});

test('parser failure reports fixed diagnostic signals and byte counts, never response content',async()=>{
 const app=setup({change(events){events[8][1].msg_finish_attr.msgid='private-unrelated-id'}});await app.send(1);
 const record=app.plain().probes[0];assert.equal(app.plain().phase,'blocked');assert.ok(record.parserError);assert.ok(record.frames>0);assert.ok(record.bytes>0);assert.equal(record.signals.blockFinished,true);assert.equal(record.complete,false);assert.doesNotMatch(JSON.stringify(app.plain()),/private-unrelated-id|synthetic-bot|synthetic-conversation/);
});

test('a test timeout aborts its request and cannot later become a passing result',async()=>{
 const app=setup();await app.send(1);await app.send(2);app.api.test();const signal=app.calls[2].init.signal;
 const deadline=[...app.timers.values()].find(t=>t.ms===60000);assert.ok(deadline);deadline.fn();await nextTurn();
 assert.equal(app.plain().phase,'blocked');assert.equal(signal.aborted,true);assert.equal(app.calls.length,3);assert.equal(app.plain().test.complete,false);assert.equal(app.window.fetch,app.original);
});

const triple={...config,probes:[...config.probes,makeProbe('probe-3','THREE')],test:makeProbe('probe-4','FOUR')};
async function calibrateThree(cursors,extra={}){
 const app=setup({probeConfig:triple,...extra});await app.send(1);
 for(let n=2;n<=3;n++){const request=body(n,{},triple);request.client_meta.last_message_index=cursors[n-2];await app.send(n,{request});if(n===2)assert.equal(app.plain().phase,'observing')}
 return app;
}
test('three manual rounds learn a constant request cursor without changing it',async()=>{
 const app=await calibrateThree([0,0]);assert.equal(app.plain().phase,'ready');assert.equal(app.calls.length,3);
 assert.equal(app.plain().cursorEvidence.next,0);app.api.test();assert.equal((await app.settle()).phase,'passed');
 assert.equal(JSON.parse(app.calls[3].init.body).client_meta.last_message_index,0);assert.equal(app.calls.length,4);app.api.dispose();
});
test('cursor offset is accepted only after both observed transitions agree',async()=>{
 const app=await calibrateThree([8,10]);assert.equal(app.plain().phase,'ready');assert.equal(app.plain().cursorEvidence.next,12);
 app.api.test();assert.equal((await app.settle()).phase,'passed');assert.equal(JSON.parse(app.calls[3].init.body).client_meta.last_message_index,12);app.api.dispose();
});
function spacedIndices(events,n){const index=(n-1)*5+1;events[0][1].query_list[0].message_index=index;events[1][1].message.index_in_conv=index;events[2][1].meta.index_in_conv=index+1}
test('nonlinear cursors allow only an explicit one-shot synthetic attempt with the observed value',async()=>{
 const app=await calibrateThree([5,7],{change:spacedIndices});assert.equal(app.plain().phase,'ready');
 assert.deepEqual(app.plain().cursorEvidence.rows.map(r=>r.request),[null,5,7]);
 assert.equal(app.plain().cursorEvidence.mode,'observed-reuse-experiment');assert.equal(app.plain().cursorEvidence.next,7);
 assert.equal(app.calls.length,3);app.api.test();assert.equal((await app.settle()).phase,'passed');
 const sent=JSON.parse(app.calls[3].init.body);assert.equal(sent.client_meta.last_message_index,7);
 assert.equal(sent.messages[0].content_block[0].content.text_block.text,triple.test.prompt);
 assert.notEqual(sent.messages[0].local_message_id,uid(9));assert.throws(()=>app.api.test());assert.equal(app.calls.length,4);app.api.dispose();
});
test('server rejection of the observed-cursor experiment stops without retries',async()=>{
 const app=setup({probeConfig:triple,change:spacedIndices,status:n=>n===4?409:200});await app.send(1);
 for(let n=2;n<=3;n++){const request=body(n,{},triple);request.client_meta.last_message_index=n===2?5:7;await app.send(n,{request})}
 assert.equal(app.plain().phase,'ready');app.api.test();assert.equal((await app.settle()).phase,'blocked');
 assert.equal(app.calls.length,4);assert.equal(app.plain().test.httpStatus,409);assert.throws(()=>app.api.test());app.api.dispose();
});

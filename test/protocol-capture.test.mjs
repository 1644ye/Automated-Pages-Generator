import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const {ProtocolCapture}=createRequire(import.meta.url)('../src/protocol-capture.cjs');
const b64=text=>Buffer.from(text).toString('base64');
class Debugger extends EventEmitter {
 constructor(handlers={}){super();this.handlers=handlers;this.commands=[];this.attached=false;this.detachCount=0}
 attach(){this.attached=true}isAttached(){return this.attached}
 detach(){this.detachCount++;this.attached=false;this.emit('detach',{},'target closed')}
 async sendCommand(method,params){this.commands.push({method,params});return this.handlers[method]?.(params)||{}}
 event(method,params){this.emit('message',{},'Network.'+method,params)}
}
function setup(handlers={},options={}){const d=new Debugger(handlers);const c=new ProtocolCapture({debugger:d,getURL:()=> 'https://www.doubao.com/chat/'},{...options});return {d,c}}
function request(d,id='synthetic-request-id',patch={}){d.event('requestWillBeSent',{requestId:id,type:'Fetch',request:{url:'https://www.doubao.com/api/chat?token=SECRET_QUERY',method:'POST',headers:{Cookie:'SECRET_COOKIE',Authorization:'SECRET_AUTH'},postData:JSON.stringify({conversation_id:'SECRET_CONVERSATION',message:{content:'SECRET_PROMPT'}}),...patch}})}
function response(d,id='synthetic-request-id',mimeType='text/event-stream'){d.event('responseReceived',{requestId:id,response:{url:'https://www.doubao.com/api/chat',status:200,mimeType,headers:{'set-cookie':'SECRET_SET_COOKIE'}}})}
test('explicit observer captures shapes only, filters unrelated traffic, and never sends requests',async()=>{
 const {d,c}=setup({'Network.streamResourceContent':()=>({bufferedData:b64('data: {"delta":{"content":"SECRET_REPLY"}}\n\ndata: [DONE]\n\n')})});
 request(d,'before-start');await c.start();request(d,'foreign',{url:'https://example.com/chat'});request(d,'account',{url:'https://www.doubao.com/account/profile'});request(d,'history',{method:'GET'});request(d);response(d);
 await delay(0);d.event('loadingFinished',{requestId:'synthetic-request-id'});await delay(0);
 const report=await c.stop();assert.equal(report.requests.length,1);assert.equal(report.requests[0].httpEnded,true);assert.equal(report.requests[0].stream.transportEnded,true);
 assert.ok(report.requests[0].stream.observedEndMarkers.some(m=>m.value==='[DONE]'));
 assert.doesNotMatch(JSON.stringify(report),/SECRET_|synthetic-request-id|Cookie|Authorization|set-cookie/);
 assert.deepEqual(d.commands.map(x=>x.method),['Network.enable','Network.streamResourceContent']);assert.equal(d.detachCount,1);assert.equal(d.listenerCount('message'),0);
 assert.strictEqual(await c.stop(),report);
});
test('buffered bytes precede chunks received during stream activation',async()=>{
 let release;const {d,c}=setup({'Network.streamResourceContent':()=>new Promise(r=>release=r)});await c.start();request(d);response(d);
 d.event('dataReceived',{requestId:'synthetic-request-id',data:b64('"SECRET_REPLY"}}\n\ndata: [DONE]\n\n')});
 release({bufferedData:b64('data: {"delta":{"content":')});await delay(0);d.event('loadingFinished',{requestId:'synthetic-request-id'});await delay(0);
 const r=(await c.stop()).requests[0];assert.equal(r.stream.invalidPayloads,0);assert.equal(r.stream.eventCount,2);assert.doesNotMatch(JSON.stringify(r),/SECRET/);
});
test('unsupported streaming falls back to completed body without replaying',async()=>{
 const {d,c}=setup({'Network.streamResourceContent':()=>Promise.reject(Error('unsupported')),'Network.getResponseBody':()=>({body:'{"content":"SECRET_REPLY","done":true}',base64Encoded:false})});
 await c.start();request(d);response(d,undefined,'application/json');await delay(0);d.event('loadingFinished',{requestId:'synthetic-request-id'});await delay(0);
 const r=(await c.stop()).requests[0];assert.equal(r.bodySource,'cdp-completed-body');assert.ok(r.response.fields.some(f=>f.path==='$.content'));assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.ok(d.commands.every(x=>['Network.enable','Network.streamResourceContent','Network.getResponseBody'].includes(x.method)));
});
test('stop drops late replies, partial stream is not declared transport-complete',async()=>{
 let release;const {d,c}=setup({'Network.streamResourceContent':()=>new Promise(r=>release=r)});await c.start();request(d);response(d);
 const report=await c.stop();const snapshot=JSON.stringify(report);release({bufferedData:b64('data: {"text":"SECRET_LATE"}\n\n')});await delay(0);
 request(d,'after-stop');assert.equal(JSON.stringify(report),snapshot);assert.equal(report.requests[0].stream.transportEnded,false);assert.equal(report.requests[0].bodyIncomplete,true);assert.equal(c.records.size,0);
});
test('never detaches a debugger owned by another tool',async()=>{
 const {d,c}=setup();d.attached=true;await assert.rejects(c.start(),/占用/);assert.equal(d.detachCount,0);assert.equal(d.commands.length,0);
});
test('failed setup detaches only own debugger and exposes no raw protocol error',async()=>{
 const {d,c}=setup({'Network.enable':()=>Promise.reject(Error('SECRET_ERROR'))});await assert.rejects(c.start(),/无法启动/);assert.equal(d.detachCount,1);assert.equal(d.listenerCount('message'),0);assert.equal(c.phase,'failed');
});
test('timeout ends observation, failed HTTP is distinct from completion',async()=>{
 let c;const result=setup({}, {durationMs:15,onTimeout:reason=>c.stop(reason)});c=result.c;const d=result.d;
 await c.start();request(d);response(d);await delay(0);d.event('loadingFailed',{requestId:'synthetic-request-id',errorText:'SECRET_ERROR'});await delay(40);
 const report=await c.stop();assert.equal(report.reason,'timeout');assert.equal(report.requests[0].httpEnded,false);assert.equal(report.requests[0].httpFailed,true);assert.equal(report.requests[0].stream.transportEnded,false);assert.equal(d.isAttached(),false);
});
test('request and byte limits cannot produce a joined false completion marker',async()=>{
 const {d,c}=setup({'Network.streamResourceContent':()=>({bufferedData:''})},{maxRequests:1,maxBytes:128});await c.start();request(d);request(d,'second');response(d);await delay(0);
 d.event('dataReceived',{requestId:'synthetic-request-id',data:b64('data: '+ 'X'.repeat(200))});d.event('dataReceived',{requestId:'synthetic-request-id',data:b64('data: [DONE]\n\n')});
 const report=await c.stop();assert.equal(report.requests.length,1);assert.ok(report.issues.includes('request-limit'));assert.equal(report.requests[0].truncated,true);assert.equal(report.requests[0].stream.observedEndMarkers.length,0);
});
test('redirect outside scope stops response collection and drops websocket payloads',async()=>{
 const {d,c}=setup();await c.start();request(d);request(d,undefined,{url:'https://example.com/chat'});response(d);d.event('webSocketFrameReceived',{requestId:'synthetic-request-id',response:{payloadData:'SECRET_WEBSOCKET'}});
 const report=await c.stop();assert.equal(report.requests[0].redirected,true);assert.equal(report.requests[0].stream,undefined);assert.equal(d.commands.length,1);assert.doesNotMatch(JSON.stringify(report),/SECRET_WEBSOCKET/);
});
test('HTTP EOF cannot flush a discarded NDJSON suffix into a false end marker',async()=>{
 const {d,c}=setup({'Network.streamResourceContent':()=>({bufferedData:''})},{maxBytes:128});await c.start();request(d);response(d,undefined,'application/x-ndjson');await delay(0);
 d.event('dataReceived',{requestId:'synthetic-request-id',data:b64('{"done":true}')});d.event('dataReceived',{requestId:'synthetic-request-id',data:b64('X'.repeat(200))});d.event('loadingFinished',{requestId:'synthetic-request-id'});await delay(0);
 const r=(await c.stop()).requests[0];assert.equal(r.httpEnded,true);assert.equal(r.bodyIncomplete,true);assert.equal(r.stream.transportEnded,false);assert.equal(r.stream.observedEndMarkers.length,0);
});
test('user-triggered EventSource and NDJSON are supported without reading historical requests',async()=>{
 const {d,c}=setup({'Network.streamResourceContent':()=>({bufferedData:b64('{"delta":"SECRET_ONE"}\n{"done":true}\n')})});await c.start();
 d.event('requestWillBeSent',{requestId:'event-source',type:'EventSource',request:{url:'https://www.doubao.com/api/stream',method:'GET'}});response(d,'event-source','application/x-ndjson');await delay(0);d.event('loadingFinished',{requestId:'event-source'});await delay(0);
 const r=(await c.stop()).requests[0];assert.equal(r.method,'GET');assert.equal(r.stream.eventCount,2);assert.equal(r.stream.transportEnded,true);assert.ok(r.stream.observedEndMarkers.some(m=>m.kind==='boolean-end-flag'));assert.doesNotMatch(JSON.stringify(r),/SECRET_ONE/);
});

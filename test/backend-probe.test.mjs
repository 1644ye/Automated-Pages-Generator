import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// Synthetic Electron boundary only. No browser, credentials or network.
function setup(){
 const source=readFileSync(new URL('../src/backend-probe.cjs',import.meta.url),'utf8');
 const page={phase:'observing',probes:[],test:{sent:false}};const calls=[];
 const contents=new EventEmitter();const debug=new EventEmitter();let attached=false;
 Object.assign(debug,{isAttached:()=>attached,attach(){attached=true},detach(){attached=false},async sendCommand(method){calls.push(method)}});
 Object.assign(contents,{debugger:debug,isDestroyed:()=>false,getURL:()=> 'https://www.doubao.com/chat/',async executeJavaScript(code){calls.push(code);return structuredClone(page)}});
 const module={exports:{}};runInNewContext(source,{module,URL,Date,JSON,setTimeout,clearTimeout,setInterval:()=>({unref(){}}),clearInterval(){},require(name){
  if(name==='node:crypto')return {randomUUID};if(name==='./doubao-answer.cjs')return {createAnswerRuntime:function(){}};
  if(name==='./doubao-fetch-probe.cjs')return {installFetchProbe:function(){}};throw Error(name);
 }});
 const host=new module.exports.BackendProbe(contents);return {host,page,calls,contents};
}
function request(host,probe,signature){host.observe({request:{method:'POST',url:'https://www.doubao.com/chat/completion?a_bogus='+signature,postData:JSON.stringify({messages:[{content_block:[{content:{text_block:{text:probe.prompt}}}]}]})}})}

test('probe start injects an observer but performs no send, and reports no sensitive data',async()=>{
 const {host,calls}=setup();await host.start();assert.equal(calls[0],'Network.enable');
 assert.equal(calls.length,2);assert.equal(host.snapshot().test.sent,false);
 request(host,host.probes[0],'synthetic-private-signature');
 assert.ok(!JSON.stringify(host.snapshot()).includes('synthetic-private-signature'));
 const report=await host.stop();assert.ok(!JSON.stringify(report).includes(host.probes[0].prompt));
 assert.equal(host.signatures.size,0);assert.equal(host.attached,false);
});

test('background test is gated by two unique and different signed manual requests',async()=>{
 const {host,page,calls}=setup();await host.start();page.phase='ready';await host.poll();
 await assert.rejects(host.runTest(),/尚未观察/);
 request(host,host.probes[0],'sig-a');request(host,host.probes[1],'sig-a');request(host,host.probes[2],'sig-d');
 await assert.rejects(host.runTest(),/尚未观察/);
 host.signatures.set('probe-2','sig-b');await host.runTest();
 assert.ok(calls.at(-1).includes('.test()'));await host.stop();
});

test('a complete page probe requires a newly observed signature for verified status',async()=>{
 const {host,page}=setup();await host.start();
 request(host,host.probes[0],'sig-a');request(host,host.probes[1],'sig-b');request(host,host.probes[2],'sig-d');
 page.phase='passed';page.test={sent:true,complete:true,exact:true};await host.poll();
 assert.equal(host.snapshot().verified,false);
 request(host,host.test,'sig-b');assert.equal(host.snapshot().signature,'reused');assert.equal(host.snapshot().verified,false);
 host.network.delete('probe-4');request(host,host.test,'sig-c');assert.equal(host.snapshot().verified,true);
 request(host,host.test,'sig-c');assert.equal(host.snapshot().verified,false);assert.equal(host.snapshot().signature,'duplicate');
 await host.stop();
});

test('unbound requests do not count and navigation invalidates the in-memory session',async()=>{
 const {host,contents}=setup();await host.start();
 host.observe({request:{method:'POST',url:'https://www.doubao.com/chat/completion?a_bogus=private',postData:'{}'}});
 assert.equal(host.network.size,0);
 contents.emit('did-start-navigation',{},'https://www.doubao.com/chat',false,true);
 assert.equal(host.snapshot().phase,'blocked');await assert.rejects(host.runTest());await host.stop();
});

test('stop closes the send gate immediately even while its final snapshot is awaiting',async()=>{
 const {host,page,contents}=setup();await host.start();page.phase='ready';await host.poll();
 request(host,host.probes[0],'sig-a');request(host,host.probes[1],'sig-b');request(host,host.probes[2],'sig-d');
 let release;const pending=new Promise(resolve=>{release=resolve});const execute=contents.executeJavaScript;
 contents.executeJavaScript=code=>code.includes('.snapshot()')?pending:execute(code);
 const stopping=host.stop();await assert.rejects(host.runTest(),/先完成/);
 release(structuredClone(page));await stopping;assert.equal(host.attached,false);
});

test('detaching aborts the page bridge and a late poll cannot revive it',async()=>{
 const {host,contents,calls}=setup();await host.start();
 let release;const pending=new Promise(resolve=>{release=resolve});const execute=contents.executeJavaScript;
 contents.executeJavaScript=code=>code.includes('.snapshot()')?pending:execute(code);
 const polling=host.poll();contents.debugger.emit('detach');
 assert.equal(host.snapshot().phase,'blocked');assert.ok(calls.at(-1).includes('.dispose()'));
 release({phase:'ready'});await polling;assert.equal(host.snapshot().phase,'blocked');await host.stop();
});

test('business result requires fresh single observed request and original session binding',async()=>{
 for(const mode of ['fresh','reused','duplicate','missing']){
  const {host,page,contents}=setup();await host.start();
  host.probes.forEach((p,i)=>request(host,p,'manual-'+i));request(host,host.test,'test-signature');
  page.phase='passed';page.test={sent:true,complete:true,exact:true};await host.poll();assert.equal(host.snapshot().queueEnabled,true);
  const execute=contents.executeJavaScript;
  contents.executeJavaScript=code=>code.includes('.taskSnapshot(')?Promise.resolve({text:'private business text',complete:true}):execute(code);
  const track=await host.startTask('business-one','private unique task prompt');
  if(mode!=='missing')request(host,host.operation,mode==='reused'?'test-signature':'business-signature');
  if(mode==='duplicate')request(host,host.operation,'business-signature');
  await assert.rejects(host.taskResult({...track,session:'old'}),/连接已失效/);
  if(mode==='fresh'){assert.equal((await host.taskResult(track)).complete,true);await host.releaseTask(track)}else await assert.rejects(host.taskResult(track),/新签名/);
  assert.doesNotMatch(JSON.stringify(host.snapshot()),/private unique|private business|business-signature/);
  await host.stop();assert.equal(host.snapshot().queueEnabled,false);
 }
});

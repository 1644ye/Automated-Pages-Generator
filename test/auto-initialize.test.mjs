import {runInNewContext} from 'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {AutoInitializer,connectionPage}=require('../src/auto-initialize.cjs');
function setup({failAt=-1,complete=true}={}){
 let clock=0,sent=-1;const actions=[];const host={probes:[0,1,2].map(n=>({id:'p'+n,prompt:'probe'+n})),async start(){actions.push('start')},async poll(){if(sent===failAt&&failAt>=0)this.failed=true},snapshot(){return {phase:this.failed?'blocked':sent===2?'ready':'observing',reason:'synthetic failure',probes:this.probes.map((p,i)=>({...p,complete:complete&&i<=sent})),queueEnabled:!!this.verified}},async runTest(){actions.push('verify');this.verified=true}};
 const flow=new AutoInitializer({sendInputEvent(){throw Error('unexpected')}},{createBackend:async()=>host,sleep:async ms=>{clock+=ms},now:()=>clock});
 flow.page=async(op,prompt)=>{flow.check();actions.push(op);if(op==='status')return {ready:true,empty:true,generating:false};if(op==='submit'){sent++;return 'clicked'}};
 return {flow,actions,host};
}
test('automatic setup sends three messages sequentially and verifies once',async()=>{const a=setup();await a.flow.run();assert.equal(a.actions.filter(x=>x==='submit').length,3);assert.equal(a.actions.filter(x=>x==='verify').length,1);assert.equal(a.actions.filter(x=>x==='new').length,1)});
test('failed or unconfirmed response never sends the next probe or retries a send',async()=>{for(const config of [{failAt:0},{complete:false}]){const a=setup(config);await assert.rejects(a.flow.run());assert.equal(a.actions.filter(x=>x==='submit').length,1);assert.ok(!a.actions.includes('verify'))}});
test('cancel prevents further sends',async()=>{const a=setup();const original=a.flow.page;a.flow.page=async(op,prompt)=>{const result=await original(op,prompt);if(op==='submit')a.flow.cancel();return result};await assert.rejects(a.flow.run(),/暂停/);assert.equal(a.actions.filter(x=>x==='submit').length,1)});
test('visible login prompt prevents any page action; generating status remains readable',()=>{
 const element=label=>({disabled:false,getClientRects:()=>[{}],getAttribute:()=>null,innerText:label});const editor={...element(''),value:'',focus(){throw Error('must not focus')}};
 let buttons=[element('登录')];const context={getComputedStyle:()=>({visibility:'visible'}),document:{readyState:'complete',querySelectorAll(selector){if(selector.startsWith('button,'))return buttons;if(selector.startsWith('textarea'))return [editor];return []}}};
 const call=op=>runInNewContext('('+connectionPage.toString()+')('+JSON.stringify(op)+')',context);
 assert.throws(()=>call('new'),/登录/);buttons=[element('停止生成')];assert.equal(call('status').generating,true);assert.throws(()=>call('fill'),/仍在生成/);
});

test('page errors cross Electron boundary as structured data with a readable step',async()=>{
 const contents={async executeJavaScript(code){return runInNewContext(code,{document:{querySelectorAll:()=>[]},getComputedStyle:()=>({visibility:'visible'})})}};
 const flow=new AutoInitializer(contents);await assert.rejects(flow.page('fill'),/填写校准消息失败：可用输入框数量为 0/);
});
test('page success unwraps the returned status envelope',async()=>{
 const flow=new AutoInitializer({async executeJavaScript(){return {ok:true,value:{ready:true,empty:true}}}});assert.deepEqual(await flow.page('status'),{ready:true,empty:true});
});

test('changed test ID falls back to a unique visible editor; ambiguity blocks writes',()=>{
 const editor={getClientRects:()=>[{}],getAttribute:()=>null,value:'',isContentEditable:true};let editors=[editor];
 const context={document:{readyState:'complete',querySelectorAll:s=>s==='textarea,[contenteditable="true"]'?editors:[]},getComputedStyle:()=>({visibility:'visible'})};
 const call=op=>runInNewContext('('+connectionPage.toString()+')('+JSON.stringify(op)+')',context);
 assert.equal(call('status').ready,true);assert.equal(call('status').editorType,'contenteditable');editors=[editor,{...editor}];assert.equal(call('status').ready,false);assert.throws(()=>call('fill'),/数量为 2/);
});
test('startup waits for editor readiness before creating or sending',async()=>{
 const a=setup(),original=a.flow.page;let polls=0;a.flow.page=async(op,prompt)=>{if(op==='status'&&polls++<3)return {ready:false,empty:false};return original(op,prompt)};await a.flow.run();assert.ok(polls>=4);assert.equal(a.actions.filter(x=>x==='new').length,1);assert.equal(a.actions.filter(x=>x==='submit').length,3);
});
test('rich editor calibration whitespace is accepted but changed marker is not sent',()=>{
 const prompt='Calibration:\nAPG_DIRECT_ONE_0123456789abcdef';let clicks=0;
 const editor={innerText:'Calibration:\n\nAPG_DIRECT_ONE_0123456789abcdef\n',getClientRects:()=>[{}],getAttribute:()=>null,focus(){}};
 const send={innerText:'Send',getClientRects:()=>[{}],getAttribute:()=>null,click(){clicks++}};
 const context={document:{querySelectorAll:s=>s.startsWith('button,')?[send]:s==='textarea,[contenteditable="true"]'?[editor]:[]},getComputedStyle:()=>({visibility:'visible'})};
 const submit=()=>runInNewContext('('+connectionPage.toString()+')("submit",'+JSON.stringify(prompt)+')',context);
 assert.equal(submit(),'clicked');assert.equal(clicks,1);editor.innerText=prompt+'x';assert.throws(submit);assert.equal(clicks,1);
});

test('new conversation excludes same-named history and project rows without using screen coordinates',()=>{
 let clicks=[];
 const make=(text,index)=>({innerText:text,children:[],getClientRects:()=>[{}],getAttribute:()=>null,compareDocumentPosition:b=>index<b.index?4:2,index,closest:()=>null,click(){clicks.push(index)}});
 const nav=make('新对话',0),project=make('项目',1),projectRow=make('新对话',2),recent=make('最近',3),history=make('新对话',4);
 let nodes=[nav,project,projectRow,recent,history];
 const editor={...make('',10),value:''};
 const sidebar={querySelectorAll:()=>nodes,contains:()=>true};
 const context={getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>sidebar,querySelectorAll:s=>s.startsWith('textarea')?[editor]:[]}};
 const run=()=>runInNewContext('('+connectionPage.toString()+')("new")',context);
 assert.equal(run(),true);assert.deepEqual(clicks,[0]);
 clicks=[];nodes=[project,projectRow,recent,history];assert.throws(run,/入口数量为 0/);assert.deepEqual(clicks,[]);
 nodes=[nav,make('新对话',0.5),recent,history];assert.throws(run,/入口数量为 2/);assert.deepEqual(clicks,[]);
 nodes=[nav,history];assert.throws(run,/入口数量为 2/);assert.deepEqual(clicks,[]);
 nodes=[nav,recent,history];editor.value='unsent draft';assert.throws(run,/草稿/);assert.deepEqual(clicks,[]);
});

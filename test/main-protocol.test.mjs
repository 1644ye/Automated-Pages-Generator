import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

// Synthetic IPC/state tests only: no Electron process, browser or real filesystem writes.
const require=createRequire(import.meta.url);
const mainSource=readFileSync(new URL('../src/main.cjs',import.meta.url),'utf8');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function setup({ready=async()=>{},write=async()=>{},start=async()=>{},paused=false,tasks=[{id:'synthetic-task',status:'待处理',request:'synthetic prompt'}]}={}){
 const counts={capture:0,ready:0,send:0,prepare:0,poll:0,navigate:0,visible:0};
 const written=[];let command;
 const state={paused,tasks,exports:[],rules:{}};
 const win={isDestroyed:()=>false,webContents:{send(){}},getContentSize:()=>[1500,960]};
 const view={webContents:{},setVisible(){counts.visible++},setBounds(){}};
 const driver={async ready(){counts.ready++;await ready()},async dom(){counts.send++;throw Error('Unexpected browser action')},async prepare(){counts.prepare++;throw Error('Unexpected browser action')},async poll(){counts.poll++;throw Error('Unexpected browser action')}};
 class ProtocolCapture {
  constructor(_contents,options){counts.capture++;this.options=options;this.phase='idle'}
  async start(){this.phase='starting';this.options.onStatus({phase:this.phase,count:0});await start();this.phase='recording';this.options.onStatus({phase:this.phase,count:0})}
  async stop(reason){this.phase='stopped';return {reason,requests:[]}}
 }
 const dependencies={
  electron:{app:{whenReady:()=>({then(){}}),on(){},getVersion:()=> 'synthetic-version'},ipcMain:{handle(name,callback){assert.equal(name,'command');command=callback}},Menu:{},shell:{}},
  'node:fs/promises':{async writeFile(file,value){written.push({file,value});await write()},async rename(){},async mkdir(){}},
  './browser.cjs':{BrowserDriver:class{},keys:[]},
  './navigation.cjs':{Navigation:class{}},
  './diagnostics.cjs':{collectStructure(){}},
  './protocol-capture.cjs':{ProtocolCapture},
 };
 // The extra accessor exists only in this VM, without changing production exports.
 const access=runInNewContext(mainSource+`\n;({seed(value){win=value.win;view=value.view;driver=value.driver;state=value.state;dir='synthetic-user-data';core={paths:()=>[]};navigation=value.navigation},tick,protocol:()=>protocol})`,{
  require(name){if(Object.hasOwn(dependencies,name))return dependencies[name];if(['node:path','node:crypto'].includes(name))return require(name);throw Error('Unexpected dependency: '+name)},
  __dirname:'synthetic-source-directory',
 },{filename:'main-protocol-unit.cjs'});
 access.seed({win,view,driver,state,navigation:{open(){counts.navigate++}}});
 return {state,counts,written,tick:access.tick,protocol:access.protocol,call:(name,value)=>command({sender:win.webContents},name,value)};
}

test('starting protocol capture pauses pending tasks and never dispatches them',async()=>{
 const app=setup();await app.call('startProtocol');await app.tick();
 assert.equal(app.state.paused,true);assert.equal(app.state.tasks[0].status,'待处理');assert.equal(app.protocol().phase,'recording');
 assert.equal(app.counts.capture,1);assert.equal(app.counts.ready,0);assert.equal(app.counts.prepare,0);assert.equal(app.counts.send,0);assert.equal(app.counts.poll,0);
 assert.ok(app.written.length>0);assert.equal(JSON.parse(app.written[0].value).paused,true);
});

test('resume and browser reload are rejected while a capture is active',async()=>{
 const app=setup();await app.call('startProtocol');
 await assert.rejects(app.call('resume'),/请先结束协议采集/);await assert.rejects(app.call('reload'),/请先结束协议采集/);
 assert.equal(app.state.paused,true);assert.equal(app.counts.ready,0);assert.equal(app.counts.navigate,0);assert.equal(app.counts.visible,0);assert.equal(app.counts.send,0);
});

test('resume rechecks capture state after awaiting readiness and preserves paused tasks',async()=>{
 const gate=deferred();const app=setup({paused:true,ready:()=>gate.promise,tasks:[{id:'synthetic-task',status:'待人工处理',error:'synthetic prior issue'}]});
 const resuming=app.call('resume');assert.equal(app.counts.ready,1);
 await app.call('startProtocol');gate.resolve();await assert.rejects(resuming,/协议采集已开始/);await app.tick();
 assert.equal(app.state.paused,true);assert.equal(app.state.tasks[0].status,'待人工处理');assert.equal(app.state.tasks[0].error,'synthetic prior issue');assert.equal(app.counts.send,0);
});

test('concurrent starts create only one capture, including before the pause save completes',async()=>{
 const gate=deferred();const app=setup({write:()=>gate.promise});
 const first=app.call('startProtocol');assert.equal(app.protocol().phase,'starting');assert.equal(app.counts.capture,0);
 await assert.rejects(app.call('startProtocol'),/请先结束当前协议采集/);
 gate.resolve();await first;
 assert.equal(app.counts.capture,1);assert.equal(app.protocol().phase,'recording');assert.equal(app.state.paused,true);assert.equal(app.counts.send,0);
});

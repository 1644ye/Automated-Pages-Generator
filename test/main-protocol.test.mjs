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
 const counts={capture:0,ready:0,send:0,prepare:0,poll:0,navigate:0,visible:0,clipboard:0};
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
  electron:{app:{whenReady:()=>({then(){}}),on(){},getVersion:()=> 'synthetic-version',getAppPath:()=> 'synthetic-app'},ipcMain:{handle(name,callback){assert.equal(name,'command');command=callback}},Menu:{},shell:{},clipboard:{writeText(text){counts.clipboard++;assert.match(text,/APG_PROBE_(ONE|TWO)_/);}}},
  'node:fs/promises':{async writeFile(file,value){written.push({file,value});await write()},async rename(){},async mkdir(){}},
  './auto-initialize.cjs':require('../src/auto-initialize.cjs'),
  './browser.cjs':{BrowserDriver:class{},keys:[]},
  './navigation.cjs':{Navigation:class{}},
  './diagnostics.cjs':{collectStructure(){}},
  './protocol-capture.cjs':{ProtocolCapture},
  './backend-probe.cjs':{BackendProbe:class {
   constructor(_contents,options){this.options=options}
   async start(){this.options.onStatus({phase:'observing',probes:[]});return {phase:'observing'}}
   async stop(){return {verified:false,probes:[],test:{sent:false}}}
   async dispose(){}
  }},
 };
 // The extra accessor exists only in this VM, without changing production exports.
 const access=runInNewContext(mainSource+`\n;({seed(value){win=value.win;view=value.view;driver=value.driver;state=value.state;dir='synthetic-user-data';core={paths:()=>[],exportMarketingXlsx:async()=>{value.counts.exported=(value.counts.exported||0)+1;return {file:"synthetic.xlsx"}}};navigation=value.navigation},tick,protocol:()=>protocol})`,{
  require(name){if(Object.hasOwn(dependencies,name))return dependencies[name];if(['node:path','node:crypto'].includes(name))return require(name);throw Error('Unexpected dependency: '+name)},
  __dirname:'synthetic-source-directory',
 },{filename:'main-protocol-unit.cjs'});
 access.seed({win,view,driver,state,counts,navigation:{open(){counts.navigate++}}});
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
test('calibration copies only an explicitly chosen synthetic probe and never sends it',async()=>{
 const app=setup();await assert.rejects(app.call('copyProbe','probe-1'),/先开始校准/);assert.equal(app.counts.clipboard,0);
 await app.call('startProtocol');assert.equal(app.protocol().probes.length,2);assert.notEqual(app.protocol().probes[0].marker,app.protocol().probes[1].marker);assert.equal(app.counts.clipboard,0);
 await app.call('copyProbe','probe-1');await app.call('copyProbe','probe-2');await assert.rejects(app.call('copyProbe','untrusted-message'),/无效/);
 assert.equal(app.counts.clipboard,2);assert.equal(app.counts.send,0);assert.equal(app.counts.prepare,0);assert.equal(app.state.paused,true);
});

test('backend calibration blocks queue sends, legacy capture, reload and resume until stopped',async()=>{
 const app=setup();await app.call('startBackend');await app.tick();
 assert.equal(app.state.paused,true);assert.equal(app.state.tasks[0].status,'待处理');
 for(const action of ['startProtocol','reload','resume','startBackend','check'])await assert.rejects(app.call(action));
 assert.equal(app.counts.send,0);assert.equal(app.counts.prepare,0);assert.equal(app.counts.navigate,0);
 await app.call('stopBackend');await app.call('startProtocol');
 assert.equal(app.counts.capture,1);assert.equal(app.state.paused,true);
});

test('backend calibration cannot start while legacy capture is active',async()=>{
 const app=setup();await app.call('startProtocol');await assert.rejects(app.call('startBackend'),/结束/);
 assert.equal(app.counts.send,0);
});

test('a pending DOM rule check cannot overlap a new calibration',async()=>{
 const gate=deferred(),app=setup({ready:()=>gate.promise});const check=app.call('check',true);
 await assert.rejects(app.call('startBackend'));await assert.rejects(app.call('startProtocol'));
 gate.resolve();await check;await app.call('startBackend');assert.equal(app.state.paused,true);
});

test('app-only marketing completion skips XLSX; explicit export creates it',async()=>{
 const task={id:'m',kind:'marketing',status:'待导出',exportXlsx:false,content:{items:[]}};
 const app=setup({tasks:[task]});await app.tick();assert.equal(task.status,'已完成');assert.equal(app.counts.exported,undefined);
 await app.call('exportTask','m');assert.equal(app.counts.exported,1);assert.equal(task.exportXlsx,true);
});

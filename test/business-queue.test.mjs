import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url),source=readFileSync(new URL('../src/main.cjs',import.meta.url),'utf8');
function setup({invalid=0,complete=true}={}){
 const state={paused:true,tasks:[],exports:[],rules:{}},counts={sent:[],exports:0,parsed:0,released:0,canceled:0},writes=[];
 const win={isDestroyed:()=>false,webContents:{send(){}}};let command;
 const connection={key:'session',async startTask(id,prompt){counts.sent.push(id)},async taskResult(){return {text:'response',complete}},async releaseTask(){counts.released++},async cancelTask(){counts.canceled++}};
 const core={paths:()=>[],makePrompt:()=> 'repair prompt',prepareRepair(t){if((t.repairRound||0)>=3)return false;t.repairRound=(t.repairRound||0)+1;t.request='repair';return true},parseResult(){if(counts.parsed++<invalid)throw Error('invalid schema');return {ok:true}},async exportXlsx(){counts.exports++;return {file:'test.xlsx'}}};
 const deps={electron:{app:{whenReady:()=>({then(){}}),on(){},getVersion:()=> 'test',getAppPath:()=>'.'},dialog:{async showOpenDialog(){return {canceled:false,filePaths:['chosen-export-dir']}}},ipcMain:{handle(_name,fn){command=fn}}},'node:fs/promises':{async writeFile(_p,text){writes.push(JSON.parse(text))},async rename(){}},'./auto-initialize.cjs':require('../src/auto-initialize.cjs'),'./browser.cjs':{},'./navigation.cjs':{},'./diagnostics.cjs':{},'./protocol-capture.cjs':{},'./backend-probe.cjs':{}};
 const access=runInNewContext(source+`;({seed(v){state=v.state;win=v.win;core=v.core;backendProbe=v.connection;backend={queueEnabled:true};dir='fake'},tick,resetSession})`,{require:n=>Object.hasOwn(deps,n)?deps[n]:require(n),__dirname:'fake'});
 access.seed({state,win,core,connection});
 const add=(id,extra={})=>{const t={id,status:'待处理',request:'task '+id,selected:[],...extra};state.tasks.push(t);return t};
 return {state,counts,writes,connection,add,tick:access.tick,resetSession:access.resetSession,call:(name,value)=>command({sender:win.webContents},name,value)};
}
test('serial queue persists send intent, exports only complete valid results, never repeats completed tasks',async()=>{
 const a=setup();a.add('one');a.add('two');await a.call('resumeBackend');await a.tick();assert.deepEqual(a.counts.sent,['one-0']);assert.equal(a.counts.exports,1);
 assert.ok(a.writes.some(s=>s.tasks[0].status==='生成中'&&s.tasks[0].track.id==='one-0'));
 await a.tick();await a.tick();assert.deepEqual(a.counts.sent,['one-0','two-0']);assert.equal(a.counts.exports,2);
});
test('pause/resume polls existing binding without resending; cancel never exports',async()=>{
 const a=setup({complete:false}),t=a.add('one');await a.call('resumeBackend');await a.tick();await a.call('pause');await a.tick();await a.call('resumeBackend');await a.tick();assert.equal(a.counts.sent.length,1);assert.equal(a.counts.exports,0);await a.call('cancel',t.id);await a.tick();assert.equal(t.status,'已取消');assert.equal(a.counts.canceled,1);assert.equal(a.counts.exports,0);
});
test('validation errors permit at most three repairs and never export persistent failure',async()=>{
 for(const invalid of [1,4]){const a=setup({invalid}),t=a.add('one');await a.call('resumeBackend');for(let i=0;i<6;i++)await a.tick();assert.equal(a.counts.sent.length,invalid===1?2:4);assert.equal(t.repairRound,invalid===1?1:3);assert.equal(t.status,invalid===1?'已完成':'校验失败');assert.equal(a.counts.exports,invalid===1?1:0)}
});

test('network tasks and lost session bindings never auto-send',async()=>{
 const a=setup(),t=a.add('one',{network:true});await a.call('resumeBackend');await a.tick();assert.equal(t.status,'待人工处理');assert.equal(a.counts.sent.length,0);
 t.track={session:'old',id:'one-0'};await a.call('resumeBackend');await a.tick();assert.equal(t.status,'待人工处理');assert.equal(a.counts.sent.length,0);
});

test('new session clears prior tasks and results but keeps settings; export directory is configurable',async()=>{
 const a=setup();a.add('old');a.state.exports.push({file:'existing.xlsx'});a.state.exportDir='kept-dir';a.state.rules={custom:'kept'};a.resetSession();assert.equal(a.state.tasks.length,0);assert.equal(a.state.exports.length,0);assert.equal(a.state.exportDir,'kept-dir');assert.equal(a.state.browserVisible,false);assert.equal(a.state.rules.custom,'kept');await a.call('chooseExportDir');assert.equal(a.state.exportDir,'chosen-export-dir');
});

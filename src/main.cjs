const {app,net,BrowserWindow,WebContentsView,ipcMain,Menu,shell,clipboard,dialog}=require('electron');
const {join}=require('node:path');const fs=require('node:fs/promises');const {randomUUID}=require('node:crypto');const {BrowserDriver,keys}=require('./browser.cjs');const {Navigation}=require('./navigation.cjs');const {collectStructure}=require('./diagnostics.cjs');const {ProtocolCapture}=require('./protocol-capture.cjs');
const {BackendProbe}=require('./backend-probe.cjs');
const {AutoInitializer}=require('./auto-initialize.cjs');
let initializer=null,initializing=null,updater=null;
let win,view,driver,navigation,state,dir,core,capture,captureSaving,backendProbe,backendSaving,running=false,checking=false,closing=false,saveChain=Promise.resolve();
let backend={phase:'idle',reason:''};
let protocol={phase:'idle',count:0,file:'',error:''};
const backendActive=()=>!!backendProbe||!!backendSaving||backend.phase==='starting';
const captureActive=()=>!!initializing||!!capture||!!captureSaving||protocol.phase==='starting'||backendActive()||checking;
const send=()=>{if(win&&!win.isDestroyed())win.webContents.send('state',{...state,update:updater?.state||{phase:'idle'},protocol,backend,version:app.getVersion(),paths:core.paths(),dataDir:dir,promptOptions:core.promptOptions,promptFocusOptions:core.promptFocusOptions,exportDir:state.exportDir||join(dir,'exports'),missingRules:['input','send','user','answer','body','done','stop','blocker'].filter(k=>!state.rules[k])})};
function save(){const snapshot=JSON.stringify(state);const operation=saveChain.catch(()=>{}).then(async()=>{await fs.writeFile(join(dir,'state.tmp'),snapshot);await fs.rename(join(dir,'state.tmp'),join(dir,'state.json'));send()});saveChain=operation;return operation}
function resetSession(){state.initialization={phase:'idle',message:''};state.tasks=[];state.exports=[];state.paused=true;state.browserVisible=false;delete state.browserError;}
function bounds(){if(!win||!view)return;view.setVisible(!!state.browserVisible);const [w,h]=win.getContentSize();view.setBounds({x:Math.floor(w*.57),y:52,width:w-Math.floor(w*.57),height:h-52})}
async function pause(t,error){t.status='待人工处理';t.error=error.message;state.paused=true;await save()}
async function tick(){if(running||state.paused||closing||capture||captureSaving||checking||(backendActive()&&!backend.queueEnabled))return;running=true;try{const pending=state.tasks.find(t=>t.status==='待导出');if(pending){await finish(pending);return}const t=state.tasks.find(t=>['待处理','生成中'].includes(t.status));if(!t)return;
 if(t.status==='待处理'){
  if(!backendProbe||!backend.queueEnabled)throw Error('请完成后台校准后继续');
  if(t.network)throw Error('后台联网搜索能力尚未验证，本任务未发送。请取消后创建普通任务，或等待联网适配。');
  if(t.request.length>240000)throw Error('提示词超过后台任务上限，未发送');
  const connection=backendProbe,id=t.id+'-'+(t.repairRound||t.repairAttempt||0);
  state.lastFailureSaved=false;t.transport='backend';t.track={session:connection.key,id};t.status='生成中';t.started=Date.now();await save();
  if(state.paused||t.status==='已取消'){if(t.status!=='已取消'){t.status='待处理';t.track=null;await save()}return}
  await connection.startTask(id,t.request);
 }
 if(t.status==='生成中'){if(Date.now()-t.started>15*60*1000)throw Error('生成超过15分钟，暂停检查；不会重发');if(t.transport!=='backend')throw Error('旧网页任务不能迁移发送，请取消后重新创建');const r=await backendProbe.taskResult(t.track);if(t.status==='已取消')return;t.raw=r.text;if(r.complete){await backendProbe.releaseTask(t.track);t.track=null;t.sources=r.sources||[];t.networkObserved=r.searchObserved;try{t.content=core.parseResult(t.raw,t)}catch(error){if(!core.prepareRepair(t,error)){t.status='校验失败';t.error=error.message;await save();return}t.track=null;t.status='待处理';await save();return}t.revision=1;t.status='待导出';await save();await finish(t)}else send()}
 }catch(error){const t=state.tasks.find(t=>['待处理','生成中','待导出'].includes(t.status));if(t)await pause(t,error)}finally{running=false}}
function backendStatus(s){const becameReady=s.verified&&!backend.verified;backend=s;if(becameReady){state.browserVisible=false;bounds()}if(s.phase==='blocked'){if(s.failure&&!state.lastFailureSaved){state.lastFailureSaved=true;const folder=join(dir,'diagnostics');fs.mkdir(folder,{recursive:true}).then(()=>fs.writeFile(join(folder,'doubao-read-failure-'+Date.now()+'.json'),JSON.stringify({appVersion:app.getVersion(),failure:s.failure},null,2))).catch(()=>{})}state.browserVisible=true;bounds();state.paused=true;for(const t of state.tasks.filter(t=>t.status==='生成中')){t.status='待人工处理';t.error=s.reason}save().catch(()=>{})}send()}
async function ensureConnection(){
 if(backend.queueEnabled)return;if(initializing)return initializing;
 if(capture||captureSaving||backendSaving||checking||running||state.tasks.some(t=>t.status==='生成中'))throw Error('请先结束当前生成或诊断，再继续初始化');
 state.paused=true;state.browserVisible=true;state.initialization={phase:'running',message:'正在准备自动初始化'};bounds();send();
 const flow=new AutoInitializer(view.webContents,{createBackend:async()=>{if(backendProbe){await backendProbe.dispose();backendProbe=null}backendProbe=new BackendProbe(view.webContents,{onStatus:backendStatus});return backendProbe},onProgress:message=>{state.initialization={phase:'running',message};send()}});initializer=flow;
 initializing=(async()=>{try{await flow.run();for(const t of state.tasks.filter(t=>t.initializationBlocked&&!t.track)){t.status='待处理';delete t.error;delete t.initializationBlocked}state.initialization={phase:'ready',message:'后台连接就绪'};state.browserVisible=false;state.paused=false;bounds();await save()}catch(error){let file='';try{const report=backendProbe?await backendProbe.stop():{phase:'initialization-failed',step:flow.step||'prepare'};const folder=join(dir,'diagnostics');await fs.mkdir(folder,{recursive:true});file=join(folder,'doubao-auto-init-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify({appVersion:app.getVersion(),...report,initializationError:error.message},null,2),{flag:'wx'})}catch{await backendProbe?.dispose()}backendProbe=null;backend={phase:'failed',queueEnabled:false,reason:error.message,file};state.initialization={phase:'attention',message:error.message};for(const t of state.tasks.filter(t=>t.status==='待处理')){t.status='待人工处理';t.error=error.message;t.initializationBlocked=true}state.paused=true;state.browserVisible=true;bounds();await save()}finally{initializer=null;initializing=null;send()}})();return initializing;
}
async function finish(t){if(t.kind==='marketing'&&t.exportXlsx===false){t.status='已完成';await save();return}const destination=state.exportDir||join(dir,'exports');const record=t.kind==='marketing'?await core.exportMarketingXlsx(app.getAppPath(),destination,t.content,t,state.exports):await core.exportXlsx(app.getAppPath(),destination,t.content,t.id,t.revision,state.exports);t.export=record;t.status='已完成';await save()}
async function finishCapture(reason='manual'){
 if(captureSaving)return captureSaving;if(!capture)throw Error('当前没有进行中的协议采集');if(capture.phase==='starting')throw Error('采集正在启动，请稍后再结束');const current=capture;
 captureSaving=(async()=>{try{const report=await current.stop(reason);const folder=join(dir,'diagnostics');await fs.mkdir(folder,{recursive:true});const file=join(folder,'doubao-protocol-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify({appVersion:app.getVersion(),...report},null,2),{flag:'wx'});protocol={phase:'saved',count:report.requests.length,file,error:'',reason:report.reason,probeResponses:['probe-1','probe-2'].map(id=>({id,requests:report.requests.filter(r=>r.probes?.includes(id)).map(r=>({id:r.id,httpEnded:r.httpEnded,failed:!!r.httpFailed}))}))};return file}catch(error){protocol={...protocol,phase:'failed',error:'协议诊断保存失败，请检查本地数据目录是否可写。'};throw error}finally{capture=null;captureSaving=null;send()}})();return captureSaving;
}
async function finishBackend(){
 state.paused=true;for(const t of state.tasks.filter(t=>t.status==='生成中')){t.status='待人工处理';t.error='后台连接已断开，旧任务不会自动重发。'}await save();
 if(backendSaving)return backendSaving;if(!backendProbe)throw Error('当前没有后台测试');if(backend.phase==='starting')throw Error('正在启动，请稍后再结束');
 const current=backendProbe;
 backendSaving=(async()=>{try{const report=await current.stop();const folder=join(dir,'diagnostics');await fs.mkdir(folder,{recursive:true});const file=join(folder,'doubao-backend-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify({appVersion:app.getVersion(),...report},null,2),{flag:'wx'});backend={...report,phase:'saved',queueEnabled:false,file};return file}catch{await current.dispose();backend={phase:'failed',reason:'后台测试报告保存失败，请检查本地数据目录。'};throw Error(backend.reason)}finally{backendProbe=null;backendSaving=null;send()}})();return backendSaving;
}
app.whenReady().then(async()=>{core=await import('../shared/core.mjs');dir=app.getPath('userData');await fs.mkdir(dir,{recursive:true});try{state=JSON.parse(await fs.readFile(join(dir,'state.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;state={tasks:[],exports:[],rules:{},paused:true}}
 const failed=state.tasks?.filter(t=>t.status==='校验失败'&&t.raw)||[];if(failed.length)await fs.writeFile(join(dir,'failed-results.json'),JSON.stringify(failed));
 resetSession();state.autoUpdate??=true;await save();
 updater=new (require('./updater.cjs').Updater)({version:app.getVersion(),dir,fetcher:(url,options)=>net.fetch(url,options),onChange:()=>send()});
 win=new BrowserWindow({width:1500,height:960,minWidth:1100,minHeight:700,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 view=new WebContentsView({webPreferences:{partition:'persist:doubao',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.contentView.addChildView(view);bounds();win.on('resize',bounds);driver=new BrowserDriver(view,state.rules,send);
 const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='doubao.com'||u.hostname.endsWith('.doubao.com'))}catch{return false}};
 view.webContents.on('will-navigate',(e,url)=>{if(!allowed(url)){e.preventDefault();state.browserError='外部链接请在系统浏览器打开；未自动跳转：'+url;send()}});view.webContents.setWindowOpenHandler(({url})=>{if(allowed(url))view.webContents.loadURL(url).catch(()=>{});return {action:'deny'}});view.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
 navigation=new Navigation(view.webContents,patch=>{Object.assign(state,patch);send()});
 view.webContents.on('context-menu',(_event,p)=>{Menu.buildFromTemplate(keys.map(key=>({label:'标定 '+key,click:async()=>{try{const selector=await view.webContents.executeJavaScript(`(()=>{let e=document.elementFromPoint(${p.x},${p.y});let parts=[];while(e&&e!==document.documentElement){if(e.id){parts.unshift('#'+CSS.escape(e.id));break}let s=e.tagName.toLowerCase();const attrs=['data-testid','data-message-id','data-role','role','aria-label'];let found=false;for(const a of attrs){if(e.getAttribute(a)){s+='['+a+'='+JSON.stringify(e.getAttribute(a))+']';found=true;break}}if(!found){const siblings=[...e.parentElement.children].filter(x=>x.tagName===e.tagName);if(siblings.length>1)s+=':nth-of-type('+(siblings.indexOf(e)+1)+')'}parts.unshift(s);e=e.parentElement}return parts.join(' > ')})()`);state.rules[key]=selector;driver.rules=state.rules;await save()}catch(error){state.browserError=error.message;send()}}}))).popup({window:win})});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));await win.loadFile(join(__dirname,'index.html'));send();setInterval(tick,700).unref();navigation.open();
 if(app.isPackaged){updater.check(state.autoUpdate);setInterval(()=>{if(state.autoUpdate)updater.check(true)},6*60*60*1000).unref()}
});
ipcMain.handle('command',async(event,name,value)=>{if(event.sender!==win?.webContents)throw Error('无权限');
 if(name==='checkUpdate'){updater.check(state.autoUpdate);return}
 if(name==='downloadUpdate'){updater.check(true);return}
 if(name==='autoUpdate'){state.autoUpdate=value===true;await save();if(state.autoUpdate)updater.check(true);return}
 if(name==='restartUpdate'){if(updater?.state.phase!=='ready')throw Error('新版尚未准备好');if(initializing||running||capture||captureSaving||checking||state.tasks.some(t=>!['已完成','已取消'].includes(t.status)))throw Error('请先完成或取消未结束任务，再重启更新');await save();app.relaunch({execPath:updater.executable,args:[]});app.quit();return}
 if(name==='exportTask'){const t=state.tasks.find(t=>t.id===value);if(!t||t.kind!=='marketing'||t.status!=='已完成')throw Error('请先选择已完成的文案任务');t.exportXlsx=true;await finish(t);return}
 if(name==='state'){send();return}
 if(name==='toggleBrowser'){state.browserVisible=!state.browserVisible;bounds();send();return}
 if(name==='chooseExportDir'){const choice=await dialog.showOpenDialog(win,{title:'选择导出目录',defaultPath:state.exportDir||join(dir,'exports'),properties:['openDirectory','createDirectory']});if(choice.canceled)return;state.exportDir=choice.filePaths[0];await save();return}
 if(name==='copyGenerated'){const item=state.tasks.find(t=>t.id===value.taskId)?.content?.items?.find(x=>x.id===value.itemId);if(!item)throw Error('没有可复制的生成内容');clipboard.writeText(item.text);return}
 if(name==='copyMarketingPrompt'){const prompt=core.buildMarketingPrompt(value.input,value.options,value.focus,value.seoInfo,value.sourceUrl);clipboard.writeText(prompt);return prompt}

 if(name==='startBackend'){
  if(captureActive())throw Error('请先结束当前校准或协议采集');if(running||state.tasks.some(t=>t.status==='生成中'))throw Error('请先完成或取消正在生成的任务');
  state.browserVisible=true;bounds();state.paused=true;backend={phase:'starting',reason:''};
  try{await save();backendProbe=new BackendProbe(view.webContents,{onStatus:backendStatus});return await backendProbe.start()}catch(error){await backendProbe?.dispose();backendProbe=null;backend={phase:'failed',reason:error.message};send();throw error}
 }
 if(name==='copyBackendProbe'){if(!backendProbe||backend.phase!=='observing')throw Error('请先开始后台校准');const probe=backend.probes?.find(p=>p.id===value);if(!probe)throw Error('无效校准消息');clipboard.writeText(probe.prompt);return '已复制，请在右侧同一测试会话手动发送'}
 if(name==='testBackend'){if(!backendProbe||backendSaving)throw Error('请先完成后台校准；保存期间不会发送');return backendProbe.runTest()}
 if(name==='stopBackend'){initializer?.cancel();if(initializing){await initializing;return}return finishBackend()}
 if(name==='startProtocol'){if(captureActive())throw Error('请先结束当前协议采集');if(running||state.tasks.some(t=>t.status==='生成中'))throw Error('请先完成或取消正在生成的任务，再采集手动测试消息');state.paused=true;const nonce=randomUUID().replaceAll('-','').slice(0,16);const probes=['ONE','TWO'].map((label,i)=>{const marker='APG_PROBE_'+label+'_'+nonce;return {id:'probe-'+(i+1),marker,prompt:'请严格只回复这一行文字，不要添加解释、引号或代码块：\n'+marker}});protocol={phase:'starting',count:0,file:'',error:'',probes};try{await save();capture=new ProtocolCapture(view.webContents,{targeted:true,probes,durationMs:180000,maxRequests:4,onStatus:s=>{protocol={...protocol,...s};send()},onTimeout:reason=>{finishCapture(reason).catch(()=>{})}});await capture.start();return protocol}catch(error){capture=null;protocol={...protocol,phase:'failed',error:error.message};send();throw error}}
 if(name==='copyProbe'){if(protocol.phase!=='recording')throw Error('请先开始校准');const probe=protocol.probes?.find(p=>p.id===value);if(!probe)throw Error('无效测试消息');clipboard.writeText(probe.prompt);return '已复制测试消息，请在右侧手动粘贴发送'}
 if(name==='stopProtocol')return finishCapture();
 if(name==='rules'){if(state.tasks.some(t=>t.status==='生成中'))throw Error('请先暂停任务');const rules=JSON.parse(value);for(const [key,s]of Object.entries(rules))if(!keys.includes(key)||typeof s!=='string'||s.length>2000)throw Error('无效规则');state.rules=rules;driver.rules=rules;await save();return}
 if(name==='diagnostics'){const structure=await view.webContents.executeJavaScript('('+collectStructure.toString()+')()');const report={version:app.getVersion(),createdAt:new Date().toISOString(),rulesConfigured:Object.fromEntries(keys.map(k=>[k,!!state.rules[k]])),taskCounts:state.tasks.reduce((counts,t)=>(counts[t.status]=(counts[t.status]||0)+1,counts),{}),structure};const folder=join(dir,'diagnostics');await fs.mkdir(folder,{recursive:true});const file=join(folder,'doubao-structure-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify(report,null,2),{flag:'wx'});return file}
 if(name==='check'){if(captureActive())throw Error('请先结束校准；期间不操作网页控件');checking=true;try{await driver.ready(value);return '定位规则检查通过；并非真实生成验证'}finally{checking=false}}
 if(name==='reload'){if(captureActive())throw Error('请先结束协议采集再重新打开豆包');state.browserVisible=true;bounds();send();return navigation.open()}
 let urlSource=null;
 if(name==='urlSeo'){
  let target;try{target=new URL(value.url)}catch{throw Error('请输入完整的 http:// 或 https:// 网址')}if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw Error('请输入不含账号密码的 HTTP/HTTPS 网页地址');
  urlSource={url:target.href,mode:'doubao-url'};
  value={kind:'marketing',exportXlsx:value.exportXlsx===true,options:['home-title','home-description'],focus:[],input:{refTitle:urlSource.title||new URL(urlSource.url).hostname,refBody:'请由豆包访问此网址并根据实际网页内容生成SEO：'+urlSource.url,website:urlSource.url,discount:''},autoStart:true,prompt:'由豆包读取网址并生成SEO',selected:[]};name='add';
 }
 if(name==='add'){const input=value.input;if(!input.refTitle?.trim()||!input.refBody?.trim()||(!urlSource&&!(Number(input.discount)>0&&Number(input.discount)<=100)))throw Error('请填写参考标题、内容和1–100折扣');const kind=value.kind==='marketing'?'marketing':'pages';if(kind==='marketing')core.buildMarketingPrompt(input,value.options||[],value.focus||[],value.seoInfo||'',value.sourceUrl||'');const selected=kind==='marketing'?[]:value.selected||[];if(selected.length&&!value.base)throw Error('单字段/选中字段生成需先载入完整结果');if(selected.some(p=>!core.paths().includes(p)))throw Error('无效字段');if(selected.length)core.validateAll(value.base);const t={id:randomUUID(),kind,urlSource,exportXlsx:kind==='marketing'?value.exportXlsx!==false:true,options:value.options,focus:value.focus,seoInfo:value.seoInfo,sourceUrl:value.sourceUrl,input,prompt:value.prompt,network:!!value.network,selected,base:value.base||null,status:'待处理',raw:''};t.request=core.makePrompt(t);if(t.request.length>110000)throw Error('任务输入超过110000字符');state.tasks.push(t);if(value.autoStart&&backend.queueEnabled)state.paused=false;await save();if(value.autoStart&&!backend.queueEnabled)ensureConnection().catch(error=>{state.initialization={phase:'attention',message:error.message};send()});return t.id}
 if(name==='pause'){initializer?.cancel();state.paused=true;await save();return}
 if(name==='resumeBackend'){
  if(!backend.queueEnabled){ensureConnection().catch(error=>{state.initialization={phase:'attention',message:error.message};send()});return}
  if(capture||captureSaving||checking||backendSaving||!backendProbe||!backend.queueEnabled)throw Error('请先完成后台校准和单次调用测试，并保持连接');
  for(const t of state.tasks.filter(t=>t.status==='待人工处理')){
   if(t.track){if(t.track.session!==backendProbe.key||t.transport!=='backend')continue;t.status='生成中'}
   else t.status=t.content?'待导出':'待处理';delete t.error;
  }
  state.paused=false;await save();return;
 }
 if(name==='resume'){if(captureActive())throw Error('请先结束协议采集；采集期间不会发送队列任务');await driver.ready(false,true);if(captureActive())throw Error('协议采集已开始，队列保持暂停');for(const t of state.tasks.filter(t=>t.status==='待人工处理')){if(t.track){t.status='生成中';t.started=Date.now()}else if(t.content)t.status='待导出';else t.status='待处理';delete t.error}state.paused=false;await save();return}
 if(name==='cancel'){const t=state.tasks.find(t=>t.id===value);if(t&&t.status!=='已完成'){t.status='已取消';t.error='已取消，不会导出或重新发送。';if(t.transport==='backend'&&t.track){state.paused=true;await backendProbe?.cancelTask(t.track)}}if(!state.tasks.some(x=>x.status==='待处理'))initializer?.cancel();await save();return}
 if(name==='restoreFailed'){let failed;try{failed=JSON.parse(await fs.readFile(join(dir,'failed-results.json'),'utf8'))}catch{throw Error('没有可恢复的上次失败结果')}if(!Array.isArray(failed))throw Error('恢复文件格式错误');for(const old of failed){if(state.tasks.some(t=>t.restoredId===old.id))continue;state.tasks.push({...old,id:randomUUID(),restoredId:old.id,track:null,status:'校验失败'})}await save();return}
 if(name==='repairFailed'){
  const previous=state.tasks.find(t=>t.id===value.id);if(!previous||previous.status!=='校验失败')throw Error('请选择校验失败任务');
  const t=structuredClone(previous);t.id=randomUUID();t.repairRound=0;t.repairAttempt=0;t.track=null;t.export=null;delete t.error;delete t.content;
  try{t.content=core.parseResult(t.raw,t);t.status='待导出'}catch(error){if(!core.prepareRepair(t,error))throw Error('无法安全自动修复，请编辑完整JSON并保存：'+error.message);t.status='待处理'}
  state.tasks.push(t);await save();if(backend.queueEnabled)state.paused=false;else ensureConnection().catch(error=>{state.initialization={phase:'attention',message:error.message};send()});return t.id;
 }
 if(name==='revalidate'){const t=state.tasks.find(t=>t.id===value);if(!t||t.status!=='校验失败')throw Error('请选择校验失败任务');t.content=core.parseResult(t.raw,t);t.revision=(t.revision||0)+1;t.status='待导出';delete t.error;await save();await finish(t);return}
 if(name==='edit'){const t=state.tasks.find(t=>t.id===value.id);if(!t||!['已完成','校验失败'].includes(t.status))throw Error('仅可编辑已结束任务');t.content=t.kind==='marketing'?core.validateMarketing(JSON.parse(value.json),t.options,!!t.urlSource):core.validateAll(JSON.parse(value.json));t.revision=(t.revision||0)+1;t.status='待导出';await save();await finish(t);return}
 if(name==='openExports'){await fs.mkdir(state.exportDir||join(dir,'exports'),{recursive:true});await shell.openPath(state.exportDir||join(dir,'exports'));return}
 throw Error('未知命令')});
app.on('window-all-closed',()=>{closing=true;app.quit()});
app.on('before-quit',event=>{initializer?.cancel();if(initializing){event.preventDefault();closing=true;initializing.finally(()=>app.quit());return}if(backendProbe&&backend.phase!=='starting'){event.preventDefault();closing=true;finishBackend().catch(()=>{}).finally(()=>app.quit())}else if(capture&&capture.phase!=='starting'){event.preventDefault();closing=true;finishCapture('closing').catch(()=>{}).finally(()=>app.quit())}});

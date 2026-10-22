'use strict';
const {randomUUID}=require('node:crypto');
const {createAnswerRuntime}=require('./doubao-answer.cjs');
const {installFetchProbe}=require('./doubao-fetch-probe.cjs');
function bounded(promise,ms){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('网页调用超时')),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})})}

// All templates and credentials stay in the page's closure. CDP below only
// compares the actual outgoing signature in RAM; it never replays a request.
class BackendProbe {
 constructor(contents,{onStatus=()=>{}}={}) {
  this.contents=contents;this.onStatus=onStatus;this.key='__apgProbe_'+randomUUID().replaceAll('-','');
  const nonce=randomUUID().replaceAll('-','').slice(0,16);
  const make=(label,id)=>{const marker='APG_DIRECT_'+label+'_'+nonce;return {id,marker,prompt:'请严格只回复这一行文字，不要添加解释、引号或代码块：\n'+marker}};
  this.probes=[make('ONE','probe-1'),make('TWO','probe-2'),make('THREE','probe-3')];this.test=make('FOUR','probe-4');
  this.network=new Map();this.signatures=new Map();this.phase='idle';this.attached=false;this.polling=false;this.stopping=false;this.epoch=0;
  this.onMessage=(_event,method,params)=>{if(method==='Network.requestWillBeSent')this.observe(params)};
  this.onDetach=()=>{this.attached=false;if(!this.stopping)this.invalidate('网页调试连接已断开，请停止测试后重新开始。')};
  this.onNavigation=(_event,_url,inPlace,isMainFrame)=>{if(isMainFrame&&!inPlace)this.invalidate('网页已重新加载，内存校准已失效，请停止测试后重新开始。')};
 }
 async start() {
  if(this.phase!=='idle')throw Error('后台校准已启动');
  if(new URL(this.contents.getURL()).origin!=='https://www.doubao.com')throw Error('请先在右侧打开并登录豆包网页');
  if(this.contents.debugger.isAttached())throw Error('网页调试器正在使用中，请先结束协议采集或关闭开发者工具');
  this.phase='starting';this.startedAt=Date.now();this.deadline=this.startedAt+300000;
  try {
   this.contents.debugger.attach('1.3');this.attached=true;
   this.contents.debugger.on('message',this.onMessage);this.contents.debugger.on('detach',this.onDetach);
   this.contents.on('did-start-navigation',this.onNavigation);
   await bounded(this.contents.debugger.sendCommand('Network.enable'),5000);
   if(this.stopping||this.phase!=='starting')throw Error('校准启动已中断');
   const config={key:this.key,probes:this.probes,test:this.test,durationMs:240000,enableBusiness:true};
   const installation=this.contents.executeJavaScript(`(${installFetchProbe.toString()})(${JSON.stringify(config)},${createAnswerRuntime.toString()})`);
   installation.then(()=>{if(this.stopping||this.phase==='blocked')this.disposePage().catch(()=>{})},()=>{});
   const page=await bounded(installation,5000);
   if(this.stopping||this.phase!=='starting')throw Error('校准启动已中断');this.page=page;
   this.phase='active';this.timer=setInterval(()=>this.poll().catch(()=>this.invalidate('无法读取网页内存状态，请停止后重新开始。')),800);this.timer.unref?.();
   this.onStatus(this.snapshot());return this.snapshot();
  }catch{await this.dispose();throw Error('无法建立后台校准，请确认豆包页面已加载且未被其他调试器占用')}
 }
 observe(params) {
  if(this.stopping||!this.attached||!['starting','active'].includes(this.phase))return;
  const r=params?.request;let url;
  try{url=new URL(r.url)}catch{return}
  if(r.method!=='POST'||url.origin!=='https://www.doubao.com'||url.pathname!=='/chat/completion')return;
  // getRequestPostData is intentionally not used: an unbound request must not
  // become evidence for a test merely because it happened nearby in time.
  let body;try{if(typeof r.postData!=='string'||r.postData.length>600000)return;body=JSON.parse(r.postData)}catch{return}
  const text=body?.messages?.length===1&&body.messages[0]?.content_block?.length===1?body.messages[0].content_block[0]?.content?.text_block?.text:null;
  const p=[...this.probes,this.test,...(this.operation?[this.operation]:[])].find(p=>p.prompt===text);if(!p)return;
  const prior=this.network.get(p.id);const signature=url.searchParams.get('a_bogus')||'';
  this.network.set(p.id,{id:p.id,requests:(prior?.requests||0)+1,signaturePresent:!!signature});
  this.signatures.set(p.id,signature);
 }
 invalidate(reason){if(this.stopping)return;this.epoch++;this.phase='blocked';this.reason=reason;clearInterval(this.timer);this.disposePage().catch(()=>{});this.onStatus(this.snapshot())}
 async invoke(method,value) {
  if(!this.attached||this.contents.isDestroyed())throw Error('网页连接已失效');
  return bounded(this.contents.executeJavaScript(`(()=>{const p=window[${JSON.stringify(this.key)}];if(!p)throw Error('Calibration expired');return p.${method}(${JSON.stringify(value)??''})})()`),5000);
 }
 async poll() {
  if(this.polling||this.stopping||this.phase!=='active')return;
  if(!this.businessVerified&&Date.now()>this.deadline){this.invalidate('已达到5分钟测试上限，未自动重试。请结束并保存。');await this.disposePage();return}
  const epoch=this.epoch;this.polling=true;try{const page=await this.invoke('snapshot');if(this.stopping||epoch!==this.epoch)return;this.page=page;if(this.snapshot().verified)this.businessVerified=true;this.onStatus(this.snapshot())}finally{this.polling=false}
 }
 async runTest() {
  if(this.stopping||this.phase!=='active'||this.page?.phase!=='ready')throw Error('请先完成三轮手动校准并确认状态已就绪');
  if(this.testStarted)throw Error('本次后台测试已经发起，不会重复发送');
  if(this.probes.some(p=>{const r=this.network.get(p.id);return !r||r.requests!==1||!r.signaturePresent})||new Set(this.probes.map(p=>this.signatures.get(p.id))).size!==this.probes.length)throw Error('尚未观察到每轮唯一请求及不同的网页签名；未发送后台测试');
  this.testStarted=true;const epoch=this.epoch;let page;
  try{page=await this.invoke('test')}catch{this.invalidate('后台调用未能确认状态，可能已经发送；不会自动重试，请结束并保存报告。');throw Error('后台调用状态无法确认，不会再次发送')}
  if(this.stopping||epoch!==this.epoch)throw Error('后台测试已停止，不会再次发送');this.page=page;this.onStatus(this.snapshot());return this.snapshot();
 }
 signatureResult() {
  const test=this.network.get(this.test.id);if(!test)return 'not-observed';
  if(test.requests!==1)return 'duplicate';if(!test.signaturePresent)return 'missing';
  const value=this.signatures.get(this.test.id);return this.probes.every(p=>value!==this.signatures.get(p.id))?'fresh':'reused';
 }
 snapshot() {
  const signature=this.signatureResult();const page=this.page||{};
  return {phase:this.phase==='active'?page.phase||'observing':this.phase,reason:this.reason||page.reason||'',deadline:this.deadline,
   probes:this.probes.map(p=>({id:p.id,prompt:p.prompt,...(page.probes||[]).find(v=>v.id===p.id)})),
   requestShapeReady:!!page.requestShapeReady,preSignInput:page.preSignInput===true,
   cursorEvidence:page.cursorEvidence||null,test:page.test||{sent:false,complete:false,exact:false},network:[...this.network.values()],signature,
   verified:this.phase==='active'&&['passed','generating'].includes(page.phase)&&page.test?.complete===true&&page.test?.exact===true&&signature==='fresh'&&this.probes.every(p=>this.network.get(p.id)?.requests===1),
   queueEnabled:!this.stopping&&this.phase==='active'&&signature==='fresh'&&this.probes.every(p=>this.network.get(p.id)?.requests===1)&&this.businessVerified===true&&['passed','generating'].includes(page.phase)};
 }

 async startTask(id,prompt){
  if(!this.snapshot().queueEnabled||this.stopping)throw Error('请先完成当前网页的后台连接测试');
  if(this.operation)throw Error('上一条后台任务尚未确认');
  this.operation={id,prompt};
  try{await this.invoke('startTask',{id,prompt});return {session:this.key,id}}catch{this.invalidate('发送状态不明，可能已经发送；不会自动重发');throw Error(this.reason)}
 }
 async taskResult(track){
  if(track?.session!==this.key||track.id!==this.operation?.id||this.stopping||this.phase!=='active')throw Error('原任务连接已失效；请取消此任务后重新创建，不会自动重发');
  const result=await this.invoke('taskSnapshot',track.id);
  if(result.error)throw Error(result.error);
  if(result.complete){
   const evidence=this.network.get(track.id),signature=this.signatures.get(track.id);
   if(!evidence||evidence.requests!==1||!signature||[...this.signatures].some(([id,value])=>id!==track.id&&value===signature)){
    this.invalidate('本次任务的新签名或唯一请求未确认，未导出');throw Error(this.reason);
   }
  }
  return result;
 }
 async releaseTask(track){if(track?.session!==this.key)throw Error('任务连接失效');await this.invoke('releaseTask',track.id);this.operation=null}
 async cancelTask(track){if(track?.session===this.key)await this.invoke('cancelTask',track.id);this.invalidate('任务已取消，请断开并重新校准')}
 async disposePage(){try{if(this.contents.isDestroyed())return true;await bounded(this.contents.executeJavaScript(`(()=>{window[${JSON.stringify(this.key)}]?.dispose();return true})()`),2000);return true}catch{return false}}
 async dispose() {
  if(this.disposePromise)return this.disposePromise;this.stopping=true;this.epoch++;clearInterval(this.timer);
  this.disposePromise=(async()=>{this.cleanupConfirmed=await this.disposePage();
  this.contents.removeListener('did-start-navigation',this.onNavigation);
  this.contents.debugger.removeListener('message',this.onMessage);this.contents.debugger.removeListener('detach',this.onDetach);
  if(this.attached)try{this.contents.debugger.detach()}catch{}this.attached=false;this.signatures.clear();this.operation=null;})();return this.disposePromise;
 }
 async stop() {
  if(this.stopPromise)return this.stopPromise;this.stopping=true;this.epoch++;clearInterval(this.timer);
  this.stopPromise=(async()=>{if(this.phase==='active')try{this.page=await this.invoke('snapshot')}catch{this.phase='blocked';this.reason='停止时网页校准状态已失效。'}
  const result=this.snapshot();await this.dispose();this.phase='stopped';
  // Prompts are synthetic but omitted to keep the report metadata-only.
  return {schemaVersion:1,startedAt:new Date(this.startedAt).toISOString(),endedAt:new Date().toISOString(),...result,cleanupConfirmed:!!this.cleanupConfirmed,probes:result.probes.map(({prompt,...p})=>p),privacy:'No request URLs, query values, headers, cookies, IDs, templates or answer text. Cleanup result is reported separately.'};})();return this.stopPromise;
 }
}
module.exports={BackendProbe};

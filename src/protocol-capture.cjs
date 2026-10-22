const {sanitizeEndpoint,jsonShape,ProtocolStream}=require('./protocol-schema.cjs');

const SAFE_TYPES=new Set(['Fetch','XHR','EventSource']);
const SENSITIVE_PATH=/(?:^|\/)(?:login|logout|passport|auth|oauth|account|profile|telemetry|analytics|monitor|logs?|report)(?:\/|$)/i;
const MIME_FORMATS=new Map([['text/event-stream','sse'],['application/x-ndjson','ndjson'],['application/ndjson','ndjson'],['application/json','json']]);

// This observer never sends, modifies or replays a website request. No headers are retained.
class ProtocolCapture {
 constructor(contents,{onStatus=()=>{},onTimeout=()=>{},durationMs=120000,maxRequests=30,maxBytes=1024*1024,commandTimeoutMs=3000}={}) {
  this.contents=contents;this.debugger=contents.debugger;this.onStatus=onStatus;this.onTimeout=onTimeout;
  this.durationMs=durationMs;this.maxRequests=maxRequests;this.maxBytes=maxBytes;this.commandTimeoutMs=commandTimeoutMs;
  this.records=new Map();this.phase='idle';this.owned=false;this.accepting=false;this.sequence=0;this.epoch=0;this.issues=new Set();
  this.message=(_event,method,params)=>{if(this.accepting)this.handle(method,params)};
  this.detached=()=>{this.owned=false;if(this.phase==='recording'){this.issues.add('debugger-detached');this.onTimeout('detached')}};
 }
 status(){return {phase:this.phase,count:this.records.size,deadline:this.deadline||null}}
 emit(){this.onStatus(this.status())}
 async command(method,params={}) {
  let timer;
  try{return await Promise.race([this.debugger.sendCommand(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capture-command-timeout')),this.commandTimeoutMs);timer.unref?.()})])}
  finally{clearTimeout(timer)}
 }
 async start() {
  if(this.phase!=='idle')throw Error('协议采集已启动，请先结束当前采集');
  if(!sanitizeEndpoint(this.contents.getURL()))throw Error('请先在右侧打开豆包并手动登录，再开始采集');
  if(this.debugger.isAttached())throw Error('浏览器调试器已被占用，请关闭该豆包页面的开发者工具后重试');
  this.phase='starting';this.emit();
  try {
   this.debugger.attach();this.owned=true;this.debugger.on('message',this.message);this.debugger.on('detach',this.detached);
   await this.command('Network.enable',{maxTotalBufferSize:this.maxBytes*4,maxResourceBufferSize:this.maxBytes,maxPostDataSize:65536});
   if(!this.owned||!this.debugger.isAttached())throw Error('capture-detached');
   this.startedAt=new Date().toISOString();this.deadline=Date.now()+this.durationMs;this.phase='recording';this.accepting=true;
   this.timer=setTimeout(()=>this.onTimeout('timeout'),this.durationMs);this.timer.unref?.();this.emit();return this.status();
  }catch {
   this.accepting=false;this.phase='failed';this.cleanup();this.emit();throw Error('无法启动本地协议采集，请关闭豆包开发者工具后重试。未发送任何消息。');
  }
 }
 cleanup() {
  clearTimeout(this.timer);this.debugger.removeListener('message',this.message);this.debugger.removeListener('detach',this.detached);
  if(this.owned){try{if(this.debugger.isAttached())this.debugger.detach()}catch{}this.owned=false}
 }
 handle(method,p) {
  if(method==='Network.requestWillBeSent') {
   // A redirect reuses requestId. Stop observing the old destination, even if the new one is excluded.
   if(this.records.has(p.requestId)) {const previous=this.records.get(p.requestId);previous.closed=true;previous.report.redirected=true;return}
   const req=p.request||{},endpoint=sanitizeEndpoint(req.url);
   if(!endpoint||!SAFE_TYPES.has(p.type)||(req.method!=='POST'&&p.type!=='EventSource'))return;
   let path;try{path=new URL(req.url).pathname}catch{return}
   if(SENSITIVE_PATH.test(path))return;
   if(this.records.size>=this.maxRequests){this.issues.add('request-limit');return}
   const r={report:{id:++this.sequence,endpoint,method:req.method==='POST'?'POST':'GET',resourceType:p.type,request:typeof req.postData==='string'?jsonShape(req.postData,{maxBytes:65536}):{format:req.hasPostData?'unavailable':'empty',fields:[],truncated:false},httpEnded:false},closed:false,bytes:0,chunks:[],queuedBytes:0,body:[],streamState:'none'};
   this.records.set(p.requestId,r);this.emit();return;
  }
  const r=this.records.get(p.requestId);if(!r||r.closed)return;
  if(method==='Network.responseReceived') {
   const response=p.response||{};
   if(!sanitizeEndpoint(response.url)){r.closed=true;r.report.responseSkipped='outside-allowed-site';return}
   r.report.status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
   const mime=String(response.mimeType||'').toLowerCase().split(';')[0].trim();r.format=MIME_FORMATS.get(mime);
   r.report.responseFormat=r.format||'unsupported';
   if(!r.format)return;
   if(r.format!=='json')r.parser=new ProtocolStream({format:r.format,maxBytes:this.maxBytes,maxEvents:1000});
   r.streamState='starting';const epoch=this.epoch;
   r.setup=this.command('Network.streamResourceContent',{requestId:p.requestId}).then(result=>{
    if(!this.accepting||epoch!==this.epoch||r.closed)return;
    r.streamState='streaming';r.report.bodySource='cdp-stream';
    if(typeof result.bufferedData==='string'){if(result.bufferedData.length>Math.ceil(this.maxBytes*4/3)+4)r.report.truncated=true;else this.consume(r,Buffer.from(result.bufferedData,'base64'))}
    for(const chunk of r.chunks)this.consume(r,chunk);r.chunks=[];r.queuedBytes=0;
   }).catch(()=>{if(this.accepting&&epoch===this.epoch){r.streamState='unavailable';r.report.streamUnavailable=true;r.chunks=[];r.queuedBytes=0}});
   return;
  }
  if(method==='Network.dataReceived'&&r.format&&typeof p.data==='string') {
   if(p.data.length>Math.ceil(this.maxBytes*4/3)+4){r.report.truncated=true;return}
   const chunk=Buffer.from(p.data,'base64');
   if(r.streamState==='starting'){if(r.queuedBytes+chunk.length<=this.maxBytes){r.chunks.push(chunk);r.queuedBytes+=chunk.length}else r.report.truncated=true}
   else if(r.streamState==='streaming')this.consume(r,chunk);
   return;
  }
  if(method==='Network.loadingFinished') {r.report.httpEnded=true;this.complete(r,p.requestId).catch(()=>{if(this.accepting)r.report.bodyUnavailable=true});return}
  if(method==='Network.loadingFailed') {r.report.httpFailed=true;r.closed=true;r.body=[];r.chunks=[];return}
 }
 consume(r,buffer) {
  if(r.report.truncated)return;
  if(r.bytes+buffer.length>this.maxBytes){r.report.truncated=true;return}
  r.bytes+=buffer.length;
  if(r.parser)r.parser.push(buffer);else r.body.push(buffer);
 }
 async complete(r,requestId) {
  const epoch=this.epoch;await r.setup;
  if(!this.accepting||epoch!==this.epoch||r.closed||!r.format)return;
  if(r.streamState!=='streaming') {
   try {const result=await this.command('Network.getResponseBody',{requestId});
    if(!this.accepting||epoch!==this.epoch||r.closed)return;
    const maxLength=result.base64Encoded?Math.ceil(this.maxBytes*4/3)+4:this.maxBytes;
    if(typeof result.body!=='string'||result.body.length>maxLength)r.report.truncated=true;
    else {this.consume(r,Buffer.from(result.body,result.base64Encoded?'base64':'utf8'));r.report.bodySource='cdp-completed-body'}
   }catch{if(this.accepting&&epoch===this.epoch)r.report.bodyUnavailable=true}
  }
  if(!this.accepting||epoch!==this.epoch)return;
  if(!r.bytes&&!r.report.truncated)r.report.bodyUnavailable=true;
  if(r.parser){if(!r.report.truncated&&!r.report.bodyUnavailable)r.parser.finish()}
  else if(r.report.truncated||r.report.bodyUnavailable)r.report.response={format:'incomplete',fields:[],truncated:true};
  else r.report.response=jsonShape(Buffer.concat(r.body).toString('utf8'),{maxBytes:this.maxBytes});
  r.body=[];r.chunks=[];r.closed=true;this.emit();
 }
 async stop(reason='manual') {
  if(this.stopPromise)return this.stopPromise;
  if(this.phase==='starting')throw Error('正在启动采集，请稍后再结束');
  this.stopPromise=this.finalize(reason);return this.stopPromise;
 }
 async finalize(reason) {
  this.accepting=false;this.epoch++;this.phase='saving';this.emit();this.cleanup();
  const requests=[];
  for(const r of this.records.values()) {
   if(r.parser)r.report.stream=r.parser.report();
   if(r.format==='json'&&!r.report.response&&r.body.length)r.report.response={format:'incomplete',fields:[],truncated:true};
   if(r.format&&(!r.closed||r.report.truncated||r.report.bodyUnavailable))r.report.bodyIncomplete=true;
   requests.push(r.report);r.body=[];r.chunks=[];r.parser=null;
  }
  this.records.clear();this.phase='stopped';this.emit();
  return {schemaVersion:1,startedAt:this.startedAt,endedAt:new Date().toISOString(),reason:['manual','timeout','detached','closing'].includes(reason)?reason:'manual',limits:{durationMs:this.durationMs,maxRequests:this.maxRequests,maxResponseBytes:this.maxBytes},scope:'same-site POST Fetch/XHR and EventSource started during capture; no websocket frames',privacy:'structure only; no message values, request headers, cookies or login storage',issues:[...this.issues],requests,interpretation:'HTTP结束和白名单结束标记仅为协议证据，不代表生成成功、联网核实或后台接口已接通。'};
 }
}
module.exports={ProtocolCapture};

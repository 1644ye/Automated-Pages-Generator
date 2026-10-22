const {sanitizeEndpoint,jsonShape,ProtocolStream}=require('./protocol-schema.cjs');
const {ProtocolEvidence,safeProtocolName}=require('./protocol-detail.cjs');
// Observed in the user's 0.1.3 capture (2026-10-22), not an assumed API.
const OBSERVED_ENDPOINT='https://www.doubao.com/chat/completion';

const SAFE_TYPES=new Set(['Fetch','XHR','EventSource']);
const SENSITIVE_PATH=/(?:^|\/)(?:login|logout|passport|auth|oauth|account|profile|telemetry|analytics|monitor|logs?|report)(?:\/|$)/i;
const MIME_FORMATS=new Map([['text/event-stream','sse'],['application/x-ndjson','ndjson'],['application/ndjson','ndjson'],['application/json','json']]);

// This observer never sends, modifies or replays a website request. No headers are retained.
class ProtocolCapture {
 constructor(contents,{onStatus=()=>{},onTimeout=()=>{},durationMs=120000,maxRequests=30,maxBytes=1024*1024,commandTimeoutMs=3000,targeted=false,probes=[]}={}) {
  this.contents=contents;this.debugger=contents.debugger;this.onStatus=onStatus;this.onTimeout=onTimeout;
  this.durationMs=durationMs;this.maxRequests=maxRequests;this.maxBytes=maxBytes;this.commandTimeoutMs=commandTimeoutMs;
  this.records=new Map();this.phase='idle';this.owned=false;this.accepting=false;this.sequence=0;this.epoch=0;this.issues=new Set();
  this.targeted=targeted;this.probes=probes;this.evidence=targeted?new ProtocolEvidence({probes}):null;this.previousQuery=new Map();this.pendingHeaderNames=new Map();
  this.message=(_event,method,params)=>{if(this.accepting)this.handle(method,params)};
  this.detached=()=>{this.owned=false;if(this.phase==='recording'){this.issues.add('debugger-detached');this.onTimeout('detached')}};
 }
 status(){return {phase:this.phase,count:this.records.size,deadline:this.deadline||null,probeResponses:this.probes.map(p=>({id:p.id,requests:[...this.records.values()].filter(r=>r.report.probes?.includes(p.id)).map(r=>({id:r.report.id,httpEnded:r.report.httpEnded,streamReceived:r.bytes>0,failed:!!r.report.httpFailed}))}))}}
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
  if(method==='Network.requestWillBeSentExtraInfo'&&this.targeted){
   // https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestWillBeSentExtraInfo
   // CDP does not guarantee whether these names arrive before or after the request.
   const names=this.headerNames(p.headers),record=this.records.get(p.requestId);
   if(record){if(!record.report.redirected){record.report.requestHeaderNames=[...new Set([...record.report.requestHeaderNames,...names])].sort();record.report.extraHeaderNamesObserved=true}}
   else {const now=Date.now();for(const [id,entry] of this.pendingHeaderNames)if(now-entry.at>5000)this.pendingHeaderNames.delete(id);if(this.pendingHeaderNames.size>=128)this.pendingHeaderNames.delete(this.pendingHeaderNames.keys().next().value);this.pendingHeaderNames.set(p.requestId,{at:now,names})}
   return;
  }
  if(method==='Network.requestWillBeSent') {
   const pendingHeaders=this.pendingHeaderNames.get(p.requestId),earlyHeaders=pendingHeaders&&Date.now()-pendingHeaders.at<=5000?pendingHeaders:null;this.pendingHeaderNames.delete(p.requestId);
   // A redirect reuses requestId. Stop observing the old destination, even if the new one is excluded.
   if(this.records.has(p.requestId)) {const previous=this.records.get(p.requestId);previous.closed=true;previous.report.redirected=true;return}
   const req=p.request||{},endpoint=sanitizeEndpoint(req.url);
   if(!endpoint||!SAFE_TYPES.has(p.type)||(req.method!=='POST'&&p.type!=='EventSource'))return;
   let path;try{path=new URL(req.url).pathname}catch{return}
   if(this.targeted&&(new URL(req.url).origin+path!==OBSERVED_ENDPOINT||req.method!=='POST'))return;
   if(SENSITIVE_PATH.test(path))return;
   if(this.records.size>=this.maxRequests){this.issues.add('request-limit');return}
   const id=++this.sequence;
   const r={report:{id,endpoint,method:req.method==='POST'?'POST':'GET',resourceType:p.type,request:typeof req.postData==='string'?(this.evidence?this.evidence.inspect(req.postData,{channel:'request-'+id,maxBytes:65536}):jsonShape(req.postData,{maxBytes:65536})):{format:req.hasPostData?'unavailable':'empty',fields:[],truncated:false},httpEnded:false},closed:false,bytes:0,chunks:[],queuedBytes:0,body:[],streamState:'none'};
   if(this.targeted){
    const query=new URL(req.url).searchParams;
    endpoint.queryKeys=[...new Set([...query.keys()].slice(0,64).map(k=>safeProtocolName(k)||'[key]'))].sort();
    r.report.queryChanges=[...query.entries()].slice(0,64).map(([key,value])=>({key:safeProtocolName(key)||'[key]',comparison:this.previousQuery.has(key)?(this.previousQuery.get(key)===value?'same':'changed'):'first-observation'}));
    this.previousQuery=new Map([...query.entries()].slice(0,64));
    r.report.requestHeaderNames=[...new Set([...this.headerNames(req.headers),...(earlyHeaders?.names||[])])].sort();
    r.report.extraHeaderNamesObserved=!!earlyHeaders;r.report.headerEvidence='observed names only; may be incomplete';
    r.report.probes=this.probes.filter(p=>typeof req.postData==='string'&&req.postData.includes(p.marker)).map(p=>p.id);
   }
   this.records.set(p.requestId,r);this.emit();return;
  }
  const r=this.records.get(p.requestId);if(!r||r.closed)return;
  if(method==='Network.responseReceived') {
   const response=p.response||{};
   if(!sanitizeEndpoint(response.url)||(this.targeted&&new URL(response.url).origin+new URL(response.url).pathname!==OBSERVED_ENDPOINT)){r.closed=true;r.report.responseSkipped='outside-allowed-site';return}
   r.report.status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
   const mime=String(response.mimeType||'').toLowerCase().split(';')[0].trim();r.format=MIME_FORMATS.get(mime);
   r.report.responseFormat=r.format||'unsupported';
   if(!r.format)return;
   if(r.format!=='json')r.parser=new ProtocolStream({format:r.format,maxBytes:this.maxBytes,maxEvents:1000,evidence:this.evidence,channel:'response-'+r.report.id});
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
 headerNames(headers){return Object.keys(headers||{}).slice(0,64).map(k=>safeProtocolName(k)||'[header]').sort()}
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
  else r.report.response=this.evidence?this.evidence.inspect(Buffer.concat(r.body).toString('utf8'),{channel:'response-'+r.report.id,maxBytes:this.maxBytes}):jsonShape(Buffer.concat(r.body).toString('utf8'),{maxBytes:this.maxBytes});
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
  const evidence=this.evidence?.report();this.evidence?.dispose();this.previousQuery.clear();this.pendingHeaderNames.clear();this.probes=[];
  this.records.clear();this.phase='stopped';this.emit();
  return {schemaVersion:this.targeted?2:1,startedAt:this.startedAt,endedAt:new Date().toISOString(),reason:['manual','timeout','detached','closing'].includes(reason)?reason:'manual',limits:{durationMs:this.durationMs,maxRequests:this.maxRequests,maxResponseBytes:this.maxBytes},scope:this.targeted?'POST '+OBSERVED_ENDPOINT:'same-site POST Fetch/XHR and EventSource started during capture; no websocket frames',privacy:this.targeted?'protocol names, ordered schemas, local ID aliases, whitelisted controls and synthetic-probe matches; no raw message values, query/header values, cookies or login storage':'structure only; no message values, request headers, cookies or login storage',issues:[...this.issues],requests,...(evidence?{evidence}:{}),interpretation:'HTTP结束和块结束标记仅为协议证据，不代表整轮生成成功、联网核实或后台接口已接通。'};
 }
}
module.exports={ProtocolCapture};

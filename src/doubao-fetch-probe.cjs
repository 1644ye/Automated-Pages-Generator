'use strict';

// Injected only after an explicit local button click. This function is deliberately
// self-contained: it observes standard fetch calls and never accesses DOM/login
// storage, discovers private functions, or constructs a signature.
function installFetchProbe(config, createAnswerRuntime) {
 const endpoint='https://www.doubao.com/chat/completion';
 const copy=value=>JSON.parse(JSON.stringify(value));
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const key=config?.key;
 const probes=config?.probes;
 const testProbe=config?.test;
 const validProbe=p=>p&&typeof p.id==='string'&&/^[a-z0-9-]{1,32}$/.test(p.id)&&typeof p.marker==='string'&&/^APG_[A-Za-z0-9_]{12,120}$/.test(p.marker)&&p.prompt==='请严格只回复这一行文字，不要添加解释、引号或代码块：\n'+p.marker;
 if(typeof key!=='string'||key.length<16||key.length>128||!/^[A-Za-z_$][\w$]+$/.test(key)||Object.prototype.hasOwnProperty.call(window,key)||!Array.isArray(probes)||![2,3].includes(probes.length)||!probes.every(validProbe)||!validProbe(testProbe)||new Set([...probes,testProbe].map(p=>p.marker)).size!==probes.length+1)throw Error('无效的后台测试配置');
 if(window.location.origin!=='https://www.doubao.com'||typeof window.fetch!=='function')throw Error('请先打开并登录豆包网页');
 const {AnswerStream}=createAnswerRuntime();
 const originals=probes.map(p=>copy(p));const testConfig=copy(testProbe);
 const originalFetch=window.fetch;
 const state={phase:'observing',reason:'请依次手动发送校准消息。',probes:originals.map(p=>({id:p.id,seen:false,httpStatus:null,complete:false,exact:false,parserError:'',frames:0,bytes:0,signals:{}})),requestShapeReady:false,preSignInput:null,test:{sent:false,httpStatus:null,complete:false,exact:false,parserError:'',frames:0,bytes:0,signals:{}},deadline:Date.now()+Math.min(240000,Math.max(1000,config.durationMs||180000))};
 let templates=originals.map(()=>null),answers=originals.map(()=>null),active=-1,disposed=false,timer,controller=null;
 const readers=new Set();
 const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const snapshot=()=>copy(state);
 function clearMemory(){templates=originals.map(()=>null);answers=originals.map(()=>null);for(const reader of readers)try{Promise.resolve(reader.cancel()).catch(()=>{})}catch{}readers.clear();if(controller)controller.abort();controller=null;clearTimeout(timer);if(window.fetch===wrappedFetch)window.fetch=originalFetch;}
 function block(reason){if(disposed||state.phase==='passed'||state.phase==='blocked')return;state.phase='blocked';state.reason=reason;state.requestShapeReady=false;clearMemory();}
 function arm(ms,reason){clearTimeout(timer);timer=setTimeout(()=>block(reason),ms);}
 function isActive(){return !disposed&&!['passed','blocked','disposed'].includes(state.phase);}
 function bodyInfo(body){
  if(!body||typeof body!=='object'||!body.client_meta||!body.option||!Array.isArray(body.messages)||body.messages.length!==1)throw Error('请求结构不是单条普通对话');
  const msg=body.messages[0],blocks=msg.content_block;
  if(!Array.isArray(blocks)||blocks.length!==1||blocks[0].block_type!==10000||typeof blocks[0].content?.text_block?.text!=='string')throw Error('请求不是单个纯文本块');
  if(!uuid(msg.local_message_id)||!uuid(blocks[0].block_id)||msg.local_message_id===blocks[0].block_id)throw Error('消息或文本块标识格式尚未适配');
  if(typeof body.client_meta.bot_id!=='string'||!body.client_meta.bot_id||typeof body.client_meta.conversation_id!=='string')throw Error('会话字段尚未适配');
  return {msg,block:blocks[0],text:blocks[0].content.text_block.text};
 }
 function parseCall(input,init){
  let url,method;
  try{url=new URL(typeof input==='string'||input instanceof URL?input:input?.url,window.location.href);method=String(init?.method||input?.method||'GET').toUpperCase()}catch{return null}
  if(url.origin+url.pathname!==endpoint||method!=='POST')return null;
  if(!(typeof input==='string'||input instanceof URL)||typeof init?.body!=='string'){block('网页使用了未适配的 Request 或请求体形式；未发送后台测试');return null}
  if(init.body.length>256000){block('对话请求体超过测试上限');return null}
  let body,info;try{body=JSON.parse(init.body);info=bodyInfo(body)}catch{block('网页对话请求结构尚未适配；未发送后台测试');return null}
  const index=originals.findIndex(p=>p.prompt===info.text);
  if(index<0){block('校准期间出现其他对话请求；请结束后重新准备');return null}
  if(active!==-1||state.probes[index].seen||index!==state.probes.filter(p=>p.complete).length){block('校准消息须依次发送并等待完整回答，不能重发或并行');return null}
  const headers=new Headers(init.headers);
  const hasProtectedHeader=[...headers.keys()].some(name=>/authorization|cookie|signature/i.test(name));
  const signed=[...url.searchParams.keys()].some(name=>name.toLowerCase()==='a_bogus');
  const candidate={url:String(input),init:{...init,headers:new Headers(headers)},body,at:Date.now(),preSign:!signed&&!hasProtectedHeader};
  // An old AbortSignal must never be reused for the separate one-shot test.
  delete candidate.init.signal;
  templates[index]=candidate;state.probes[index].seen=true;active=index;
  state.preSignInput=state.preSignInput===false?false:candidate.preSign;
  return {index,info,body};
 }
 function indexMapping(){
  const boundedIndex=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
  const rows=templates.map((t,i)=>({request:boundedIndex(t?.body.client_meta.last_message_index)?t.body.client_meta.last_message_index:null,
   question:boundedIndex(answers[i]?.binding.questionMessageIndex)?answers[i].binding.questionMessageIndex:null,
   answer:boundedIndex(answers[i]?.binding.answerMessageIndex)?answers[i].binding.answerMessageIndex:null}));
  state.cursorEvidence={rows,candidates:[],next:null};
  const transitions=rows.slice(1);if(transitions.some(r=>r.request===null))throw Error('会话消息序号格式尚未适配');
  const predictions=[];
  for(const source of ['question','answer']){
   if(rows.some(r=>r[source]===null))continue;
   const offsets=transitions.map((r,i)=>r.request-rows[i][source]);
   if(new Set(offsets).size!==1||(transitions.length<2&&offsets[0]!==0))continue;
   const next=rows.at(-1)[source]+offsets[0];if(!boundedIndex(next))continue;
   state.cursorEvidence.candidates.push({source,offset:offsets[0],next});predictions.push(next);
  }
  if(transitions.length>=2&&new Set(transitions.map(r=>r.request)).size===1){const next=transitions[0].request;state.cursorEvidence.candidates.push({source:'constant',next});predictions.push(next)}
  if(!predictions.length){
   if(transitions.length<2)throw Error('无法确认上一条消息序号的映射；未猜测序号增量');
   // This bridge can only send its fixed synthetic probe, never business data.
   // Preserve the latest server-accepted request value instead of inventing an
   // increment. It is an unverified compatibility attempt, not a cursor model.
   state.cursorEvidence.mode='observed-reuse-experiment';
   state.cursorEvidence.next=rows.at(-1).request;
   return state.cursorEvidence.next;
  }
  if(new Set(predictions).size!==1)throw Error('消息序号映射不唯一；未发送后台测试');
  state.cursorEvidence.mode='validated-relation';state.cursorEvidence.next=predictions[0];return predictions[0];
 }
 function uniqueRelation(body){
  const value=body.option.unique_key;
  if(!uuid(value))throw Error('请求唯一标识不是已适配的 UUID');
  if(value===body.messages[0].local_message_id)return 'message';
  if(value===body.messages[0].content_block[0].block_id)return 'block';
  return 'independent';
 }
 function buildTestRequest(){
  const a=templates[0],b=templates.at(-1),ra=answers[0],rb=answers.at(-1);
  if(!a||!b||!ra?.complete||!rb?.complete)throw Error('所有轮次校准尚未完成');
  if(templates.some(t=>!t?.preSign))throw Error('网页 fetch 输入已带签名或受保护请求头；不能重放旧签名');
  if(window.fetch!==wrappedFetch)throw Error('网页请求函数已变化，请重新准备');
  if(a.body.option.need_create_conversation!==true||b.body.option.need_create_conversation!==false)throw Error('请从新建普通会话开始，随后在同一会话发送第二条');
  if(!rb.binding?.conversationId||ra.binding?.conversationId!==rb.binding.conversationId||b.body.client_meta.conversation_id!==ra.binding.conversationId||b.body.client_meta.last_section_id!==ra.binding.sectionId||!rb.binding.sectionId||a.body.client_meta.bot_id!==b.body.client_meta.bot_id)throw Error('所有轮次会话或分区绑定不一致');
  for(let i=1;i<templates.length;i++){
   const t=templates[i],prev=answers[i-1];
   if(t.body.option.need_create_conversation!==false||t.body.client_meta.conversation_id!==prev.binding.conversationId||t.body.client_meta.last_section_id!==prev.binding.sectionId||answers[i].binding.conversationId!==prev.binding.conversationId||t.body.client_meta.bot_id!==a.body.client_meta.bot_id)throw Error('所有轮次会话或分区绑定不一致');
  }
  for(const get of [t=>t.body.messages[0].local_message_id,t=>t.body.messages[0].content_block[0].block_id,t=>t.body.option.unique_key])if(new Set(templates.map(get)).size!==templates.length)throw Error('所有轮次请求复用了唯一标识，不能安全构造测试');
  if(answers.some(r=>!r?.complete||stable(r.profile)!==stable(ra.profile)))throw Error('所有轮次返回的补丁或结束控制组合不同，尚未适配');
  for(const t of templates)if(!Number.isSafeInteger(t.body.option.create_time_ms)||Math.abs(t.body.option.create_time_ms-t.at)>60000)throw Error('请求时间字段未能通过现场校验');
  if(!Number.isSafeInteger(a.body.option.start_seq)||templates.some(t=>t.body.option.start_seq!==a.body.option.start_seq))throw Error('流起始序号发生变化，尚未适配');
  if(a.body.messages[0].local_message_id===b.body.messages[0].local_message_id||a.body.messages[0].content_block[0].block_id===b.body.messages[0].content_block[0].block_id||a.body.option.unique_key===b.body.option.unique_key)throw Error('所有轮次请求复用了唯一标识，不能安全构造测试');
  const relation=uniqueRelation(a.body);if(templates.some(t=>relation!==uniqueRelation(t.body)))throw Error('请求唯一标识关联发生变化');
  const recovery=templates.map(t=>t.body.option.recovery_option?.req_create_time_sec);
  let refreshRecovery=false;
  if(recovery.some(v=>v!==0)){
   if(!templates.every((t,i)=>Number.isSafeInteger(recovery[i])&&Math.abs(recovery[i]*1000-t.at)<=60000))throw Error('恢复时间字段尚未适配');
   refreshRecovery=true;
  }
  const body=copy(b.body),message=body.messages[0],blockValue=message.content_block[0];
  body.client_meta.last_message_index=indexMapping();body.client_meta.last_section_id=rb.binding.sectionId;
  message.local_message_id=crypto.randomUUID();blockValue.block_id=crypto.randomUUID();
  body.option.unique_key=relation==='message'?message.local_message_id:relation==='block'?blockValue.block_id:crypto.randomUUID();
  body.option.create_time_ms=Date.now();if(refreshRecovery)body.option.recovery_option.req_create_time_sec=Math.floor(Date.now()/1000);
  blockValue.content.text_block.text=testConfig.prompt;
  return {url:b.url,init:{...b.init,headers:new Headers(b.init.headers),body:JSON.stringify(body)},body,profile:copy(rb.profile)};
 }
 async function readResponse(response,expected,body,profile,record){
  record.httpStatus=Number.isInteger(response?.status)?response.status:null;
  if(response?.status!==200)throw Error('对话请求未返回 HTTP 200，请手动检查登录、验证码或额度');
  if(!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error('返回不是 SSE 对话流，请手动检查网页状态');
  if(!response.body?.getReader)throw Error('网页响应不可流式读取');
  const parser=new AnswerStream({localMessageId:body.messages[0].local_message_id,conversationId:body.client_meta.conversation_id,botId:body.client_meta.bot_id,prompt:expected.prompt,expectedText:expected.marker,...(profile?{patchProfile:profile}:{})});
  const progress=()=>{const value=parser.snapshot();record.parserError=value.error;record.frames=value.frames;record.bytes=value.bytes;record.profile=copy(value.profile);record.patchDiagnostic=value.patchDiagnostic;record.signals=Object.fromEntries(['echo','blockFinished','messageFinished','messageEnd','answerEnd','terminalEnd'].map(name=>[name,!!value.signals?.[name]]));return value};
  const reader=response.body.getReader();readers.add(reader);
  try{
   while(isActive()){
    const {done,value}=await reader.read();if(!isActive())return null;
    if(done)break;parser.feed(value);if(progress().error)throw Error('回答绑定、正文分片或协议控制校验失败');
   }
   if(!isActive())return null;
   parser.finish();const result=progress();record.exact=result.text===expected.marker;record.complete=!!result.complete;
   if(result.error||!result.complete||!record.exact)throw Error('回答未完整匹配本次校准标记或缺少整轮结束信号');
   return result;
  }finally{readers.delete(reader);try{Promise.resolve(reader.cancel()).catch(()=>{})}catch{}try{reader.releaseLock()}catch{}}
 }
 async function observeResponse(response,observed){
  if(!isActive())return;
  const index=observed.index;
  try{
   const cloned=response.clone();
   const result=await readResponse(cloned,originals[index],observed.body,null,state.probes[index]);
   if(!isActive()||!result)return;answers[index]=result;active=-1;
   if(index===originals.length-1){buildTestRequest();state.phase='ready';state.requestShapeReady=true;state.reason='所有轮次解析校准通过，可以尝试一次后台测试。'}
   else state.reason='本条校准通过，请在同一会话手动发送下一条。';
  }catch(error){block(error?.message&&['对话请求未返回 HTTP 200，请手动检查登录、验证码或额度','返回不是 SSE 对话流，请手动检查网页状态','网页响应不可流式读取','回答绑定、正文分片或协议控制校验失败','回答未完整匹配本次校准标记或缺少整轮结束信号','所有轮次校准尚未完成','网页 fetch 输入已带签名或受保护请求头；不能重放旧签名','网页请求函数已变化，请重新准备','请从新建普通会话开始，随后在同一会话发送第二条','所有轮次会话或分区绑定不一致','所有轮次返回的补丁或结束控制组合不同，尚未适配','请求时间字段未能通过现场校验','流起始序号发生变化，尚未适配','所有轮次请求复用了唯一标识，不能安全构造测试','请求唯一标识不是已适配的 UUID','请求唯一标识关联发生变化','恢复时间字段尚未适配','会话消息序号格式尚未适配','无法确认上一条消息序号的映射；未猜测序号增量','消息序号映射不唯一；未发送后台测试'].includes(error.message)?error.message:'响应读取失败，未发送后台测试')}
 }
 function wrappedFetch(...args){
  let observed=null;
  if(isActive())try{observed=parseCall(args[0],args[1])}catch{block('请求观察失败，未发送后台测试')}
  let result;
  try{result=Reflect.apply(originalFetch,this,args)}catch(error){if(observed)block('手动请求失败，请检查网页');throw error}
  // Clone before handing the same Response to its caller. Returning the original
  // promise could allow a cross-realm consumer to lock the body first.
  if(observed)return Promise.resolve(result).then(response=>{observeResponse(response,observed).catch(()=>block('响应读取失败，未发送后台测试'));return response},error=>{block('手动请求失败，请检查网页');throw error});
  return result;
 }
 function test(){
  if(disposed||state.phase!=='ready'||state.test.sent)throw Error('尚未就绪或本轮后台测试已经执行，不会重复发送');
  let request;try{request=buildTestRequest()}catch{block('测试前请求映射已失效，请重新准备');return snapshot()}
  state.phase='testing';state.reason='正在执行一次后台测试，不会自动重试。';state.test.sent=true;controller=new AbortController();request.init.signal=controller.signal;state.deadline=Date.now()+60000;arm(60000,'后台测试超时，已停止读取；不会自动重发');
  let response;try{response=Reflect.apply(originalFetch,window,[request.url,request.init])}catch{block('后台测试发送失败；不会重试');return snapshot()}
  Promise.resolve(response).then(response=>readResponse(response,testConfig,request.body,request.profile,state.test)).then(result=>{
   if(!isActive()||!result)return;state.phase='passed';state.reason='后台返回已通过完整回答校验，仍需主进程核对新签名。';clearMemory();
  }).catch(()=>block('后台测试失败，请手动检查登录、验证码、额度或协议兼容性；不会重试'));
  return snapshot();
 }
 function dispose(){if(disposed)return snapshot();disposed=true;state.phase='disposed';state.reason='后台测试已结束，内存请求模板已清理。';state.requestShapeReady=false;clearMemory();return snapshot()}
 Object.defineProperty(window,key,{value:Object.freeze({snapshot,test,dispose}),configurable:true,enumerable:false,writable:false});
 window.fetch=wrappedFetch;arm(Math.max(1,state.deadline-Date.now()),'准备超过时间上限，未继续发送；请重新准备');
 return snapshot();
}

module.exports={installFetchProbe};

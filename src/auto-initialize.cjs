'use strict';
// UI rules are centralized. textarea/sidebar test IDs come from the user's
// saved structure report; controls are matched by their current visible labels.
function connectionPage(op,prompt=''){
 const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
 const label=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim();
 const blocked=controls.some(e=>/^(登录|立即登录|登录豆包|Log in|Sign in)$/i.test(label(e)))||[...document.querySelectorAll('[role="dialog"],[role="alert"]')].filter(visible).some(e=>/验证码|安全验证|登录失效|账号异常|次数.*上限|额度不足|稍后再试/.test(e.innerText||''));
 if(blocked)throw Error('请先手动完成登录、验证码或账号/额度处理，再点击继续');
 const inputs=[...document.querySelectorAll('textarea[data-testid="chat_input_input"]')].filter(visible);
 if(inputs.length!==1||inputs[0].disabled)throw Error('未找到唯一可用的豆包输入框，请确认登录和页面已加载');
 const editor=inputs[0];
 const generating=controls.some(e=>/^(停止|停止生成|Stop|Stop generating)$/i.test(label(e)));
 if(op==='status')return {ready:document.readyState==='complete',empty:!editor.value.trim(),generating};
 if(generating)throw Error('网页仍在生成，请等结束后继续');
 if(op==='new'){
  if(editor.value.trim())throw Error('豆包输入框有未发送草稿，请先手动处理，不会覆盖');
  const sidebar=document.querySelector('[data-testid="flow_chat_sidebar"]');if(!sidebar)throw Error('新对话入口未适配，请检查页面');
  const matches=[...sidebar.querySelectorAll('button,a,div,span,[role="button"]')].filter(visible).filter(e=>(e.innerText||'').trim()==='新对话').filter(e=>![...e.children].some(c=>(c.innerText||'').trim()==='新对话'));
  if(matches.length!==1)throw Error('新对话入口不唯一，未发送消息');matches[0].click();return true;
 }
 if(op==='fill'){
  if(editor.value.trim())throw Error('输入框有草稿，未覆盖');
  editor.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,prompt);editor.dispatchEvent(new Event('input',{bubbles:true}));return true;
 }
 if(op==='submit'){
  if(editor.value!==prompt)throw Error('校准发送前输入内容变化，未发送');editor.focus();
  const sends=controls.filter(e=>/^(发送|发送消息|Send|Send message)$/i.test(label(e)));
  if(sends.length>1)throw Error('发送入口不唯一');
  if(sends.length===1){if(sends[0].disabled||sends[0].getAttribute('aria-disabled')==='true')throw Error('发送按钮不可用');sends[0].click();return 'clicked'}
  if(document.activeElement!==editor)throw Error('无法确认输入焦点');return 'enter';
 }
 throw Error('未知初始化操作');
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class AutoInitializer{
 constructor(contents,{createBackend,onProgress=()=>{},sleep=wait,now=Date.now}={}){this.contents=contents;this.createBackend=createBackend;this.onProgress=onProgress;this.sleep=sleep;this.now=now;this.canceled=false}
 cancel(){this.canceled=true}
 check(){if(this.canceled)throw Error('自动初始化已暂停；不会重发校准消息')}
 async page(op,prompt){
  this.check();this.step=op;let timer;
  try{
   const code=`(()=>{try{return {ok:true,value:(${connectionPage.toString()})(${JSON.stringify(op)},${JSON.stringify(prompt||'')})}}catch(error){return {ok:false,error:String(error?.message||'网页执行异常').slice(0,300)}}})()`;
   const result=await Promise.race([this.contents.executeJavaScript(code,true),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('网页操作超时，状态不明，不会重试发送')),5000)})]);
   if(!result||result.ok!==true)throw Error(result?.error||'网页未返回有效状态');return result.value;
  }catch(error){const labels={status:'检查页面',new:'新建会话',fill:'填写校准消息',submit:'发送校准消息'};throw Error((labels[op]||op)+'失败：'+error.message)}finally{clearTimeout(timer)}
 }

 async until(check,ms,message){const deadline=this.now()+ms;while(true){this.check();if(await check())return;if(this.now()>=deadline)throw Error(message);await this.sleep(300)}}
 async run(){
  this.onProgress('正在检查登录并创建初始化会话');await this.page('status');await this.page('new');
  await this.sleep(500);await this.until(async()=>{const s=await this.page('status');return s.ready&&s.empty},10000,'新对话未就绪，未发送');
  this.check();const host=await this.createBackend();this.host=host;await host.start();this.check();
  for(let i=0;i<host.probes.length;i++){
   this.onProgress('正在自动初始化 '+(i+1)+' / '+host.probes.length);
   await this.until(async()=>{const s=await this.page('status');return s.ready&&s.empty&&!s.generating},10000,'输入框未恢复就绪，请手动检查');
   const prompt=host.probes[i].prompt;await this.page('fill',prompt);await this.sleep(150);this.check();
   const mode=await this.page('submit',prompt);this.check();
   if(mode==='enter'){this.contents.sendInputEvent({type:'keyDown',keyCode:'Enter'});this.contents.sendInputEvent({type:'keyUp',keyCode:'Enter'})}
   await this.until(async()=>{await host.poll();const s=host.snapshot();if(['blocked','disposed','stopped','failed'].includes(s.phase))throw Error(s.reason||'初始化已中断');if(s.probes?.[i]?.complete)return true;await this.page('status');return false},70000,'校准回答未能确认完成，已暂停；不会再次发送');
  }
  this.check();this.onProgress('正在验证后台连接');await host.runTest();
  await this.until(async()=>{await host.poll();const s=host.snapshot();if(['blocked','disposed','stopped','failed'].includes(s.phase))throw Error(s.reason||'后台连接验证失败');return s.queueEnabled===true},70000,'后台连接未能通过验证，已暂停');
  this.check();return host;
 }
}
module.exports={AutoInitializer,connectionPage};

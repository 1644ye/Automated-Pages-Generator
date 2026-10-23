const $=id=>document.getElementById(id);
let state,selectedId;
let liveKey='',liveSince=Date.now(),lastText='',lastTextAt=Date.now();
function renderLive(s){
 const tasks=s.tasks||[],init=s.initialization||{},current=tasks.find(t=>['生成中','待导出'].includes(t.status)),attention=tasks.find(t=>['待人工处理','校验失败'].includes(t.status)),pending=tasks.filter(t=>t.status==='待处理');
 let title='等待添加任务',detail='填写输入材料并勾选内容，点击生成即可。',stage=-1,tone='idle',task=current;
 if(init.phase==='running'){title=init.message;detail='正在自动建立连接，请勿在豆包中输入或切换会话。';stage=0;tone='busy'}
 else if(current){title=current.status==='待导出'?'校验通过 · 正在导出 XLSX':current.repairAttempt?'正在修复返回格式（仅一次）':current.raw?'正在接收生成内容':'请求已发送 · 等待豆包回答';stage=current.status==='待导出'?3:1;tone='busy';detail=current.input.refTitle;if(s.paused){title='队列已暂停 · 当前回答暂存';tone='paused';detail+='。点击继续后读取原任务，不会重新发送。'}}
 else if(init.phase==='attention'||attention){title='需要处理 · '+(attention?.status||'初始化未完成');detail=init.phase==='attention'?init.message:attention.error;stage=-1;tone='error';task=attention}
 else if(pending.length){title=s.paused?'队列已暂停':'准备发送下一条任务';detail=pending[0].input.refTitle;stage=0;tone=s.paused?'paused':'busy';task=pending[0]}
 else if(tasks.some(t=>t.status==='已完成')){title='生成完成 · XLSX 已导出';detail='可在下方导出记录查看文件，或打开导出目录。';stage=4;tone='success'}
 if(s.backend?.readHealth&&current){detail+='；连接状态读取暂时失败，正在重读原任务。'}
 const key=[task?.id||'',title].join('|');if(key!==liveKey){liveKey=key;liveSince=Date.now()}
 const raw=current?.raw||'';if(raw!==lastText){lastText=raw;lastTextAt=Date.now()}
 $('liveStatus').dataset.tone=tone;$('liveBadge').textContent={busy:'进行中',paused:'已暂停',error:'需处理',success:'已完成',idle:'就绪'}[tone];$('liveTitle').textContent=title;
 $('liveDetail').textContent=detail;$('liveElapsed').textContent=['busy','paused','error'].includes(tone)?'当前状态 '+Math.floor((Date.now()-liveSince)/1000)+' 秒':'';
 $('liveSteps').replaceChildren();['初始化连接','生成回答','校验内容','导出 XLSX'].forEach((label,i)=>{const el=document.createElement('span');el.textContent=(i+1)+' '+label;el.className=i<stage?'done':i===stage?'current':'';$('liveSteps').append(el)});
 $('liveCounts').textContent='共 '+tasks.length+' 条 · 等待 '+pending.length+' · 已完成 '+tasks.filter(t=>t.status==='已完成').length+' · 需处理 '+tasks.filter(t=>['待人工处理','校验失败'].includes(t.status)).length+(current?' · 已接收 '+raw.length+' 字符'+(raw?' · 距正文更新 '+Math.floor((Date.now()-lastTextAt)/1000)+' 秒':''):'');
}

const names={brand:'品牌名称（选填，仅 SEO）',email:'联系邮箱（选填）',website:'网站地址（选填）',refTitle:'参考网站描述 · 标题',refBody:'参考网站描述 · 内容',discount:'最高折扣 % OFF',date:'文案日期（选填）',details:'产品与服务补充（选填）'};
for(const [id,title] of Object.entries(names)) {
 const label=document.createElement('label');label.textContent=title;
 const el=document.createElement(['refBody','details'].includes(id)?'textarea':'input');el.id=id;
 if(id==='discount'){el.type='number';el.min=1;el.max=100}if(id==='date')el.type='date';
 label.append(el);$('inputs').append(label);
}
async function call(name,v){try{return await desktop.call(name,v)}catch(e){$('notice').textContent=e.message;throw e}}
function renderConnection(s) {
 const p=s.protocol||{phase:'idle',count:0};const backendBusy=!['idle','saved','failed'].includes(s.backend?.phase||'idle');const busy=['starting','recording','saving','stopped'].includes(p.phase)||backendBusy;
 const missing=s.missingRules||[];const pending=s.tasks.filter(t=>t.status==='待处理').length;
 $('connectionStatus').textContent='已确认 /chat/completion 的消息关联和多段正文结构。下面保留原脱敏协议采集工具；新版后台测试使用上方入口。现有 '+pending+' 条待处理任务保持不变。';
 $('legacyStatus').textContent=missing.length?'原网页模式尚缺 '+missing.length+' 项定位规则。协议采集不需要这些规则。':'原网页模式已保存规则，仍需实际生成验证。';
 $('startProtocol').disabled=busy;$('stopProtocol').disabled=p.phase!=='recording';
 for(let i=1;i<=2;i++){const probe=p.probes?.find(x=>x.id==='probe-'+i),seen=p.probeResponses?.find(x=>x.id==='probe-'+i);$('copyProbe'+i).disabled=p.phase!=='recording'||!probe;$('probe'+i+'Text').textContent=probe?.prompt||'';$('probe'+i+'Status').textContent=seen?.requests.length?(seen.requests.some(r=>r.failed)?'请求失败，请查看网页。':seen.requests.some(r=>r.httpEnded)?'已收到响应，请核对网页回答。':'已捕获发送，正在读取响应。'):'等待手动发送';}
 $('resume').disabled=s.initialization?.phase==='running'||['starting','recording','saving'].includes(p.phase);$('reload').disabled=busy;$('check').disabled=busy;
 const seconds=p.deadline?Math.max(0,Math.ceil((p.deadline-Date.now())/1000)):0;
 const labels={idle:'等待开始校准。请先登录并打开普通测试会话。',starting:'正在启动定向协议采集…',recording:'正在采集：已观察 '+p.count+' 个对话请求，最多还剩 '+seconds+' 秒。请依次手动发送两条测试消息。',saving:'正在结束采集并保存脱敏诊断…',stopped:'正在保存脱敏诊断…',saved:(p.reason==='timeout'?'已达到 180 秒上限并自动保存。':'已保存。')+' 共 '+p.count+' 个对话请求。后台生成仍待适配。',failed:p.error||'采集失败，请重试。'};
 $('protocolStatus').textContent=labels[p.phase]||'';
 $('protocolPath').textContent=p.file?'诊断文件：'+p.file:'';
}
function renderBackend(s){
 const b=s.backend||{phase:'idle'},active=!['idle','saved','failed'].includes(b.phase),protocolBusy=['starting','recording','saving','stopped'].includes(s.protocol?.phase);
 const labels={idle:'待测试：请先在右侧登录豆包。',starting:'正在安装仅驻留内存的校准工具…',observing:'等待三轮手动校准，请依次发送并等待回答结束。',ready:'可以测试：手动校准通过，点击「验证后台连接」。',testing:'正在后台发送并读取一条测试消息，请勿重复发送。',generating:'正在读取当前后台任务，请勿手动发送消息或切换会话。',passed:b.verified?'后台连接已验证。可以加入任务并点击「启动 / 继续后台队列」，请保持连接。':'回答校准通过，但实际请求的新签名尚未验证。',blocked:'已停止：'+(b.reason||'校准条件未满足。'),saved:b.verified?'报告已保存：本次后台连接验证通过。':'报告已保存：本次后台连接尚未通过验证。',failed:b.reason||'测试启动失败。'};
 $('backendStatus').textContent=labels[b.phase]||b.reason||'';if(b.readHealth&&b.phase!=='blocked')$('backendStatus').textContent='后台状态读取暂时失败（'+b.readHealth.code+'），正在重读原任务，不会重新发送。';
 if(b.phase==='ready'&&b.cursorEvidence?.mode==='observed-reuse-experiment')$('backendStatus').textContent='可以尝试一次：序号变化无法推导，将沿用最近一次成功请求的原始序号发送新的合成消息。服务器可能拒绝；点击后仅发送一次，失败不重试，业务队列保持暂停。';
 if(b.reason&&b.phase==='saved')$('backendStatus').textContent+=' '+b.reason;
 if(b.phase==='saved'&&b.cleanupConfirmed===false)$('backendStatus').textContent+=' 网页未及时确认清理，请关闭程序后再重新打开。';
 $('startBackend').disabled=active||protocolBusy;$('stopBackend').disabled=!active||b.phase==='starting';$('testBackend').disabled=b.phase!=='ready'||protocolBusy;
 for(let i=1;i<=3;i++){const p=b.probes?.find(p=>p.id==='probe-'+i);$('copyBackend'+i).disabled=b.phase!=='observing'||!p||p.seen||(i>1&&!b.probes?.[i-2]?.complete);$('backendProbe'+i).textContent=p?.complete&&p?.exact?'回答校准通过':p?.parserError?'校验停止：'+p.parserError:p?.seen?'已观察到请求，等待完整回答。':'等待手动发送';}
 const signature={fresh:'新签名已确认',reused:'检测到旧签名，未通过',missing:'未观察到所需签名',duplicate:'检测到重复请求，未通过','not-observed':'尚无后台请求证据'};
 $('backendTest').textContent=b.test?.sent?'后台测试：'+(b.test.complete&&b.test.exact?'正文校准通过':'尚未通过完整回答校验')+'；'+(signature[b.signature]||'签名未确认')+'。':'尚未发送后台测试。';
 $('backendPath').textContent=b.file?'报告文件：'+b.file:'';if(s.initialization?.phase==='running'||s.initialization?.phase==='attention')$('backendStatus').textContent=s.initialization.message;
}
function render(s) {
 state=s;renderLive(s);document.body.classList.toggle('browser-visible',!!s.browserVisible);$('toggleBrowser').textContent=s.browserVisible?'隐藏豆包':'登录 / 显示豆包';$('exportDirectory').textContent=s.exportDir||'';if(s.backend?.queueEnabled)$('connectionSetup').open=false;renderMarketingOptions(s);$('appVersion').textContent='v'+s.version;renderConnection(s);renderBackend(s);
 $('reload').textContent=s.browserStatus==='loading'?'正在连接…点击重试':'重新打开豆包';
 if(!$('fields').children.length)for(const path of s.paths){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=path;label.append(box,document.createTextNode(path));$('fields').append(label)}
 if(document.activeElement!==$('rules'))$('rules').value=JSON.stringify(s.rules,null,2);
 $('notice').textContent=s.initialization?.phase==='attention'?'初始化未完成：'+s.initialization.message:s.initialization?.phase==='running'?s.initialization.message:(s.paused?'队列已暂停。':'队列运行中。')+(s.browserError||'');
 $('location').textContent='本地数据与登录状态：'+s.dataDir;
 $('tasks').replaceChildren();
 for(const t of s.tasks){const row=document.createElement('div');row.className='task'+(selectedId===t.id?' active':'');const badge=document.createElement('strong'),title=document.createElement('div'),detail=document.createElement('div');badge.className='task-badge';badge.textContent=t.status+(t.status==='生成中'?' · 已接收 '+(t.raw||'').length+' 字符':'');row.dataset.status=t.status;title.textContent=t.input.refTitle;detail.textContent=t.error||(t.repairAttempt&&t.status!=='已完成'?'正在自动修复格式，仅一次':'');row.append(badge,title,detail);const cancel=document.createElement('button');cancel.textContent='取消';cancel.disabled=['已完成','已取消'].includes(t.status);cancel.onclick=e=>{e.stopPropagation();call('cancel',t.id)};row.onclick=()=>{selectedId=t.id;$('result').value=t.content?JSON.stringify(t.content,null,2):'';render(state)};row.append(cancel);$('tasks').append(row)}
 const t=s.tasks.find(t=>t.id===selectedId)||s.tasks.find(t=>t.status==='生成中');$('stream').textContent=t?.raw||'';
 $('generatedItems').replaceChildren();for(const item of t?.content?.items||[]){const card=document.createElement('section'),title=document.createElement('h3'),text=document.createElement('textarea'),copy=document.createElement('button');title.textContent=s.promptOptions?.find(p=>p[0]===item.id)?.[1]||item.id;text.value=item.text;text.readOnly=true;text.rows=4;copy.textContent='复制内容';copy.onclick=()=>call('copyGenerated',{taskId:t.id,itemId:item.id});card.append(title,text,copy);$('generatedItems').append(card)}

 $('exports').replaceChildren();for(const e of s.exports){const p=document.createElement('p');p.textContent=e.at+' · '+e.file+' · '+e.bytes+' bytes';$('exports').append(p)}
}
window.addEventListener('unhandledrejection',event=>{$('notice').textContent=event.reason?.message||String(event.reason)});
desktop.onState(render);call('state');
function marketingValues(){return {input:Object.fromEntries(Object.keys(names).map(id=>[id,$(id).value.trim()])),options:[...$('marketingOptions').querySelectorAll('input:checked')].map(e=>e.value),focus:[...$('marketingFocus').querySelectorAll('input:checked')].map(e=>e.value),seoInfo:$('seoInfo').value,sourceUrl:$('includeSource').checked?$('sourceUrl').value:''}}
$('add').onclick=async()=>{const kind=$('generationKind').value,selected=kind==='marketing'?[]:[...$('fields').querySelectorAll('input:checked')].map(e=>e.value);const base=selected.length?JSON.parse($('result').value):null;selectedId=await call('add',{...marketingValues(),kind,selected,base,prompt:$('prompt').value,network:$('network').checked,autoStart:true});call('state')};
for(const id of ['pause','reload','openExports','startProtocol','stopProtocol','startBackend','testBackend','stopBackend'])$(id).onclick=()=>call(id);
for(let i=1;i<=3;i++)$('copyBackend'+i).onclick=async()=>{$('notice').textContent=await call('copyBackendProbe','probe-'+i)};
for(let i=1;i<=2;i++)$('copyProbe'+i).onclick=async()=>{$('notice').textContent=await call('copyProbe','probe-'+i)};
$('saveRules').onclick=()=>call('rules',$('rules').value);
$('check').onclick=async()=>{$('notice').textContent=await call('check',$('network').checked)};
$('save').onclick=()=>call('edit',{id:selectedId,json:$('result').value});
$('jumpRules').onclick=()=>{$('ruleSettings').open=true;$('ruleSettings').scrollIntoView({behavior:'smooth'})};
$('diagnostics').onclick=async()=>{const file=await call('diagnostics');$('diagnosticPath').textContent='诊断文件已保存：'+file};
setInterval(()=>{if(state)renderLive(state);if(state?.protocol?.phase==='recording')renderConnection(state)},1000);

$('resume').onclick=()=>call('resumeBackend');

$('revalidate').onclick=async()=>{await call('revalidate',selectedId);const t=state.tasks.find(t=>t.id===selectedId);if(t?.content)$('result').value=JSON.stringify(t.content,null,2)};

function renderMarketingOptions(s){
 if($('marketingOptions').children.length)return;
 for(const [id,title] of s.promptOptions||[]){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=id;box.checked=true;box.onchange=()=>{const boxes=[...$('marketingOptions').querySelectorAll('input')];$('promptAll').checked=boxes.every(b=>b.checked);$('promptAll').indeterminate=boxes.some(b=>b.checked)&&!$('promptAll').checked};label.append(box,document.createTextNode(title));$('marketingOptions').append(label)}
 for(const [id,title] of s.promptFocusOptions||[]){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=id;label.append(box,document.createTextNode('着重体现：'+title));$('marketingFocus').append(label)}
}
$('promptAll').onchange=()=>{$('marketingOptions').querySelectorAll('input').forEach(e=>e.checked=$('promptAll').checked)};
$('includeSource').onchange=()=>{$('sourceUrl').disabled=!$('includeSource').checked};
$('generationKind').onchange=()=>{const marketing=$('generationKind').value==='marketing';$('marketingBuilder').hidden=!marketing;$('fieldSelection').hidden=marketing;$('prompt').value=marketing?'仅生成勾选内容，遵守所选项目规则，不虚构事实。':'根据真实输入生成可导入 Shopify 的英文页面及首页与 SEO 文案。遵守现有字段结构和规则，不虚构事实。'};
$('copyMarketing').onclick=async()=>{$('marketingPromptPreview').textContent=await call('copyMarketingPrompt',marketingValues());$('notice').textContent='提示词已在本地生成并复制。'};
$('chooseExportDir').onclick=()=>call('chooseExportDir');
$('toggleBrowser').onclick=()=>{if(!state.browserVisible)$('connectionSetup').open=true;call('toggleBrowser')};

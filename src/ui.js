const $=id=>document.getElementById(id);
let state,selectedId;
const names={brand:'品牌名称（选填，仅 SEO）',email:'联系邮箱（选填）',website:'网站地址（选填）',refTitle:'参考网站描述 · 标题',refBody:'参考网站描述 · 内容',discount:'最高折扣 % OFF',date:'文案日期（选填）',details:'产品与服务补充（选填）'};
for(const [id,title] of Object.entries(names)) {
 const label=document.createElement('label');label.textContent=title;
 const el=document.createElement(['refBody','details'].includes(id)?'textarea':'input');el.id=id;
 if(id==='discount'){el.type='number';el.min=1;el.max=100}if(id==='date')el.type='date';
 label.append(el);$('inputs').append(label);
}
async function call(name,v){try{return await desktop.call(name,v)}catch(e){$('notice').textContent=e.message;throw e}}
function renderConnection(s) {
 const p=s.protocol||{phase:'idle',count:0};const busy=['starting','recording','saving','stopped'].includes(p.phase);
 const missing=s.missingRules||[];const pending=s.tasks.filter(t=>t.status==='待处理').length;
 $('connectionStatus').textContent='后台直连尚未接通。已确认 /chat/completion 使用 SSE，需要下面两条校准消息补齐适配证据。现有 '+pending+' 条待处理任务保持不变。';
 $('legacyStatus').textContent=missing.length?'原网页模式尚缺 '+missing.length+' 项定位规则。协议采集不需要这些规则。':'原网页模式已保存规则，仍需实际生成验证。';
 $('startProtocol').disabled=busy;$('stopProtocol').disabled=p.phase!=='recording';
 for(let i=1;i<=2;i++){const probe=p.probes?.find(x=>x.id==='probe-'+i),seen=p.probeResponses?.find(x=>x.id==='probe-'+i);$('copyProbe'+i).disabled=p.phase!=='recording'||!probe;$('probe'+i+'Text').textContent=probe?.prompt||'';$('probe'+i+'Status').textContent=seen?.requests.length?(seen.requests.some(r=>r.failed)?'请求失败，请查看网页。':seen.requests.some(r=>r.httpEnded)?'已收到响应，请核对网页回答。':'已捕获发送，正在读取响应。'):'等待手动发送';}
 $('resume').disabled=missing.length>0||busy;$('reload').disabled=busy;
 const seconds=p.deadline?Math.max(0,Math.ceil((p.deadline-Date.now())/1000)):0;
 const labels={idle:'等待开始校准。请先登录并打开普通测试会话。',starting:'正在启动定向协议采集…',recording:'正在采集：已观察 '+p.count+' 个对话请求，最多还剩 '+seconds+' 秒。请依次手动发送两条测试消息。',saving:'正在结束采集并保存脱敏诊断…',stopped:'正在保存脱敏诊断…',saved:(p.reason==='timeout'?'已达到 180 秒上限并自动保存。':'已保存。')+' 共 '+p.count+' 个对话请求。后台生成仍待适配。',failed:p.error||'采集失败，请重试。'};
 $('protocolStatus').textContent=labels[p.phase]||'';
 $('protocolPath').textContent=p.file?'诊断文件：'+p.file:'';
}
function render(s) {
 state=s;$('appVersion').textContent='v'+s.version;renderConnection(s);
 $('reload').textContent=s.browserStatus==='loading'?'正在连接…点击重试':'重新打开豆包';
 if(!$('fields').children.length)for(const path of s.paths){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=path;label.append(box,document.createTextNode(path));$('fields').append(label)}
 if(document.activeElement!==$('rules'))$('rules').value=JSON.stringify(s.rules,null,2);
 $('notice').textContent=(s.paused?'队列已暂停。':'队列运行中。')+(s.browserError||'');
 $('location').textContent='本地数据与登录状态：'+s.dataDir;
 $('tasks').replaceChildren();
 for(const t of s.tasks){const row=document.createElement('div');row.className='task'+(selectedId===t.id?' active':'');row.textContent=t.input.refTitle+' · '+t.status+(t.error?' · '+t.error:'');const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=e=>{e.stopPropagation();call('cancel',t.id)};row.onclick=()=>{selectedId=t.id;$('result').value=t.content?JSON.stringify(t.content,null,2):'';render(state)};row.append(cancel);$('tasks').append(row)}
 const t=s.tasks.find(t=>t.id===selectedId)||s.tasks.find(t=>t.status==='生成中');$('stream').textContent=t?.raw||'';
 $('exports').replaceChildren();for(const e of s.exports){const p=document.createElement('p');p.textContent=e.at+' · '+e.file+' · '+e.bytes+' bytes';$('exports').append(p)}
}
window.addEventListener('unhandledrejection',event=>{$('notice').textContent=event.reason?.message||String(event.reason)});
desktop.onState(render);call('state');
$('add').onclick=async()=>{const selected=[...$('fields').querySelectorAll('input:checked')].map(e=>e.value);const base=selected.length?JSON.parse($('result').value):null;selectedId=await call('add',{input:Object.fromEntries(Object.keys(names).map(id=>[id,$(id).value.trim()])),selected,base,prompt:$('prompt').value,network:$('network').checked});call('state')};
for(const id of ['pause','resume','reload','openExports','startProtocol','stopProtocol'])$(id).onclick=()=>call(id);
for(let i=1;i<=2;i++)$('copyProbe'+i).onclick=async()=>{$('notice').textContent=await call('copyProbe','probe-'+i)};
$('saveRules').onclick=()=>call('rules',$('rules').value);
$('check').onclick=async()=>{$('notice').textContent=await call('check',$('network').checked)};
$('save').onclick=()=>call('edit',{id:selectedId,json:$('result').value});
$('jumpRules').onclick=()=>{$('ruleSettings').open=true;$('ruleSettings').scrollIntoView({behavior:'smooth'})};
$('diagnostics').onclick=async()=>{const file=await call('diagnostics');$('diagnosticPath').textContent='诊断文件已保存：'+file};
setInterval(()=>{if(state?.protocol?.phase==='recording')renderConnection(state)},1000);

// User-triggered, structural DOM evidence only. No message bodies, input values,
// account names, cookies, storage, URLs containing session IDs, or screenshots.
function collectStructure(){
 const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const signature=e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),testId:e.getAttribute('data-testid'),classes:typeof e.className==='string'?e.className.slice(0,300):'',editable:e.getAttribute('contenteditable')});
 const ancestors=e=>{const result=[];for(let i=0;e&&i<5;i++,e=e.parentElement)result.push(signature(e));return result};
 const inputs=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible).slice(0,10).map(e=>({element:signature(e),parents:ancestors(e.parentElement)}));
 const controls=[...document.querySelectorAll('button,[role="button"]')].filter(visible).map(e=>({element:e,label:(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim()})).filter(x=>x.label.length<=24&&/^(发送|停止|停止生成|新对话|联网搜索|搜索|继续生成|重新生成|展开|收起|Send|Stop|Search)$/i.test(x.label)).slice(0,30).map(x=>({element:signature(x.element),label:x.label,parents:ancestors(x.element.parentElement)}));
 const messageCandidates=[...document.querySelectorAll('[data-testid],[data-role]')].filter(e=>/(message|answer|assistant|chat[-_]item)/i.test(e.getAttribute('data-testid')||e.getAttribute('data-role')||'')).slice(0,80).map(signature);
 return {hostname:location.hostname,inputs,controls,messageCandidates};
}
module.exports={collectStructure};

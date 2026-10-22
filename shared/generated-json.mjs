// Parse JSON without silently discarding duplicate properties. The only repair
// permitted is repeated, complete page triplets inside the pages array.
export function parseGeneratedJson(raw){
 const text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 let i=0,repairs=0;const expanded=Symbol('page triplets');
 const fail=message=>{throw Error(message+'（位置 '+i+'）')};
 const space=()=>{while(/\s/.test(text[i]||'')&&i<text.length)i++};
 function string(){const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue}if(text[i++]==='"'){try{return JSON.parse(text.slice(start,i))}catch{fail('JSON 字符串无效')}}}fail('JSON 字符串未结束')}
 function value(path,depth=0){
  if(depth>80)fail('JSON 嵌套过深');space();
  if(text[i]==='"')return string();
  if(text[i]==='{'){
   i++;space();const entries=[];
   if(text[i]!=='}')while(true){space();if(text[i]!=='"')fail('JSON 对象键必须是字符串');const key=string();space();if(text[i++]!==':')fail('缺少冒号');entries.push([key,value(path+'.'+key,depth+1)]);space();if(text[i]!==',')break;i++}
   if(text[i++]!=='}')fail('JSON 对象未结束');
   if(new Set(entries.map(([key])=>key)).size!==entries.length){
    const triplet=['handle','title','body_html'];
    if(/^\$\.pages\[\d+\]$/.test(path)&&entries.length>3&&entries.length%3===0&&entries.every(([key,v],n)=>key===triplet[n%3]&&typeof v==='string')){
     const pages=[];for(let n=0;n<entries.length;n+=3)pages.push(Object.fromEntries(entries.slice(n,n+3)));
     if(new Set(pages.map(p=>p.handle)).size!==pages.length)fail('重复页面 handle，不能确定内容');repairs++;return {[expanded]:pages};
    }
    fail('JSON 含重复字段 '+path+'；请将每个页面放入单独对象，禁止重复键');
   }
   return Object.fromEntries(entries);
  }
  if(text[i]==='['){
   i++;space();const out=[];let n=0;
   if(text[i]!==']')while(true){const v=value(path+'['+n+++']',depth+1);if(v?.[expanded]){if(path!=='$.pages')fail('无效页面位置');out.push(...v[expanded])}else out.push(v);space();if(text[i]!==',')break;i++}
   if(text[i++]!==']')fail('JSON 数组未结束');return out;
  }
  const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
  if(!match)fail('JSON 值无效');i+=match[0].length;return JSON.parse(match[0]);
 }
 const result=value('$');space();if(i!==text.length)fail('JSON 结尾有多余内容');return {value:result,repairs};
}

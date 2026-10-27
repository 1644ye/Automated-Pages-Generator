'use strict';
const {lookup}=require('node:dns/promises');
const {isIP}=require('node:net');
function publicAddress(address){
 if(isIP(address)===6)return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(?:0:|db8:)/i.test(address);
 const p=address.split('.').map(Number);return isIP(address)===4&&p[0]!==0&&p[0]!==10&&p[0]!==127&&p[0]<224&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&p[1]===168)&&!(p[0]===100&&p[1]>=64&&p[1]<=127);
}
async function checkedUrl(value,resolver=lookup){
 let u;try{u=new URL(value)}catch{throw Error('请输入完整的 https:// 网页地址')}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))throw Error('仅支持无账号密码的公开 HTTP/HTTPS 网页');
 const host=u.hostname.replace(/^\[|\]$/g,'');
 if(host==='localhost'||host.endsWith('.local')||host.endsWith('.localhost'))throw Error('不读取本机或内网地址');
 const records=isIP(host)?[{address:host}]:await resolver(host,{all:true});
 if(!records.length||records.some(r=>!publicAddress(r.address)))throw Error('不读取本机或内网地址');
 u.hash='';return u.href;
}
function decode(s){return s.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff?String.fromCodePoint(c):' '}).replace(/&(amp|quot|apos|nbsp|lt|gt);/gi,(_,n)=>({amp:'&',quot:'"',apos:"'",nbsp:' ',lt:'<',gt:'>'}[n.toLowerCase()])).replace(/\s+/g,' ').trim()}
function extractPage(html,url){
 const clean=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
 let title=decode(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||''),description='';
 for(const tag of clean.match(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)||[]){
  const attrs={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]);
  const key=(attrs.name||attrs.property||'').toLowerCase();if(key==='description')description=attrs.content||description;else if(key==='og:description'&&!description)description=attrs.content||'';if(key==='og:title'&&!title)title=attrs.content||'';
 }
 const body=clean.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]||clean;
 const text=decode(body.replace(/<[^>]*>/g,' ')).slice(0,12000);
 if(text.length<80&&description.length<30)throw Error('网页可读取信息过少，可能需要登录、验证码或由 JavaScript 加载；请手动填写参考信息');
 return {url,title:title.slice(0,500),description:description.slice(0,2000),text,readAt:new Date().toISOString()};
}
async function readSource(value,fetcher,resolver=lookup){
 let url=value;const signal=AbortSignal.timeout(25000);
 for(let i=0;i<5;i++){
  url=await checkedUrl(url,resolver);const r=await fetcher(url,{redirect:'manual',credentials:'omit',signal});
  if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();const location=r.headers.get('location');if(!location)throw Error('网页重定向没有目标');url=new URL(location,url).href;continue}
  if(!r.ok)throw Error('网页读取失败：HTTP '+r.status+'；不会绕过登录或验证码');
  if(!/text\/html|application\/xhtml\+xml/i.test(r.headers.get('content-type')||'')){await r.body?.cancel();throw Error('网址没有返回 HTML 网页')}
  let bytes=0;const chunks=[];for await(const chunk of r.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('网页超过2MB读取上限');chunks.push(Buffer.from(chunk))}
  const html=Buffer.concat(chunks).toString('utf8');if(/<title[^>]*>[^<]*(?:just a moment|access denied|captcha)/i.test(html))throw Error('网页要求验证，请手动处理；未生成SEO');
  return extractPage(html,url);
 }
 throw Error('网页重定向次数过多');
}
module.exports={readSource,extractPage,checkedUrl,publicAddress};

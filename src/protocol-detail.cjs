'use strict';

// Protocol names are metadata, not payload values. This is a bounded lexical
// filter, not a claim that every simple alphabetic map key is non-personal.
function safeProtocolName(name) {
 if(typeof name!=='string'||!name||name.length>64)return null;
 if(/^\d{1,6}$/.test(name))return name; // Short SSE event codes.
 if(!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name))return null;
 if(/^[0-9a-f]{12,}$/i.test(name)||/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name))return null;
 if(/^(?:sk-|gh[pousr]_|github_pat_|bearer[_.:-])/i.test(name))return null;
 if(/[A-Za-z]/.test(name)&&/\d{3,}/.test(name))return null;
 // Opaque mixed-case/base64-like keys should not survive as field names.
 if(name.length>32&&!/[_.:-]/.test(name)&&/[a-z]/.test(name)&&/[A-Z]/.test(name))return null;
 if(name.length>20&&!/[_.:-]/.test(name)&&/[A-Za-z]/.test(name)&&/\d/.test(name))return null;
 return name;
}

const ID_NAME=/^(?:id|uuid)$|(?:_id|_uuid)$|(?:Id|ID|Uuid|UUID)$/;
const SECRET_NAME=/(?:^|[_-])(?:password|passwd|secret|token|cookie|cookies|authorization|signature|nonce)(?:$|[_-])/i;
const CONTROL_NAMES=new Set(['content_type','block_type','status','code','type','event_type','is_finish','is_end','is_final','is_complete','done','finished','completed','finish_reason','stop_reason','operation','op','action','role']);
const CONTROL_WORDS=new Set(['true','false','0','1','yes','no','start','stop','end','done','finish','finished','complete','completed','success','failed','failure','error','pending','running','in_progress','delta','append','replace','remove','add','text','message','assistant','user','system','tool','end_turn','length','content_filter','tool_calls','function_call','max_tokens','stop_sequence']);
const PATH_NAME=/(?:^|_)path$|(?:^|_)pointer$|(?:Path|Pointer)$/;

function limit(value,fallback,min,max){return Number.isSafeInteger(value)?Math.max(min,Math.min(max,value)):fallback}
function clone(value){return JSON.parse(JSON.stringify(value))}
function safeChannel(value){return typeof value==='string'&&/^(?:request|response|stream|test)-\d{1,6}$/.test(value)?value:'channel'}
function idKind(value){const text=String(value);if(!text)return 'empty';if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text))return 'uuid';if(/^\d+$/.test(text))return 'digits';if(/^[0-9a-f]+$/i.test(text))return 'hex';return 'opaque'}

class ProtocolEvidence {
 constructor(options={}) {
  this.probes=[];
  for(const probe of Array.isArray(options.probes)?options.probes.slice(0,8):[]) {
   if(typeof probe?.marker==='string'&&probe.marker.length>=8&&probe.marker.length<=256&&typeof probe.id==='string'&&/^probe-\d{1,2}$/.test(probe.id))this.probes.push({id:probe.id,marker:probe.marker});
  }
  this.maxIds=limit(options.maxIds,256,1,2048);this.maxNames=limit(options.maxNames,256,1,1024);
  this.maxTextPaths=limit(options.maxTextPaths,128,1,512);this.maxTextBytes=limit(options.maxTextBytes,65536,128,262144);
  this.maxTimeline=limit(options.maxTimeline,1000,1,2000);this.maxTimelineBytes=limit(options.maxTimelineBytes,2*1024*1024,128,8*1024*1024);
  this.ids=new Map();this.names=new Map();this.texts=new Map();this.observedNames=new Set();this.timeline=[];this.timelineSizes=[];
  this.timelineBytes=0;this.sequence=0;this.truncated=false;this.droppedFrames=0;this.disposed=false;
 }
 name(raw,{key=false}={}) {
  const safe=safeProtocolName(raw);
  // Numeric object keys are often account/message IDs; numeric SSE events are allowed.
  if(safe&&!(key&&/^\d+$/.test(safe)))return safe;
  if(typeof raw!=='string'||raw.length>256){this.truncated=true;return '[redacted]'}
  if(!this.names.has(raw)) {
   if(this.names.size>=this.maxNames){this.truncated=true;return '[redacted]'}
   this.names.set(raw,'key'+(this.names.size+1));
  }
  return '['+this.names.get(raw)+']';
 }
 identifier(value) {
  const kind=idKind(value);if(kind==='empty')return {kind};
  if(typeof value==='number'&&!Number.isSafeInteger(value))return {kind:'unsafe-number',redacted:true};
  const raw=typeof value+':'+String(value);
  if(raw.length>264){this.truncated=true;return {kind:'oversize',redacted:true}}
  if(!this.ids.has(raw)) {
   if(this.ids.size>=this.maxIds){this.truncated=true;return {kind,redacted:true}}
   this.ids.set(raw,'id'+(this.ids.size+1));
  }
  return {alias:this.ids.get(raw),kind};
 }
 matches(text) {
  const matches=[];
  for(const probe of this.probes)if(text.includes(probe.marker))matches.push({probe:probe.id,match:text===probe.marker?'exact':'contains'});
  return matches;
 }
 protocolPath(path,value) {
  const observation={path,kind:'protocol-path',format:value.startsWith('/')?'json-pointer':value.startsWith('$')?'json-path':'unrecognized',validated:false};
  if(observation.format==='unrecognized'||value.length>512)return observation;
  let rawSegments=[];
  if(observation.format==='json-pointer') {
   if(/~(?:[^01]|$)/.test(value))return observation;
   rawSegments=value.slice(1).split('/').map(segment=>segment.replace(/~1/g,'/').replace(/~0/g,'~'));
  }else {
   let rest=value.slice(1);
   while(rest) {
    const match=/^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d{1,3})\]|\["([A-Za-z_][A-Za-z0-9_.:-]*)"\]|\['([A-Za-z_][A-Za-z0-9_.:-]*)'\])/.exec(rest);
    if(!match)return observation;
    rawSegments.push(match[1]??match[2]??match[3]??match[4]);rest=rest.slice(match[0].length);
    if(rawSegments.length>16)return observation;
   }
  }
  if(rawSegments.length>16)return observation;
  const segments=[];
  for(const raw of rawSegments) {
   if(/^\d{1,3}$/.test(raw)&&Number(raw)<=255){segments.push({index:Number(raw)});continue}
   if(safeProtocolName(raw)!==raw||!this.observedNames.has(raw)||['__proto__','constructor','prototype'].includes(raw))return observation;
   segments.push({field:raw});
  }
  return {...observation,validated:true,segments};
 }
 text(path,value,channel) {
  const observation={path,kind:'text',characters:[...value].length,matches:this.matches(value)};
  const key=channel+'\0'+path,prior=this.texts.get(key);
  observation.relation=!prior?'first':value===prior.previous?'same':value.startsWith(prior.previous)?'extends':'changed';
  if(!prior&&this.texts.size>=this.maxTextPaths){this.truncated=true;observation.historyTruncated=true;return observation}
  // Do not retain a giant string just to diagnose incremental behaviour.
  if(Buffer.byteLength(value)>this.maxTextBytes){this.texts.delete(key);this.truncated=true;observation.historyTruncated=true;return observation}
  const combined=(prior?.combined||'')+value;
  const tooLarge=Buffer.byteLength(combined)>this.maxTextBytes;
  // Probe matching needs only a small suffix after the cumulative budget. Keep
  // bounds explicit so a partial suffix is never described as an exact total.
  if(tooLarge||prior?.historyTruncated) {
   observation.historyTruncated=true;this.truncated=true;
   const suffixLength=Math.max(1,...this.probes.map(p=>p.marker.length))-1;
   observation.accumulatedMatches=this.matches(combined).map(m=>({...m,match:'contains'}));
   this.texts.set(key,{previous:value,combined:suffixLength?combined.slice(-suffixLength):'',historyTruncated:true});
  }else {
   observation.accumulatedMatches=this.matches(combined);
   this.texts.set(key,{previous:value,combined,historyTruncated:false});
  }
  return observation;
 }
 inspect(input,options={}) {
  if(this.disposed)return {format:'disposed',fields:[],truncated:true,observations:[]};
  const maxBytes=limit(options.maxBytes,128*1024,128,1024*1024);
  let value=input;
  if(typeof input==='string') {
   if(Buffer.byteLength(input)>maxBytes)return {format:'oversize',fields:[],truncated:true,observations:[]};
   try{value=JSON.parse(input)}catch{return {format:'non-json',fields:[],truncated:false,observations:[]}}
  }
  const fields=[],observations=[],fieldKeys=new Set(),seen=new WeakSet(),pendingPaths=[];
  const maxNodes=limit(options.maxNodes,384,1,1024),maxDepth=limit(options.maxDepth,12,1,16),maxArray=limit(options.maxArray,16,1,50);
  const channel=safeChannel(options.channel);let nodes=0,truncated=false;
  const addObservation=entry=>{if(observations.length<192)observations.push(entry);else truncated=true};
  const visit=(current,schemaPath,actualPath,depth,rawName='',encodedDepth=0)=>{
   if(nodes++>=maxNodes){truncated=true;return}
   const type=current===null?'null':Array.isArray(current)?'array':typeof current;
   const safeType=['null','array','object','string','number','boolean'].includes(type)?type:'unknown';
   const signature=schemaPath+':'+safeType;
   if(!fieldKeys.has(signature)){fieldKeys.add(signature);fields.push({path:schemaPath,type:safeType})}
   if(typeof current==='string'||typeof current==='number') {
    const secret=SECRET_NAME.test(rawName)||/(?:Token|Secret|Password|Cookie|Signature)$/.test(rawName);
    if(ID_NAME.test(rawName)){addObservation({path:actualPath,kind:'identifier',...this.identifier(current)});return}
    if(secret)return;
    if(typeof current==='string'&&PATH_NAME.test(rawName)) {
     if(pendingPaths.length<64&&current.length<=512)pendingPaths.push({path:actualPath,value:current});
     else addObservation({path:actualPath,kind:'protocol-path',format:'unrecognized',validated:false});
    }
    else if(CONTROL_NAMES.has(rawName)) {
     if(typeof current==='number'&&Number.isSafeInteger(current)&&Math.abs(current)<=65535)addObservation({path:actualPath,kind:'control',value:current,representation:'number'});
     else if(typeof current==='string'&&CONTROL_WORDS.has(current.toLowerCase()))addObservation({path:actualPath,kind:'control',value:current,representation:'string'});
    }else if(typeof current==='string')addObservation(this.text(actualPath,current,channel));
    if(typeof current==='string'&&encodedDepth<2&&depth<maxDepth&&Buffer.byteLength(current)<=16384&&/^\s*[\[{]/.test(current)) {
     let decoded;try{decoded=JSON.parse(current)}catch{}
     if(decoded&&typeof decoded==='object') {
      addObservation({path:actualPath,kind:'encoded-json',format:Array.isArray(decoded)?'array':'object',layer:encodedDepth+1});
      visit(decoded,schemaPath+'::<json>',actualPath+'::<json>',depth+1,'',encodedDepth+1);
     }
    }
    return;
   }
   if(typeof current==='boolean'){addObservation({path:actualPath,kind:CONTROL_NAMES.has(rawName)?'control':'boolean',value:current,representation:'boolean'});return}
   if(!current||typeof current!=='object')return;
   if(depth>=maxDepth||seen.has(current)){truncated=true;return}seen.add(current);
   if(Array.isArray(current)) {
    if(current.length>maxArray)truncated=true;
    for(let i=0;i<Math.min(current.length,maxArray);i++){if(nodes>=maxNodes){truncated=true;break}const d=Object.getOwnPropertyDescriptor(current,String(i));visit(d&&'value'in d?d.value:undefined,schemaPath+'[*]',actualPath+'['+i+']',depth+1,rawName,encodedDepth)}
   }else {
    const keys=Object.keys(current);if(keys.length>64)truncated=true;
    for(const raw of keys.slice(0,64)){if(nodes>=maxNodes){truncated=true;break}const safe=this.name(raw,{key:true}),d=Object.getOwnPropertyDescriptor(current,raw);if(safe===raw){if(this.observedNames.size<1024)this.observedNames.add(safe);else truncated=true}visit(d&&'value'in d?d.value:undefined,schemaPath+'.'+safe,actualPath+'.'+safe,depth+1,raw,encodedDepth)}
   }
  };
  try{visit(value,'$','$',0)}catch{truncated=true}
  for(const item of pendingPaths)addObservation(this.protocolPath(item.path,item.value));
  this.truncated ||= truncated;
  return {format:'json',fields,truncated,observations};
 }
 record(event,payload,options={}) {
  const detail=payload==='[DONE]'?{format:'sentinel',fields:[],truncated:false,observations:[{path:'$',kind:'control',value:'[DONE]',representation:'sse-sentinel'}]}:this.inspect(payload,options);if(this.disposed)return detail;
  const entry={seq:++this.sequence,channel:safeChannel(options.channel),event:this.name(event),...detail};
  const bytes=Buffer.byteLength(JSON.stringify(entry));
  if(bytes>this.maxTimelineBytes){this.truncated=true;this.droppedFrames++;return detail}
  // Preserve the initial binding frames as well as the latest end frames when
  // bounds are reached. Gaps are explicit through seq and droppedFrames.
  const prefix=Math.min(16,Math.max(0,Math.floor(this.maxTimeline/4)));
  while(this.timeline.length&&(this.timeline.length>=this.maxTimeline||this.timelineBytes+bytes>this.maxTimelineBytes)) {
   const index=this.timeline.length>prefix?prefix:0;
   this.timeline.splice(index,1);this.timelineBytes-=this.timelineSizes.splice(index,1)[0];this.truncated=true;this.droppedFrames++;
  }
  this.timeline.push(entry);this.timelineSizes.push(bytes);this.timelineBytes+=bytes;
  return detail;
 }
 report(){return clone({timeline:this.timeline,truncated:this.truncated,droppedFrames:this.droppedFrames,framesObserved:this.sequence,markerSemantics:'unverified'})}
 toJSON(){return this.report()}
 dispose(){this.ids.clear();this.names.clear();this.texts.clear();this.observedNames.clear();this.probes=[];this.disposed=true}
}

module.exports={safeProtocolName,ProtocolEvidence};

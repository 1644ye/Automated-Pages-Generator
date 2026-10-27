import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';
import{prepareRepair,paths,mergeFields,parseResult,exportXlsx,validateAll}from'../shared/core.mjs';import{CONTRACT}from'../shared/content.mjs';
const fixture=()=>{const x=structuredClone(CONTRACT);for(const p of x.pages)p.body_html='<p>'+('Meaningful product information and customer care guidance. '.repeat(p.handle==='about-us'?450:8))+'</p>';x.marketing.seo=Array.from({length:5},()=>({title:'Test title',description:'Test description'}));x.marketing.hero={title:'Welcome',description:'Daily care',cta:'Explore'};return x};
test('field regeneration preserves unselected edits',()=>{const x=fixture();x.marketing.hero.description='hand edited';const out=mergeFields(x,{'marketing.hero.title':'new'});assert.equal(out.marketing.hero.title,'new');assert.equal(out.marketing.hero.description,'hand edited');assert.deepEqual(out.pages,x.pages);assert.throws(()=>mergeFields(x,{'unknown':'x'}));assert.ok(paths().includes('marketing.seo'))});
test('malformed, incomplete and executable results never pass',()=>{const task={selected:[]};assert.throws(()=>parseResult('{}',task));const x=fixture();x.pages[0].body_html='<script>alert(1)</script>';assert.throws(()=>validateAll(x));assert.throws(()=>parseResult('{"fields":{}}',{selected:['marketing.hero.title'],base:fixture()}))});
test('same revision export is idempotent; edits create separate workbook',async()=>{const dir=await mkdtemp(join(tmpdir(),'apg-test-')),records=[],x=fixture();const a=await exportXlsx(resolve('.'),dir,x,'test',1,records);const b=await exportXlsx(resolve('.'),dir,x,'test',1,records);assert.equal(a.file,b.file);x.marketing.hero.title='changed';const c=await exportXlsx(resolve('.'),dir,x,'test',2,records);assert.notEqual(c.file,a.file);assert.equal((await readFile(a.file)).subarray(0,2).toString(),'PK');console.log('XLSX_TEST_FILE='+a.file)});

test('About Us repair preserves other pages and marketing, retains 3000-word gate',()=>{
 const data=fixture();data.pages[0].body_html='<p>'+('word '.repeat(100))+'</p>';const task={id:'test',selected:[],input:{},raw:JSON.stringify(data)};
 let failure;try{parseResult(task.raw,task)}catch(e){failure=e}assert.match(failure.message,/当前 100/);assert.equal(prepareRepair(task,failure),true);assert.deepEqual(task.repairFields,['pages.about-us.body_html']);
 const response=JSON.stringify({fields:{'pages.about-us.body_html':'<p>'+('word '.repeat(3000))+'</p>'}});const repaired=parseResult(response,task);assert.deepEqual(repaired.pages.slice(1),data.pages.slice(1));assert.deepEqual(repaired.marketing,data.marketing);
 assert.throws(()=>parseResult(JSON.stringify({fields:{'pages.about-us.body_html':'short','marketing.hero.title':'changed'}}),task));
});
test('repair addresses forbidden page content and stops at budget',()=>{
 const data=fixture();data.pages[4].body_html+='<p>free shipping</p>';const task={id:'test',selected:[],input:{},raw:JSON.stringify(data)};let failure;try{parseResult(task.raw,task)}catch(e){failure=e}assert.ok(prepareRepair(task,failure));assert.deepEqual(task.repairFields,['pages.shipping-policy.body_html']);task.repairRound=3;assert.equal(prepareRepair(task,failure),false);
});
test('size chart repair preserves other selected copy',()=>{
 const task={id:'m',kind:'marketing',input:{},options:['home-title','size-chart'],raw:JSON.stringify({items:[{id:'home-title',text:'Keep my title'},{id:'size-chart',text:'<style>bad</style>'}]})};let failure;try{parseResult(task.raw,task)}catch(e){failure=e}assert.ok(prepareRepair(task,failure));const result=parseResult(JSON.stringify({items:[{id:'size-chart',text:'<p>Size details unavailable.</p>'}]}),task);assert.equal(result.items[0].text,'Keep my title');
});
import {wordCount,validateContent,BUSINESS_RULES} from '../shared/content.mjs';
import {makePrompt} from '../shared/core.mjs';
test('visible English words exclude markup, comments, entities and pure numbers',()=>{
 assert.equal(wordCount('<p title="not counted">Hello&nbsp;world don&#39;t well-made 123</p><!-- hidden words --><style>fake words</style>'),4);
 assert.match(BUSINESS_RULES,/4000/);const data=fixture();data.pages[0].body_html='<p>'+('word '.repeat(3000))+'</p>';assert.doesNotThrow(()=>validateContent(data));data.pages[0].body_html='<p>'+('word '.repeat(2999))+'</p>';assert.throws(()=>validateContent(data),/不足 3000/);
});
test('targeted HTML repair avoids JSON escaping and rejects truncated HTML',()=>{
 const task={id:'html',selected:[],input:{},raw:'',draft:fixture()};task.draft.pages[0].body_html='<p>short</p>';assert.ok(prepareRepair(task,Error('About Us 不足 3000 英文单词')));assert.equal(task.repairHtml,true);assert.match(task.request,/4000/);
 const result=parseResult('<p>'+('word '.repeat(3000))+'</p>',task);assert.deepEqual(result.pages.slice(1),fixture().pages.slice(1));assert.throws(()=>parseResult('<p>'+('word '.repeat(3000)),task),/闭合/);
 assert.throws(()=>parseResult('{"fields":',task),/JSON/);assert.equal(task.aboutWordsStale,true);
});
test('URL SEO uses captured page facts in Doubao prompt and validates result lengths',()=>{
 const task={id:'url',kind:'marketing',options:['home-title','home-description'],urlSource:{url:'https://example.com',text:'actual site facts'}};
 assert.match(makePrompt(task),/actual site facts/);assert.doesNotMatch(makePrompt(task),/全球免运费/);
 assert.throws(()=>parseResult(JSON.stringify({items:[{id:'home-title',text:'x'.repeat(71)},{id:'home-description',text:'description'}]}),task),/超过70/);
});
test('URL-only SEO delegates reading to Doubao and stops unsupported access without retries',()=>{
 const task={id:'direct',kind:'marketing',options:['home-title','home-description'],urlSource:{url:'https://chomps.com/',mode:'doubao-url'}};
 const prompt=makePrompt(task);assert.match(prompt,/程序未抓取/);assert.match(prompt,/https:\/\/chomps.com/);assert.match(prompt,/_sourceStatus/);
 let failure;try{parseResult('{"_sourceStatus":"unavailable"}',task)}catch(error){failure=error}assert.match(failure.message,/豆包报告无法读取/);assert.equal(prepareRepair(task,failure),false);
 const out=parseResult(JSON.stringify({items:[{id:'home-title',text:'Title'},{id:'home-description',text:'Description'}]}),task);assert.equal(out.items.length,2);
});

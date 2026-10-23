import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {promptOptions,buildMarketingPrompt,makePrompt,parseResult,validateMarketing,exportMarketingXlsx} from '../shared/core.mjs';
const input={refTitle:'Shoes',refBody:'Comfort footwear',discount:40,details:'No size measurements supplied'};
test('all twelve original choices build local prompt with source and focus; selected tasks need no page base',()=>{
 assert.equal(promptOptions.length,12);const task={id:'test',kind:'marketing',input,options:['home-title','size-chart'],focus:['discount'],sourceUrl:'https://example.com',selected:[]};
 const text=makePrompt(task);assert.match(text,/40% OFF/);assert.match(text,/size-chart/);assert.match(text,/https:\/\/example.com/);assert.match(text,/不得声称/);
 const value={items:[{id:'home-title',text:'Comfort shoes — Up to 40% off'},{id:'size-chart',text:'<p>Size measurements have not been provided.</p>'}]};assert.deepEqual(parseResult(JSON.stringify(value),task),value);
 assert.throws(()=>buildMarketingPrompt(input,[],[]));assert.throws(()=>buildMarketingPrompt(input,['home-title'],[],'','javascript:alert(1)'));
});
test('missing, extra, reordered and unsafe size HTML fail validation',()=>{
 assert.throws(()=>validateMarketing({items:[]},['home-title']));assert.throws(()=>validateMarketing({items:[{id:'product-title',text:'x'}]},['home-title']));
 for(const text of ['<script>x</script>','<p style="color:red">x</p>','<table onclick="x()"></table>','plain text','<img src="x">'])assert.throws(()=>validateMarketing({items:[{id:'size-chart',text}]},['size-chart']));
});
test('marketing workbook uses selected export directory and is idempotent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apg-marketing-')),task={id:'marketing-test',revision:1,options:['home-title']},content={items:[{id:'home-title',text:'Saved edited title'}]},records=[];
 const a=await exportMarketingXlsx(resolve('.'),dir,content,task,records),b=await exportMarketingXlsx(resolve('.'),dir,content,task,records);
 assert.equal(a.file,b.file);assert.ok(a.file.startsWith(dir));assert.equal(records.length,1);assert.equal((await readFile(a.file)).subarray(0,2).toString(),'PK');console.log('MARKETING_XLSX='+a.file);
});

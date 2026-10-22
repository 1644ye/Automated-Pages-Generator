import test from 'node:test';import assert from 'node:assert/strict';
import {parseGeneratedJson} from '../shared/generated-json.mjs';
test('duplicate page triplets are recovered without changing HTML or text',()=>{
 const a={handle:'about-us',title:'About Us',body_html:'<p>Quotes " and slash \\ and Unicode 中文</p>'},b={handle:'terms-of-use',title:'Terms of Use',body_html:'<p>B</p>'};
 const raw='{"pages":[{'+JSON.stringify(a).slice(1,-1)+','+JSON.stringify(b).slice(1,-1)+'}]}';
 const result=parseGeneratedJson(raw);assert.deepEqual(result.value.pages,[a,b]);assert.equal(result.repairs,1);
});
test('ambiguous duplicates and malformed JSON are rejected instead of last-key-wins',()=>{
 for(const raw of ['{"schemaVersion":1,"schemaVersion":2}','{"pages":[{"handle":"a","handle":"b"}]}','{"pages":[{"handle":"a","title":"A","body_html":"x","handle":"a","title":"A","body_html":"y"}]}','{"x":1,}','[1,]','{"x":"unterminated}','{"x":01}','{} trailing'])assert.throws(()=>parseGeneratedJson(raw));
});
test('ordinary JSON values and fenced JSON retain their structure',()=>{
 const value={schemaVersion:1,pages:[],marketing:{hero:{title:'hello'}},n:-1.2e8,yes:true,no:false,nil:null};assert.deepEqual(parseGeneratedJson('```json\n'+JSON.stringify(value)+'\n```').value,value);
});

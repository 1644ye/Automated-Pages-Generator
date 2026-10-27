import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {extractPage,readSource,checkedUrl}=createRequire(import.meta.url)('../src/url-source.cjs');
const resolver=async()=>[{address:'93.184.216.34'}];
test('URL source extracts actual metadata and strips scripts and comments',()=>{
 const result=extractPage('<title>Real &amp; Site</title><meta content="Useful product facts and details for the customer." name="description"><body><!-- hidden --><script>secret()</script><p>Visible products</p></body>','https://example.com/');
 assert.equal(result.title,'Real & Site');assert.match(result.description,/Useful/);assert.equal(result.text,'Visible products');
});
test('public URL reader blocks local addresses and redirected local targets',async()=>{
 for(const url of ['file:///c:/a','http://localhost/','http://127.0.0.1/','http://[::1]/','https://user:pass@example.com'])await assert.rejects(checkedUrl(url,resolver));
 await assert.rejects(readSource('https://example.com',async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}}),resolver),/内网/);
});
test('read errors and non-HTML content never produce source data',async()=>{
 await assert.rejects(readSource('https://example.com',async()=>new Response('blocked',{status:403}),resolver),/403/);
 await assert.rejects(readSource('https://example.com',async()=>new Response('{}',{headers:{'content-type':'application/json'}}),resolver),/HTML/);
 await assert.rejects(readSource('https://example.com',async()=>new Response('<p>Empty</p>',{headers:{'content-type':'text/html'}}),resolver),/信息过少/);
});

import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {nextSeoFill}=createRequire(import.meta.url)('../src/seo-fill.js');
const task=id=>({id,urlSource:{url:'https://example.com'},status:'已完成',content:{items:[{id:'home-title',text:'Generated title'},{id:'home-description',text:'Generated description'}]}});
test('SEO fills title description and URL once, preserving later edits',()=>{
 const done=new Set(),t=task('one'),fill=nextSeoFill([t],done);assert.equal(fill.title,'Generated title');assert.equal(fill.description,'Generated description');assert.equal(fill.url,'https://example.com');done.add(fill.id);assert.equal(nextSeoFill([t],done),null);
});
test('older, pending, failed or partial SEO never overwrites the latest form',()=>{
 const old=task('old'),current=task('new');for(const status of ['待处理','生成中','校验失败','已取消']){current.status=status;assert.equal(nextSeoFill([old,current],new Set()),null)}
 current.status='已完成';current.content.items.pop();assert.equal(nextSeoFill([old,current],new Set()),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const require = createRequire(import.meta.url);
const {createAnswerRuntime} = require('../src/doubao-answer.cjs');
const {AnswerStream} = createAnswerRuntime();

// Invented fixture IDs and numeric controls. These tests are not live Doubao
// tests and do not establish the real site's control-code meanings.
const options = {localMessageId: 'synthetic-local', conversationId: 'synthetic-conversation', botId: 'synthetic-bot', prompt: 'synthetic-prompt', expectedText: 'APG_PROBE_SYNTHETIC_0123456789AB'};
const expected = options.expectedText;
const block = (text, finished = false) => ({block_type: 10000, block_id: 'synthetic-block', content: {text_block: text === undefined ? {} : {text}}, is_finish: finished, patch_type: finished ? 9 : 4});
const patch = value => ({patch_object: 7, patch_type: 8, patch_value: value});
function events(text = expected) {
 return [
  ['SSE_HEARTBEAT', {}],
  ['SSE_ACK', {query_list: [{local_message_id: options.localMessageId, question_id: 'synthetic-question', message_index: 10}], ack_client_meta: {conversation_id: options.conversationId, section_id: 'synthetic-section'}}],
  ['FULL_MSG_NOTIFY', {message: {local_message_id: options.localMessageId, message_id: 'synthetic-question', conversation_id: options.conversationId, section_id: 'synthetic-section', index_in_conv: 10, content: 'this duplicate encoded representation is not appended', content_block: [{block_type: 10000, content: {text_block: {text: options.prompt}}}], ext: {is_finish: '1'}}}],
  ['STREAM_MSG_NOTIFY', {meta: {message_id: 'synthetic-answer', bot_reply_message_id: 'synthetic-question', conversation_id: options.conversationId, section_id: 'synthetic-section', sender_id: options.botId, index_in_conv: 11}, content: {content_block: [block(text.slice(0, 2))]}}],
  ['STREAM_CHUNK', {message_id: 'synthetic-answer', patch_op: [patch({content_block: [block(text.slice(2, 3))]})]}],
  ['STREAM_CHUNK', {message_id: 'synthetic-answer', patch_op: [patch({tts_content: 'not assistant body'})]}],
  ['CHUNK_DELTA', {text: text.slice(3, 15)}],
  ['CHUNK_DELTA', {text: text.slice(15, 21)}],
  ['CHUNK_DELTA', {text: text.slice(21, 27)}],
  ['CHUNK_DELTA', {text: text.slice(27)}],
  ['STREAM_CHUNK', {message_id: 'synthetic-answer', patch_op: [patch({content_block: [block(undefined, true)]})]}],
  ['STREAM_CHUNK', {message_id: 'synthetic-answer', patch_op: [patch({ext: {perf_mark: '{}'}}), patch({ext: {is_finish: '1'}})]}],
  ['SSE_REPLY_END', {end_type: 20, msg_finish_attr: {msgid: 'synthetic-answer', brief: text}}],
  ['SSE_REPLY_END', {end_type: 21, answer_finish_attr: {has_suggest: true}}],
  ['STREAM_CHUNK', {message_id: 'synthetic-answer', patch_op: [patch({ext: {has_suggest: '1', sp_v2: '[{"content":"unrelated suggestion"}]'}})]}],
  ['SSE_REPLY_END', {end_type: 22}],
 ];
}
const sse = values => values.map(([event, value]) => 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n').join('');
function run(values = events(), opts = options) {
 const stream = new AnswerStream(opts); stream.feed(sse(values)); return stream.finish();
}
const calibrated = run();

test('synthetic split body binds ACK, echo and answer; finishes only after HTTP end', () => {
 const stream = new AnswerStream(options);
 const before = stream.feed(sse(events()));
 assert.equal(before.complete, false); assert.equal(before.error, ''); assert.equal(before.text, expected);
 const result = stream.finish();
 assert.equal(result.complete, true); assert.equal(result.error, ''); assert.equal(result.text, expected);
 assert.equal(result.binding.questionMessageIndex, 10); assert.equal(result.binding.answerMessageIndex, 11);
 assert.equal(result.binding.lastMessageIndex, 11);
 assert.ok(Object.values(result.signals).every(Boolean));
 assert.equal(result.profile.tuples.text.length, 1); assert.equal(result.profile.tuples.finish.length, 1);
});

test('factory runs without CommonJS dependencies in browser-like VM and handles byte splits', () => {
 const runtime = runInNewContext('(' + createAnswerRuntime.toString() + ')()', {TextDecoder, TextEncoder, Uint8Array});
 const stream = new runtime.AnswerStream({...options, expectedText: '合成测试✅' + expected});
 const text = '合成测试✅' + expected;
 const bytes = new TextEncoder().encode(sse(events(text)).replaceAll('\n', '\r\n'));
 for (const byte of bytes) stream.feed(new Uint8Array([byte]));
 const result = stream.finish(); assert.equal(result.error, ''); assert.equal(result.complete, true); assert.equal(result.text, text);
});

test('calibrated profile supports different normal body without replacing it with brief', () => {
 const values = events('A body with its own meaningful long contents.');
 values[12][1].msg_finish_attr.brief = 'Summary only';
 const result = run(values, {...options, expectedText: undefined, patchProfile: calibrated.profile});
 assert.equal(result.complete, true); assert.equal(result.text, 'A body with its own meaningful long contents.');
});

test('ordinary responses need a calibration profile; probes with profile enforce it too', () => {
 assert.match(run(events(), {...options, expectedText: undefined}).error, /尚未取得/);
 const values = events(); values[4][1].patch_op[0].patch_type = 999;
 assert.match(run(values, {...options, patchProfile: calibrated.profile}).error, /未校准/);
 assert.match(run(values, {...options, expectedText: undefined, patchProfile: calibrated.profile}).error, /未校准/);
});

test('wrong local ID, question, bot, conversation, block and finish message are rejected', () => {
 const mutate = [
  values => { values[1][1].query_list[0].local_message_id = 'unrelated-local'; },
  values => { values[3][1].meta.bot_reply_message_id = 'unrelated-question'; },
  values => { values[3][1].meta.sender_id = 'unrelated-bot'; },
  values => { values[3][1].meta.conversation_id = 'unrelated-conversation'; },
  values => { values[4][1].patch_op[0].patch_value.content_block[0].block_id = 'unrelated-block'; },
  values => { values[12][1].msg_finish_attr.msgid = 'unrelated-answer'; },
 ];
 for (const fn of mutate) { const values = events(); fn(values); const result = run(values); assert.equal(result.complete, false); assert.ok(result.error); assert.ok(!result.error.includes('unrelated')); }
});

test('prompt echo must match and does not contribute its is_finish to completion', () => {
 const values = events(); values[2][1].message.content_block[0].content.text_block.text = 'different';
 assert.match(run(values).error, /回显内容/);
 const result = run(events().slice(0, 3)); assert.equal(result.text, ''); assert.equal(result.complete, false);
 assert.equal(result.signals.messageFinished, false);
});

test('initial and structured fragment are mandatory for exact calibration', () => {
 const noInitial = events(); noInitial[3][1].content.content_block[0].content.text_block.text = '';
 assert.match(run(noInitial).error, /预期标记/);
 const noPatch = events().filter((_v, i) => i !== 4); assert.match(run(noPatch).error, /预期标记/);
 const duplicate = events(); duplicate.splice(5, 0, structuredClone(duplicate[4])); assert.match(run(duplicate).error, /预期标记/);
});

test('no end signal alone or omitted stage can complete a response', () => {
 for (const remove of [10, 11, 12, 13, 15]) {
  const result = run(events().filter((_v, i) => i !== remove)); assert.equal(result.complete, false); assert.ok(result.error);
 }
 assert.equal(run(events().slice(0, 11)).complete, false);
});

test('metadata suggestions after answer-end are allowed but body is rejected', () => {
 const values = events(); values.splice(14, 0, ['CHUNK_DELTA', {text: 'unexpected'}]);
 assert.match(run(values).error, /结束信号后/);
 const afterTerminal = events(); afterTerminal.push(['CHUNK_DELTA', {text: 'unexpected'}]); assert.match(run(afterTerminal).error, /最终结束事件后/);
 assert.equal(calibrated.text, expected); assert.ok(!calibrated.text.includes('suggestion'));
});

test('unknown events, extra blocks, duplicate initial and unbound delta are rejected', () => {
 const unknown = events(); unknown.splice(4, 0, ['UNOBSERVED_EVENT', {}]); assert.match(run(unknown).error, /未支持的响应事件/);
 const extra = events(); extra[3][1].content.content_block.push(block('hidden')); assert.match(run(extra).error, /绑定不唯一/);
 const duplicate = events(); duplicate.splice(4, 0, structuredClone(duplicate[3])); assert.match(run(duplicate).error, /绑定不唯一/);
 assert.match(run([['CHUNK_DELTA', {text: 'history'}]]).error, /无绑定/);
});

test('unterminated SSE tail and invalid UTF-8 never become complete', () => {
 for (const ending of ['event: SSE_REPLY_END\ndata: {}', 'event: SSE_REPLY_END\ndata: {}\n', 'data: {']) {
  const stream = new AnswerStream(options); stream.feed(sse(events().slice(0, -1)) + ending); assert.ok(stream.finish().error);
 }
 const stream = new AnswerStream(options); stream.feed(new Uint8Array([0xe4, 0xb8])); assert.match(stream.finish().error, /UTF-8/);
 const invalid = new AnswerStream(options); invalid.feed(new Uint8Array([0xff])); assert.match(invalid.finish().error, /UTF-8/);
});

test('shared SSE IDs across all event types are valid and do not drop body fragments', () => {
 const text = sse(events()).replaceAll('event:', 'id: shared-cursor\nevent:');
 const stream = new AnswerStream(options); stream.feed(text);
 assert.equal(stream.finish().complete, true); assert.equal(stream.snapshot().text, expected);
});

test('inherited, reset and repeated ID fields do not determine message completion', () => {
 const stream = new AnswerStream(options);
 stream.feed('id: first\n\n' + sse(events()).replace('event: SSE_ACK', 'id: second\nid:\nid: shared\nevent: SSE_ACK') + 'id: final\n\n');
 assert.equal(stream.finish().complete, true);
 const partial = new AnswerStream(options); partial.feed('id: shared\n' + sse(events().slice(0, 4)));
 assert.equal(partial.finish().complete, false);
 const bad = new AnswerStream(options); bad.feed('event: SSE_ACK\nevent: SSE_ACK\ndata: {}\n\n'); assert.match(bad.finish().error, /重复/);
});

test('same-ID duplicate payload is not silently discarded and cannot pass exact calibration', () => {
 const values=events(); values.splice(7,0,structuredClone(values[6]));
 const stream=new AnswerStream(options);stream.feed(sse(values).replaceAll('event:','id: shared\nevent:'));
 assert.equal(stream.finish().complete,false);assert.match(stream.snapshot().error,/预期标记/);
});

test('response line, total bytes and body budgets stop processing without truncation success', () => {
 const line = new AnswerStream(options); line.feed('x'.repeat(1024 * 1024 + 1)); assert.match(line.finish().error, /单行响应/);
 const total = new AnswerStream(options); total.feed(new Uint8Array(8 * 1024 * 1024 + 1)); assert.match(total.finish().error, /8 MiB/);
 const stream = new AnswerStream({...options, expectedText: undefined, patchProfile: calibrated.profile});
 stream.feed(sse(events().slice(0, 4)));
 const chunk = sse([['CHUNK_DELTA', {text: 'x'.repeat(500000)}]]);
 for (let i = 0; i < 5; i++) stream.feed(chunk);
 assert.match(stream.finish().error, /2 MiB/); assert.equal(stream.snapshot().complete, false);
});

test('trailing comments and heartbeat are harmless, but post-HTTP data invalidates success', () => {
 const stream = new AnswerStream(options); stream.feed(sse(events()) + ': comment\n\n' + sse([['SSE_HEARTBEAT', {}]]));
 assert.equal(stream.finish().complete, true); assert.equal(stream.finish().complete, true);
 assert.equal(stream.feed('unexpected').complete, false); assert.match(stream.snapshot().error, /HTTP 结束后/);
});


test('empty operation directly before message finish is calibrated without adding text', () => {
 const values=events();values[11][1].patch_op[0].patch_value={};
 const result=run(values);assert.equal(result.complete,true);assert.equal(result.text,expected);
 assert.deepEqual(result.profile.tuples.emptyFinish,[[7,8]]);
 assert.equal(run(values,{...options,patchProfile:result.profile}).complete,true);
 assert.equal(run(values,{...options,patchProfile:calibrated.profile}).complete,false);
});

test('empty patch alone or before body completion cannot be mistaken for completion', () => {
 const values=events();values[4][1].patch_op[0].patch_value={};const result=run(values);
 assert.equal(result.complete,false);assert.equal(result.patchDiagnostic.keyCount,0);
 const missing=events();missing[11][1].patch_op=[patch({})];assert.equal(run(missing).complete,false);
});

test('unsupported patch diagnostic exposes bounded shape, never unknown keys or payload', () => {
 const values=events();values[4][1].patch_op[0].patch_value={'private-customer-key':'private-value'};
 const result=run(values);assert.equal(result.complete,false);assert.equal(result.patchDiagnostic.otherFieldCount,1);
 assert.ok(!JSON.stringify(result.patchDiagnostic).includes('private'));assert.deepEqual(result.patchDiagnostic.knownFields,[]);
});
test('unsupported block diagnosis exposes structure but no payload, IDs or unknown key text',()=>{
 const stream=new AnswerStream(options);stream.block({block_type:12345,block_id:'PRIVATE_ID',content:{text_block:{text:'PRIVATE_BODY'},PRIVATE_SECRET:'PRIVATE_VALUE'},is_finish:false,patch_type:4},true);
 const result=stream.snapshot();assert.match(result.error,/未支持/);assert.equal(result.blockDiagnostic.blockType,12345);assert.equal(result.blockDiagnostic.shape.fields.content.unknownKeyCount,1);assert.doesNotMatch(JSON.stringify(result.blockDiagnostic),/PRIVATE/);assert.equal(result.complete,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sanitizeEndpoint, jsonShape, ProtocolStream } = require('../src/protocol-schema.cjs');

const SECRET = 'SYNTHETIC_PRIVATE_SECRET_XYZ_246813579';
const assertPrivate = report => {
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.ok(!JSON.stringify(report).includes('987654321012345678'));
  assert.ok(!JSON.stringify(report).includes('synthetic-user@example.test'));
};

test('endpoint accepts only HTTPS Doubao and strips values, identities and fragments', () => {
  const endpoint = sanitizeEndpoint(`https://www.doubao.com/api/chat/550e8400-e29b-41d4-a716-446655440000/987654321012345678/${SECRET}?token=${SECRET}&q=synthetic-user@example.test#${SECRET}`);
  assert.deepEqual(endpoint, {
    origin: 'https://www.doubao.com',
    path: '/api/chat/[redacted]/[redacted]/[redacted]',
    queryKeys: ['q', 'token'],
  });
  assertPrivate(endpoint);
  for (const url of ['http://doubao.com/api/chat', 'https://doubao.com.evil.test/api', 'https://other.test/', 'https://user:pass@doubao.com/', 'https://doubao.com:444/', 'invalid']) {
    assert.equal(sanitizeEndpoint(url), null);
  }
  assert.deepEqual(sanitizeEndpoint(`https://${SECRET}.doubao.com/${SECRET}?${SECRET}=x`), {
    origin: 'https://[subdomain].doubao.com', path: '/[redacted]', queryKeys: ['[key]'],
  });
});

test('JSON shapes retain only reviewed field names and types, never values or dynamic map keys', () => {
  const shape = jsonShape(JSON.stringify({
    message: SECRET, account: 'synthetic-user@example.test', token: SECRET,
    id: '987654321012345678', [SECRET]: { content: SECRET },
    choices: [{ index: 987654321012345678, content: SECRET }, { content: '中文内容' }],
  }));
  assertPrivate(shape);
  assert.ok(shape.fields.some(field => field.path === '$.choices[*].content' && field.type === 'string'));
  assert.ok(shape.fields.some(field => field.path === '$.[key].content'));
  assert.equal(shape.fields.filter(field => field.path === '$.choices[*].content').length, 1);
  assert.deepEqual(jsonShape(JSON.stringify(SECRET)).fields, [{ path: '$', type: 'string' }]);
  assert.equal(jsonShape(SECRET).format, 'non-json');
});

test('shape bounds depth, nodes and input size, skips getters and handles cycles', () => {
  const object = { data: { data: { data: { content: SECRET } } } };
  assert.equal(jsonShape(object, { maxDepth: 2 }).truncated, true);
  assert.ok(jsonShape(object, { maxNodes: 2 }).fields.length <= 2);
  assert.equal(jsonShape(JSON.stringify({ content: SECRET.repeat(10) }), { maxBytes: 128 }).format, 'oversize');
  const cyclic = { content: SECRET };
  cyclic.data = cyclic;
  assert.equal(jsonShape(cyclic).truncated, true);
  const accessor = Object.defineProperty({}, 'content', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.ok(jsonShape(accessor).fields.some(field => field.type === 'unknown'));
});

test('SSE decoder supports UTF-8 and frame splits without retaining text or IDs', () => {
  const stream = new ProtocolStream({ format: 'sse' });
  const payload = Buffer.from(`id: ${SECRET}\r\nevent: message\r\ndata: {"content":"你好${SECRET}","id":"987654321012345678"}\r\n\r\nevent: ${SECRET}\ndata: {"delta":"${SECRET}"}\n\ndata: [DONE]\n\n`);
  // Every byte is separate, including multibyte characters and CRLF delimiters.
  for (const byte of payload) stream.push(Buffer.from([byte]));
  const report = stream.finish();
  assertPrivate(report);
  assert.equal(report.events.length, 3);
  assert.equal(report.invalidPayloads, 0);
  assert.equal(report.events[1].event, 'other');
  assert.equal(report.observedEndMarkers[0].value, '[DONE]');
  assert.equal(report.markerSemantics, 'unverified');
});

test('HTTP end does not mean model completion and arbitrary end values stay private', () => {
  const stream = new ProtocolStream({ format: 'sse' });
  stream.push(`data: {"content":"${SECRET}","finish_reason":"${SECRET}","done":"${SECRET}"}\n\n`);
  const report = stream.finish();
  assert.equal(report.transportEnded, true);
  assert.equal(Object.hasOwn(report, 'modelCompleted'), false);
  assert.deepEqual(report.observedEndMarkers, []);
  assertPrivate(report);
  const before = JSON.stringify(report);
  stream.push('data: [DONE]\n\n');
  assert.equal(JSON.stringify(stream.report()), before);
});

test('NDJSON collects structures and only strictly allowlisted observed end markers', () => {
  const stream = new ProtocolStream({ format: 'ndjson' });
  stream.push('{"choices":[{"finish_re');
  stream.push(`ason":"stop","content":"${SECRET}"}]}\n`);
  stream.push(`{"done":true,"type":"response.completed","value":"${SECRET}"}\n${SECRET}\n`);
  stream.push('{"content":"最后一行"}');
  const report = stream.finish();
  assertPrivate(report);
  assert.equal(report.events.length, 4);
  assert.equal(report.invalidPayloads, 1);
  assert.deepEqual(report.observedEndMarkers.map(marker => marker.kind), ['finish-reason', 'boolean-end-flag', 'payload-type']);
});

test('bounded capture discards oversize frames and caps distinct schemas without losing markers', () => {
  const stream = new ProtocolStream({ maxFrameBytes: 128, maxEvents: 1 });
  stream.push(`data: {"content":"${SECRET.repeat(8)}"}\n\n`);
  stream.push('data: {"content":"x"}\n\ndata: {"content":"y"}\n\ndata: [DONE]\n\n');
  const report = stream.finish();
  assertPrivate(report);
  assert.equal(report.truncated, true);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].count, 2);
  assert.equal(report.droppedSchemaEvents, 1);
  assert.deepEqual(report.observedEndMarkers, [{ kind: 'sse-sentinel', value: '[DONE]' }]);
  const byteBounded = new ProtocolStream({ maxBytes: 128 });
  byteBounded.push(SECRET.repeat(10));
  assertPrivate(byteBounded.finish());
  assert.equal(byteBounded.report().events.length, 0);
});

test('reports are detached copies without unprocessed input', () => {
  const stream = new ProtocolStream();
  stream.push(`data: {"content":"${SECRET}`);
  const intermediate = stream.report();
  assertPrivate(intermediate);
  assertPrivate(stream);
  intermediate.events.push({ content: SECRET });
  assertPrivate(stream.report());
});

test('SSE supports lone CR and split CRLF without extra blank frames', () => {
  const stream = new ProtocolStream();
  stream.push('data: {"content":"a"}\r');
  stream.push('\n\r');
  stream.push('\ndata: {"content":"b"}\r\r');
  const report = stream.finish();
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].count, 2);
});

test('NDJSON recovers after oversized split line without discarding next record', () => {
  const stream = new ProtocolStream({ format: 'ndjson', maxFrameBytes: 128 });
  stream.push(SECRET.repeat(8));
  stream.push('\n{"content":"next"}\n');
  const report = stream.finish();
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].format, 'json');
  assertPrivate(report);
});

test('more than a thousand repeated deltas preserve the end marker and bounded schema storage', () => {
  const stream = new ProtocolStream({ maxEvents: 1 });
  for (let index = 0; index < 1200; index++) {
    stream.push(`event: delta\ndata: {"delta":"${SECRET}","index":${index}}\n\n`);
  }
  stream.push('event: done\ndata: {"finish_reason":"stop"}\n\n');
  stream.push('data: [DONE]\n\n');
  const report = stream.finish();
  assertPrivate(report);
  assert.equal(report.eventCount, 1202);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].count, 1200);
  assert.equal(report.droppedSchemaEvents, 2);
  assert.equal(report.partialFrame, false);
  assert.deepEqual(report.observedEndMarkers.map(marker => marker.kind), ['event', 'finish-reason', 'sse-sentinel']);
});

test('SSE EOF discards unterminated frames instead of inventing an end marker', () => {
  for (const suffix of ['', '\n', '\r\n', '\r']) {
    const stream = new ProtocolStream();
    stream.push('data: {"content":"complete earlier frame"}\n\n');
    stream.push(`event: done\ndata: [DONE]${suffix}`);
    const report = stream.finish();
    assert.equal(report.eventCount, 1);
    assert.equal(report.partialFrame, true);
    assert.equal(report.transportEnded, true);
    assert.deepEqual(report.observedEndMarkers, []);
  }
});

test('schema deduplication ignores object field ordering and retains per-frame counts', () => {
  const stream = new ProtocolStream({ format: 'ndjson' });
  stream.push('{"content":"a","type":"delta"}\n{"type":"delta","content":"b"}\n');
  const report = stream.finish();
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].count, 2);
  assert.equal(report.eventCount, 2);
});

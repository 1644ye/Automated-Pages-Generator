'use strict';

const { StringDecoder } = require('node:string_decoder');

// Schema names are useful evidence; arbitrary map keys may be user content or IDs.
// Unknown names stay redacted until a reviewed rule is added here.
const SAFE_NAMES = new Set(`
  api v1 v2 v3 v4 web chat chats conversation conversations completion completions
  stream streaming message messages event events session sessions bot bots assistant
  get create send update delete list detail history fetch receive upload download
  assistants user users model models search web_search internet response responses
  request requests generate generation sse connect query gateway conversation_id
  message_id parent_id request_id session_id bot_id assistant_id model_id user_id
  local_message_id local_conversation_id id uuid index type event_type event status
  code error errors error_code error_message msg detail details data payload result
  results content contents text delta value values answer output input prompt role
  parts blocks attachments references citations sources source url title description
  choices choice finish_reason stop_reason done is_end is_finish finished completed
  completion_status metadata meta extra ext usage token_usage tokens total_tokens
  input_tokens output_tokens prompt_tokens completion_tokens created created_at
  updated_at timestamp time sequence seq event_id version protocol action method
  params parameters options config settings enable_search search_enabled search_type
  search_result search_results tool tool_calls tool_call_id function arguments name
  reasoning reasoning_content thinking thought answer_type content_type mime_type
  is_delta is_final is_complete next cursor has_more pagination limit offset page
  count total items list object enabled state success success_code trace_id log_id
  req_id parent_message_id is_regen regenerate retry attempt language locale lang
  device_id browser browser_name browser_version platform os app_name app_id aid
  client_id client_type client_version channel source_type origin referer region
  signature sign nonce auth authorization token access_token refresh_token cookie
  cookies password account email username search_query search_queries queries q
  message_index completion_id conversation_info message_info reply reply_id
  section_id section sections chunks chunk patches patch operation op path replace
  append remove add keep_alive heartbeat ping pong end end_reason event_data
  is_thinking is_finish_reason is_from_history need_search is_new_conversation
  max_tokens temperature top_p stop model_name need_title streaming_output body
  reasoning_summary annotation annotations context records record record_id
  task task_id task_type position start finish duration_ms length size info
`.trim().split(/\s+/));

const SAFE_EVENTS = new Set([
  'message', 'delta', 'done', 'end', 'error', 'ping', 'pong', 'heartbeat',
  'message_start', 'message_delta', 'message_stop', 'content_block_start',
  'content_block_delta', 'content_block_stop', 'completion', 'completion.chunk',
  'response.created', 'response.in_progress', 'response.output_text.delta',
  'response.output_text.done', 'response.completed', 'response.failed',
  'response.incomplete',
]);
const END_EVENTS = new Set(['done', 'end', 'message_stop', 'response.completed', 'response.failed', 'response.incomplete']);
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'end_turn', 'max_tokens', 'stop_sequence']);
const TYPE_MARKERS = new Set(['message_stop', 'response.completed', 'response.failed', 'response.incomplete']);

function bounded(value, fallback, min, max) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function safeName(name) {
  return typeof name === 'string' && SAFE_NAMES.has(name) ? name : '[key]';
}

function safeRouteSegment(segment) {
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch { return '[redacted]'; }
  if (!decoded || decoded.length > 64 || !/^[a-z][a-z0-9_-]*$/i.test(decoded)) return '[redacted]';
  // Only fixed endpoint vocabulary can survive. UUIDs, numbers, opaque tokens,
  // usernames and filenames cannot pass merely by looking alphanumeric.
  const parts = decoded.toLowerCase().split(/[-_]/);
  return parts.every(part => SAFE_NAMES.has(part)) ? decoded.toLowerCase() : '[redacted]';
}

function sanitizeEndpoint(input) {
  let parsed;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !(host === 'doubao.com' || host.endsWith('.doubao.com'))) return null;
  // Dynamic subdomains can also contain account or token values.
  const prefix = host === 'doubao.com' ? '' : host.slice(0, -'.doubao.com'.length);
  const safeHost = prefix && !prefix.split('.').every(part => ['www', 'api', 'chat', 'web', 'm', 'static'].includes(part))
    ? '[subdomain].doubao.com' : host;
  const segments = parsed.pathname.split('/').slice(1, 33).map(segment => segment ? safeRouteSegment(segment) : '');
  const queryKeys = [...new Set([...parsed.searchParams.keys()].slice(0, 64).map(safeName))].sort();
  return { origin: `https://${safeHost}`, path: '/' + segments.join('/'), queryKeys };
}

function shapeValue(value, options = {}) {
  const maxDepth = bounded(options.maxDepth, 8, 1, 16);
  const maxNodes = bounded(options.maxNodes, 256, 1, 1024);
  const maxKeys = bounded(options.maxKeys, 50, 1, 100);
  const arraySamples = bounded(options.arraySamples, 3, 1, 10);
  const fields = [];
  const emitted = new Set();
  const visited = new WeakSet();
  let nodes = 0;
  let truncated = false;
  function visit(current, path, depth) {
    if (nodes >= maxNodes) { truncated = true; return; }
    nodes++;
    const type = current === null ? 'null' : Array.isArray(current) ? 'array' : typeof current;
    const safeType = ['null', 'array', 'object', 'string', 'number', 'boolean'].includes(type) ? type : 'unknown';
    const key = `${path}:${safeType}`;
    if (!emitted.has(key)) { emitted.add(key); fields.push({ path, type: safeType }); }
    if (!current || typeof current !== 'object') return;
    if (depth >= maxDepth || visited.has(current)) { truncated = true; return; }
    visited.add(current);
    if (Array.isArray(current)) {
      if (current.length > arraySamples) truncated = true;
      for (let index = 0; index < Math.min(current.length, arraySamples); index++) {
        if (nodes >= maxNodes) { truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        visit(descriptor && 'value' in descriptor ? descriptor.value : undefined, `${path}[*]`, depth + 1);
      }
    } else {
      const keys = Object.keys(current);
      if (keys.length > maxKeys) truncated = true;
      for (const name of keys.slice(0, maxKeys)) {
        if (nodes >= maxNodes) { truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        visit(descriptor && 'value' in descriptor ? descriptor.value : undefined, `${path}.${safeName(name)}`, depth + 1);
      }
    }
  }
  try { visit(value, '$', 0); } catch { truncated = true; }
  return { format: 'json', fields, truncated };
}

function jsonShape(input, options = {}) {
  if (typeof input !== 'string') return shapeValue(input, options);
  const maxBytes = bounded(options.maxBytes, 128 * 1024, 128, 1024 * 1024);
  if (Buffer.byteLength(input) > maxBytes) return { format: 'oversize', fields: [], truncated: true };
  try { return shapeValue(JSON.parse(input), options); }
  catch { return { format: 'non-json', fields: [], truncated: false }; }
}

function collectMarkers(value, add, depth = 0, path = '$', budget = { remaining: 256 }) {
  if (!value || typeof value !== 'object' || depth > 8 || budget.remaining-- <= 0) return;
  for (const key of Object.keys(value).slice(0, 50)) {
    if (budget.remaining <= 0) break;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const item = descriptor.value;
    const fieldPath = Array.isArray(value) ? `${path}[*]` : `${path}.${safeName(key)}`;
    if (['finish_reason', 'stop_reason'].includes(key) && FINISH_REASONS.has(item)) {
      add({ kind: 'finish-reason', path: fieldPath, value: item });
    } else if (key === 'type' && TYPE_MARKERS.has(item)) {
      add({ kind: 'payload-type', path: fieldPath, value: item });
    } else if (['done', 'is_end', 'is_finish', 'is_final', 'is_complete'].includes(key) && item === true) {
      add({ kind: 'boolean-end-flag', path: fieldPath, value: true });
    }
    collectMarkers(item, add, depth + 1, fieldPath, budget);
  }
}

class ProtocolStream {
  constructor(options = {}) {
    if (options.format && !['sse', 'ndjson'].includes(options.format)) throw new TypeError('Unsupported stream format');
    this.format = options.format || 'sse';
    this.maxBytes = bounded(options.maxBytes, 1024 * 1024, 128, 8 * 1024 * 1024);
    this.maxEvents = bounded(options.maxEvents, 64, 1, 256);
    this.maxFrameBytes = bounded(options.maxFrameBytes, 128 * 1024, 128, 512 * 1024);
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.data = [];
    this.frameBytes = 0;
    this.frameOpen = false;
    this.event = 'message';
    this.discardFrame = false;
    this.discardLine = false;
    this.bytesSeen = 0;
    this.eventCount = 0;
    this.invalidPayloads = 0;
    this.events = [];
    this.schemaKeys = new Map();
    this.droppedSchemaEvents = 0;
    this.observedEndMarkers = [];
    this.markerKeys = new Set();
    this.truncated = false;
    this.transportEnded = false;
    this.partialFrame = false;
    this.stopped = false;
  }

  push(chunk) {
    if (this.transportEnded || this.stopped) return this.report();
    if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) throw new TypeError('Expected UTF-8 bytes or string');
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.bytesSeen += bytes.length;
    if (this.bytesSeen > this.maxBytes) {
      this.truncated = this.stopped = true;
      this.clearRaw();
      return this.report();
    }
    this.consume(this.decoder.write(bytes));
    return this.report();
  }

  consume(text, final = false) {
    this.pending += text;
    let newline;
    while ((newline = this.pending.search(/[\r\n]/)) !== -1) {
      if (!final && this.pending[newline] === '\r' && newline === this.pending.length - 1) break;
      const width = this.pending[newline] === '\r' && this.pending[newline + 1] === '\n' ? 2 : 1;
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + width);
      if (this.discardLine) {
        this.discardLine = false;
        if (this.format === 'ndjson') this.discardFrame = false;
      }
      else if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.truncated = true;
        this.discardFrame = this.format === 'sse';
      }
      else this.line(line);
      if (this.stopped) { this.clearRaw(); return; }
    }
    if (Buffer.byteLength(this.pending) > this.maxFrameBytes) {
      this.pending = '';
      this.discardLine = true;
      this.discardFrame = true;
      this.truncated = true;
    }
  }

  line(line) {
    if (this.format === 'ndjson') {
      if (line.trim()) {
        if (!this.discardFrame) this.record('message', line);
        this.discardFrame = false;
      }
      return;
    }
    if (line === '') { this.dispatch(); return; }
    if (line.startsWith(':') || this.discardFrame) return;
    this.frameOpen = true;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.event = SAFE_EVENTS.has(raw) ? raw : 'other';
    if (field === 'data') {
      this.frameBytes += Buffer.byteLength(raw) + 1;
      if (this.frameBytes > this.maxFrameBytes) {
        this.truncated = true;
        this.discardFrame = true;
        this.data = [];
      } else this.data.push(raw);
    }
    // SSE id, retry, comments and unrecognised fields are intentionally dropped.
  }

  dispatch() {
    if (!this.discardFrame && this.data.length) this.record(this.event, this.data.join('\n'));
    this.data = [];
    this.frameBytes = 0;
    this.event = 'message';
    this.discardFrame = false;
    this.frameOpen = false;
  }

  addMarker(marker) {
    const key = JSON.stringify(marker);
    if (!this.markerKeys.has(key) && this.observedEndMarkers.length < 64) {
      this.markerKeys.add(key);
      this.observedEndMarkers.push(marker);
    }
  }

  record(event, payload) {
    this.eventCount++;
    if (END_EVENTS.has(event)) this.addMarker({ kind: 'event', value: event });
    if (this.format === 'sse' && payload === '[DONE]') {
      this.storeSchema(event, { format: 'sentinel', fields: [], truncated: false });
      this.addMarker({ kind: 'sse-sentinel', value: '[DONE]' });
      return;
    }
    const shape = jsonShape(payload, { maxBytes: this.maxFrameBytes });
    this.storeSchema(event, shape);
    this.truncated ||= shape.truncated;
    if (shape.format !== 'json') this.invalidPayloads++;
    else collectMarkers(JSON.parse(payload), marker => this.addMarker(marker));
  }

  storeSchema(event, shape) {
    // maxEvents limits distinct structures, not streaming frames. Repeated
    // deltas must never prevent observation of a later completion marker.
    const fields = [...shape.fields].sort((left, right) =>
      left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
    const signature = JSON.stringify({ event, format: shape.format, fields });
    const existing = this.schemaKeys.get(signature);
    if (existing) {
      existing.count++;
      existing.truncated ||= shape.truncated;
    } else if (this.events.length < this.maxEvents) {
      const entry = { event, ...shape, fields, count: 1 };
      this.events.push(entry);
      this.schemaKeys.set(signature, entry);
    } else {
      this.droppedSchemaEvents++;
      this.truncated = true;
    }
  }

  clearRaw() {
    this.pending = '';
    this.data = [];
    this.frameBytes = 0;
    this.frameOpen = false;
    this.decoder = new StringDecoder('utf8');
  }

  finish() {
    if (!this.transportEnded && !this.stopped) {
      this.consume(this.decoder.end(), true);
      if (this.format === 'ndjson') {
        if (this.pending && !this.discardLine) this.line(this.pending);
      } else {
        // SSE frames are dispatched by the blank-line delimiter only. EOF is
        // not a delimiter, even if its unfinished data looks like [DONE].
        this.partialFrame = Boolean(this.pending || this.frameOpen || this.data.length || this.discardLine || this.discardFrame);
        this.truncated ||= this.partialFrame;
      }
    }
    this.transportEnded = true;
    this.clearRaw();
    return this.report();
  }

  report() {
    // A transport close or observed marker is evidence only. Neither asserts
    // that a response is complete, successful, or bound to the requested task.
    return JSON.parse(JSON.stringify({
      format: this.format,
      bytesSeen: this.bytesSeen,
      eventCount: this.eventCount,
      invalidPayloads: this.invalidPayloads,
      droppedSchemaEvents: this.droppedSchemaEvents,
      transportEnded: this.transportEnded,
      partialFrame: this.partialFrame,
      truncated: this.truncated,
      markerSemantics: 'unverified',
      events: this.events,
      observedEndMarkers: this.observedEndMarkers,
    }));
  }

  toJSON() {
    // Accidental JSON serialization must not expose in-progress raw buffers.
    return this.report();
  }
}

module.exports = { sanitizeEndpoint, jsonShape, ProtocolStream };

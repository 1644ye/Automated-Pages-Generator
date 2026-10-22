'use strict';

// Self-contained so the same parser can run in the isolated, local application
// tests and in the page's fetch bridge. It does not access DOM, cookies or APIs.
function createAnswerRuntime() {
 const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
 const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
 const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
 const index = value => Number.isSafeInteger(value) && value >= 0;
 const control = value => Number.isSafeInteger(value) && Math.abs(value) <= 65535;
 const copy = value => JSON.parse(JSON.stringify(value));
 const categories = ['initial', 'text', 'finish', 'meta', 'tts', 'messageEnd', 'answerEnd', 'terminalEnd'];
 const emptyProfile = () => ({version: 1, tuples: Object.fromEntries(categories.map(key => [key, []]))});
 const validProfile = value => object(value) && value.version === 1 && object(value.tuples)
  && categories.every(key => Array.isArray(value.tuples[key]) && value.tuples[key].length <= 64
   && value.tuples[key].every(tuple => Array.isArray(tuple) && tuple.length >= 1 && tuple.length <= 3 && tuple.every(control)))
  && ['initial', 'finish', 'messageEnd', 'answerEnd', 'terminalEnd'].every(key => value.tuples[key].length > 0);

 class AnswerStream {
  constructor(options = {}) {
   this.options = options;
   this.decoder = new TextDecoder('utf-8', {fatal: true});
   this.encoder = new TextEncoder();
   this.lineBuffer = ''; this.event = ''; this.data = []; this.frameBytes = 0;
   this.bytes = 0; this.textBytes = 0; this.text = ''; this.frames = 0;
   this.error = ''; this.ended = false; this.complete = false; this.echo = false;
   this.blockFinished = false; this.messageFinished = false;
   this.messageEnd = false; this.answerEnd = false; this.terminalEnd = false;
   this.binding = {conversationId: '', sectionId: '', questionId: '', answerId: '', questionMessageIndex: null, answerMessageIndex: null, lastMessageIndex: null};
   this.blockId = ''; this.brief = null; this.profile = emptyProfile();
   this.calibration = typeof options.expectedText === 'string';
   this.allowedProfile = options.patchProfile;
   if (!id(options.localMessageId) || !id(options.botId) || typeof options.prompt !== 'string'
    || options.prompt.length > 110000 || (options.conversationId && !id(options.conversationId))) this.fail('请求绑定参数不完整');
   if (this.calibration && (!options.expectedText || options.expectedText.length > 256)) this.fail('校准标记无效');
   if ((!this.calibration || this.allowedProfile !== undefined) && !validProfile(this.allowedProfile)) this.fail('尚未取得成功校准的流式协议配置');
  }
  fail(message) { if (!this.error) this.error = message; this.complete = false; return false; }
  tuple(category, values) {
   if (!values.every(control)) return this.fail('流式控制字段缺失或类型变化');
   const signature = JSON.stringify(values);
   if (this.allowedProfile && !this.allowedProfile.tuples[category].some(v => JSON.stringify(v) === signature)) return this.fail('发现未校准的流式操作，已暂停');
   if (!this.profile.tuples[category].some(v => JSON.stringify(v) === signature)) {
    if (this.profile.tuples[category].length >= 64) return this.fail('流式操作种类超过限制');
    this.profile.tuples[category].push(values.slice());
   }
   return true;
  }
  append(text) {
   if (typeof text !== 'string') return this.fail('正文片段不是文本');
   if (this.blockFinished || this.messageFinished || this.messageEnd || this.answerEnd || this.terminalEnd) return this.fail('结束信号后仍收到正文，已暂停');
   this.textBytes += this.encoder.encode(text).byteLength;
   if (this.textBytes > 2 * 1024 * 1024) return this.fail('回答超过 2 MiB 上限，未视为完整结果');
   this.text += text;
   return true;
  }
  updateIndex(value) {
   if (!index(value)) return this.fail('消息序号缺失或类型变化');
   this.binding.lastMessageIndex = Math.max(this.binding.lastMessageIndex ?? 0, value);
   return true;
  }
  block(value, initial, patch) {
   if (!object(value) || value.block_type !== 10000 || !id(value.block_id)
    || !object(value.content) || !object(value.content.text_block)
    || Object.keys(value.content).some(key => key !== 'text_block')) return this.fail('出现未支持的回答内容块');
   if (initial) this.blockId = value.block_id;
   else if (value.block_id !== this.blockId) return this.fail('正文内容块绑定不一致');
   const hasText = own(value.content.text_block, 'text');
   if (Object.keys(value.content.text_block).some(key => key !== 'text')) return this.fail('文本块结构变化，已暂停');
   if (initial) {
    if (!hasText || value.is_finish !== false || !this.tuple('initial', [value.patch_type])) return this.fail('回答首段结构不符合校准条件');
    return this.append(value.content.text_block.text);
   }
   if (value.is_finish === true) {
    if (hasText || this.blockFinished || !this.tuple('finish', [patch.patch_object, patch.patch_type, value.patch_type])) return this.fail('正文结束块结构不符合校准条件');
    this.blockFinished = true;
    return true;
   }
   if (value.is_finish !== false || !hasText || !this.tuple('text', [patch.patch_object, patch.patch_type, value.patch_type])) return this.fail('正文增量结构不符合校准条件');
   return this.append(value.content.text_block.text);
  }
  receive(event, payload) {
   if (this.error) return;
   this.frames++;
   if (this.frames > 100000) return this.fail('响应事件数量超过限制');
   if (event === 'SSE_HEARTBEAT') return;
   if (this.terminalEnd) return this.fail('最终结束事件后仍收到数据');
   let value;
   try { value = JSON.parse(payload); } catch { return this.fail('响应事件不是有效 JSON'); }
   if (!object(value)) return this.fail('响应事件结构不符合要求');
   if (event === 'SSE_ACK') {
    if (this.binding.questionId || !Array.isArray(value.query_list) || value.query_list.length !== 1) return this.fail('请求确认重复或不唯一');
    const query = value.query_list[0], meta = value.ack_client_meta;
    if (!object(query) || query.local_message_id !== this.options.localMessageId || !id(query.question_id)
     || !object(meta) || !id(meta.conversation_id) || !id(meta.section_id)
     || (this.options.conversationId && meta.conversation_id !== this.options.conversationId)) return this.fail('请求确认与当前任务不匹配');
    this.binding.conversationId = meta.conversation_id; this.binding.sectionId = meta.section_id; this.binding.questionId = query.question_id;
    if (this.updateIndex(query.message_index)) this.binding.questionMessageIndex = query.message_index;
    return;
   }
   if (event === 'FULL_MSG_NOTIFY') {
    const message = value.message;
    if (!this.binding.questionId || this.echo || this.binding.answerId || !object(message)
     || message.local_message_id !== this.options.localMessageId || message.message_id !== this.binding.questionId
     || message.conversation_id !== this.binding.conversationId || message.section_id !== this.binding.sectionId
     || !Array.isArray(message.content_block) || message.content_block.length !== 1) return this.fail('用户消息回显与当前任务不匹配');
    const block = message.content_block[0];
    if (!object(block) || block.block_type !== 10000 || block.content?.text_block?.text !== this.options.prompt) return this.fail('用户消息回显内容不一致');
    // message.content is a duplicate encoded representation. It is never appended.
    if (message.index_in_conv !== this.binding.questionMessageIndex) return this.fail('用户消息回显序号不一致');
    this.echo = true; return;
   }
   if (event === 'STREAM_MSG_NOTIFY') {
    const meta = value.meta, content = value.content;
    if (!this.echo || this.binding.answerId || !object(meta) || !id(meta.message_id)
     || meta.message_id === this.binding.questionId || meta.bot_reply_message_id !== this.binding.questionId
     || meta.conversation_id !== this.binding.conversationId || meta.section_id !== this.binding.sectionId
     || meta.sender_id !== this.options.botId || !object(content)
     || !Array.isArray(content.content_block) || content.content_block.length !== 1) return this.fail('助手回答绑定不唯一或不匹配');
    this.binding.answerId = meta.message_id;
    if (!this.updateIndex(meta.index_in_conv)) return;
    this.binding.answerMessageIndex = meta.index_in_conv;
    this.block(content.content_block[0], true); return;
   }
   if (event === 'CHUNK_DELTA') {
    if (!this.binding.answerId || !this.blockId || Object.keys(value).length !== 1 || !own(value, 'text')) return this.fail('无绑定或未知格式的正文增量');
    this.append(value.text); return;
   }
   if (event === 'STREAM_CHUNK') {
    if (!this.binding.answerId || value.message_id !== this.binding.answerId
     || !Array.isArray(value.patch_op) || !value.patch_op.length || value.patch_op.length > 64) return this.fail('结构化片段不属于当前回答');
    for (const patch of value.patch_op) {
     if (this.error) return;
     if (!object(patch) || !object(patch.patch_value)) return this.fail('结构化片段格式变化');
     const body = patch.patch_value, keys = Object.keys(body);
     if (keys.length !== 1 || !['content_block', 'ext', 'tts_content'].includes(keys[0])) return this.fail('出现未支持的结构化操作');
     if (own(body, 'content_block')) {
      if (!Array.isArray(body.content_block) || body.content_block.length !== 1) return this.fail('回答存在额外内容块，已暂停');
      this.block(body.content_block[0], false, patch);
     } else if (own(body, 'tts_content')) {
      if (typeof body.tts_content !== 'string' || !this.tuple('tts', [patch.patch_object, patch.patch_type])) return this.fail('语音元数据格式变化');
     } else {
      if (!object(body.ext) || !this.tuple('meta', [patch.patch_object, patch.patch_type])) return this.fail('回答元数据格式变化');
      if (own(body.ext, 'is_finish')) {
       if (body.ext.is_finish !== '1' || !this.blockFinished || this.messageFinished || this.messageEnd) return this.fail('消息结束标记顺序不一致');
       this.messageFinished = true;
      }
     }
    }
    return;
   }
   if (event === 'SSE_REPLY_END') {
    if (!this.binding.answerId || !this.blockFinished || !this.messageFinished) return this.fail('回答结束信号早于正文结束');
    if (own(value, 'msg_finish_attr')) {
     const attr = value.msg_finish_attr;
     if (this.messageEnd || this.answerEnd || own(value, 'answer_finish_attr') || !object(attr)
      || attr.msgid !== this.binding.answerId || typeof attr.brief !== 'string'
      || !this.tuple('messageEnd', [value.end_type])) return this.fail('消息结束事件与当前回答不匹配');
     this.brief = attr.brief; this.messageEnd = true; return;
    }
    if (own(value, 'answer_finish_attr')) {
     if (!this.messageEnd || this.answerEnd || !object(value.answer_finish_attr)
      || typeof value.answer_finish_attr.has_suggest !== 'boolean'
      || !this.tuple('answerEnd', [value.end_type])) return this.fail('回答结束事件顺序不一致');
     this.answerEnd = true; return;
    }
    if (!this.answerEnd || Object.keys(value).length !== 1 || !this.tuple('terminalEnd', [value.end_type])) return this.fail('最终结束事件结构或顺序不一致');
    this.terminalEnd = true; return;
   }
   return this.fail('出现未支持的响应事件，已暂停');
  }
  line(line) {
   if (!line) {
    if (this.data.length) {
     if (!this.event) return this.fail('响应缺少事件名称');
     // SSE id is a reconnection cursor, not a unique frame key. This
     // transport never reconnects or replays; process every frame in order.
     this.receive(this.event, this.data.join('\n'));
    } else if (this.event) return this.fail('响应事件缺少数据');
    this.event = ''; this.data = []; this.frameBytes = 0; return;
   }
   if (line.startsWith(':')) return;
   const colon = line.indexOf(':');
   const key = colon < 0 ? line : line.slice(0, colon);
   let value = colon < 0 ? '' : line.slice(colon + 1);
   if (value.startsWith(' ')) value = value.slice(1);
   if (key === 'event') {
    if (this.event || !/^[A-Z_]{1,64}$/.test(value)) return this.fail('SSE 事件名称缺失、重复或变化');
    this.event = value;
   } else if (key === 'data') {
    this.frameBytes += this.encoder.encode(value).byteLength;
    if (this.frameBytes > 2 * 1024 * 1024) return this.fail('单个响应事件超过限制');
    this.data.push(value);
   } else if (key === 'id') {
    // IDs may repeat, be inherited or reset. No cursor is needed here.
    if (value.length > 256) return this.fail('SSE 事件标识超过长度限制');
   } else if (key !== 'retry') return this.fail('出现未支持的 SSE 字段');
  }
  consume(text, final = false) {
   this.lineBuffer += text;
   while (!this.error) {
    const offset = this.lineBuffer.search(/[\r\n]/);
    if (offset < 0) break;
    if (offset > 1024 * 1024) return this.fail('单行响应超过限制');
    const char = this.lineBuffer[offset];
    if (char === '\r' && offset === this.lineBuffer.length - 1 && !final) break;
    const width = char === '\r' && this.lineBuffer[offset + 1] === '\n' ? 2 : 1;
    const line = this.lineBuffer.slice(0, offset);
    this.lineBuffer = this.lineBuffer.slice(offset + width);
    this.line(line);
   }
   if (this.lineBuffer.length > 1024 * 1024) return this.fail('单行响应超过限制');
  }
  feed(chunk) {
   if (this.error) return this.snapshot();
   if (this.ended) { this.fail('HTTP 结束后仍收到数据'); return this.snapshot(); }
   try {
    const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) { this.fail('响应分片类型无效'); return this.snapshot(); }
    this.bytes += bytes.byteLength;
    if (this.bytes > 8 * 1024 * 1024) { this.fail('网络响应超过 8 MiB 上限'); return this.snapshot(); }
    this.consume(this.decoder.decode(bytes, {stream: true}));
   } catch { this.fail('响应包含无效 UTF-8 数据'); }
   return this.snapshot();
  }
  finish() {
   if (this.ended) return this.snapshot();
   this.ended = true;
   if (!this.error) {
    try { this.consume(this.decoder.decode(), true); } catch { this.fail('响应在 UTF-8 字符中途结束'); }
    if (!this.error && (this.lineBuffer || this.event || this.data.length)) this.fail('响应在 SSE 事件中途结束');
    if (!this.error && (!this.echo || !this.text || !this.blockFinished || !this.messageFinished || !this.messageEnd || !this.answerEnd || !this.terminalEnd)) this.fail('响应未包含完整的回答结束链路');
    if (!this.error && this.calibration && (this.text !== this.options.expectedText || this.brief !== this.options.expectedText)) this.fail('校准回答或摘要与预期标记不一致');
    this.complete = !this.error;
   }
   return this.snapshot();
  }
  snapshot() {
   return {text: this.text, complete: this.complete, error: this.error, ended: this.ended,
    binding: {...this.binding}, profile: copy(this.profile), frames: this.frames, bytes: this.bytes,
    signals: {echo: this.echo, blockFinished: this.blockFinished, messageFinished: this.messageFinished,
     messageEnd: this.messageEnd, answerEnd: this.answerEnd, terminalEnd: this.terminalEnd}};
  }
 }
 return {AnswerStream};
}

module.exports = {createAnswerRuntime};

import { EventEmitter } from 'node:events';

const validId = id => typeof id === 'string' || Number.isSafeInteger(id);
function failure(code, uncertain = false) {
  return Object.assign(new Error(`App-server transport failure: ${code}.`), { code, uncertain });
}

// Wire envelopes follow the locally generated Codex 0.155.1 JSONRPCMessage schema.
// Peer error messages/data are deliberately not copied into diagnostics.
export class AppServerClient extends EventEmitter {
  constructor(readable, writable, { timeoutMs = 30000, maxLineBytes = 1048576, maxPending = 128 } = {}) {
    super();
    for (const value of [timeoutMs, maxLineBytes, maxPending]) {
      if (!Number.isSafeInteger(value) || value < 1) throw failure('INVALID_LIMIT');
    }
    Object.assign(this, { readable, writable, timeoutMs, maxLineBytes, maxPending });
    this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0); this.closed = false;
    readable.on('data', chunk => this.consume(chunk));
    readable.on('end', () => this.die('EOF'));
    readable.on('close', () => this.die('CLOSED'));
    readable.on('error', () => this.die('READ_ERROR'));
    writable.on('error', () => this.die('WRITE_ERROR'));
    writable.on('close', () => this.die('CLOSED'));
  }
  consume(chunk) {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (this.buffer.length + end - start > this.maxLineBytes) return this.die('LINE_LIMIT');
      this.buffer = Buffer.concat([this.buffer, bytes.subarray(start, end)]);
      if (newline < 0) return;
      let message;
      try { message = JSON.parse(this.buffer.toString('utf8')); } catch { return this.die('INVALID_JSON'); }
      this.buffer = Buffer.alloc(0);
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.die('INVALID_MESSAGE');
      const hasId = Object.hasOwn(message, 'id');
      if (hasId && !validId(message.id)) return this.die('INVALID_ID');
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) return this.die('INVALID_MESSAGE');
        const event = { method: message.method, params: message.params };
        if (hasId) this.emit('request', { id: message.id, ...event });
        else { this.emit('notification', event); this.emit('notifications', event); }
      } else {
        const result = Object.hasOwn(message, 'result');
        const error = Object.hasOwn(message, 'error');
        if (!hasId || result === error || (error && (!message.error || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))) return this.die('INVALID_RESPONSE');
        const pending = this.pending.get(message.id);
        if (!pending) return this.die('UNKNOWN_RESPONSE');
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (error) pending.reject(failure('REMOTE_ERROR'));
        else pending.resolve(message.result);
      }
      if (this.closed) return;
      start = newline + 1;
    }
  }
  send(message) {
    if (this.closed) throw failure('CLOSED');
    let line;
    try { line = JSON.stringify(message); } catch { throw failure('INVALID_OUTBOUND'); }
    if (Buffer.byteLength(line) > this.maxLineBytes) throw failure('LINE_LIMIT');
    // A stalled stream must not become an unbounded outbound queue.
    if (this.writable.writableLength > this.maxLineBytes * 2) throw failure('WRITE_BACKPRESSURE');
    try { this.writable.write(`${line}\n`, error => { if (error) this.die('WRITE_ERROR'); }); }
    catch { this.die('WRITE_ERROR'); throw failure('WRITE_ERROR', true); }
  }
  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof method !== 'string' || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(failure('INVALID_REQUEST'));
    if (this.closed) return Promise.reject(failure('CLOSED'));
    if (this.pending.size >= this.maxPending) return Promise.reject(failure('PENDING_LIMIT'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.die('REQUEST_TIMEOUT'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) {
    if (typeof method !== 'string' || !method) throw failure('INVALID_METHOD');
    this.send({ method, params });
  }
  respond(id, result) {
    if (!validId(id) || result === undefined) throw failure('INVALID_RESPONSE');
    this.send({ id, result });
  }
  reject(id, error) {
    if (!validId(id) || !error || !Number.isInteger(error.code) || typeof error.message !== 'string') throw failure('INVALID_RESPONSE');
    this.send({ id, error: { code: error.code, message: error.message } });
  }
  die(code) {
    if (this.closed) return;
    this.closed = true; this.buffer = Buffer.alloc(0);
    const error = failure(code, this.pending.size > 0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('dead', error); this.emit('close', error);
  }
  close() { this.die('CLOSED'); }
}

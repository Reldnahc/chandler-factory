import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { workerPolicy } from '../../runtime/worker-policy.mjs';

const fields = {
  start: ['requestId', 'role', 'revision', 'task'],
  send: ['requestId', 'workerId', 'message'],
  answer: ['requestId', 'workerId', 'questionId', 'answers'],
  observe: ['workerId', 'after', 'limit', 'waitMs'],
  interrupt: ['requestId', 'workerId'], close: ['requestId', 'workerId'], list: [], health: [],
};
const terminal = new Set(['failed', 'closed']);
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const fault = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });
const clean = (s, n = 4000) => String(s ?? '').slice(0, n)
  .replace(/-----BEGIN [\s\S]*?(?:-----END[^\n]*|$)/g, '[redacted key]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[redacted token]')
  .replace(/((?:authorization|access_token|refresh_token|api_key|password)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]');
function text(value, name, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fault('INVALID_INPUT', `Invalid ${name}`);
}
function validate(op, input) {
  if (!Object.hasOwn(fields, op) || !input || Array.isArray(input) || typeof input !== 'object') throw fault('INVALID_INPUT', 'Unknown operation or invalid input');
  if (Object.keys(input).some(k => !fields[op].includes(k))) throw fault('INVALID_INPUT', 'Unexpected input field');
  for (const k of fields[op].filter(k => !['after', 'limit', 'waitMs'].includes(k))) {
    if (!Object.hasOwn(input, k)) throw fault('INVALID_INPUT', `Missing ${k}`);
  }
  for (const k of ['requestId', 'workerId', 'questionId']) if (k in input) text(input[k], k, 128);
  if (op === 'start') {
    workerPolicy(input.role);
    if (!/^[a-f0-9]{40}$/.test(input.revision)) throw fault('INVALID_INPUT', 'revision must be a full lowercase commit SHA');
    text(input.task, 'task');
  }
  if (op === 'send') text(input.message, 'message');
  if (op === 'answer') {
    if (!input.answers || Array.isArray(input.answers) || typeof input.answers !== 'object' || Object.keys(input.answers).length > 20) throw fault('INVALID_INPUT', 'Invalid answers');
    for (const [k, v] of Object.entries(input.answers)) {
      text(k, 'answer key', 128);
      if (!v || Object.keys(v).join() !== 'answers' || !Array.isArray(v.answers) || v.answers.length > 20) throw fault('INVALID_INPUT', 'Each answer must contain an answers array');
      for (const a of v.answers) text(a, 'answer', 4000);
    }
    if (JSON.stringify(input.answers).length > 16000) throw fault('INVALID_INPUT', 'Answers exceed size limit');
  }
  if (op === 'observe') for (const [k, min, max] of [['after', 0, Number.MAX_SAFE_INTEGER], ['limit', 1, 100], ['waitMs', 0, 60000]]) {
    if (k in input && (!Number.isSafeInteger(input[k]) || input[k] < min || input[k] > max)) throw fault('INVALID_INPUT', `Invalid ${k}`);
  }
}

export class WorkerManager {
  constructor({ driver, store, maxWorkers = 4, requestTimeoutMs = 30000 }) {
    if (!driver?.prepare || !store?.load || !store?.save) throw new Error('driver and store are required');
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32 || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('Invalid manager limits');
    this.driver = driver; this.store = store; this.maxWorkers = maxWorkers; this.requestTimeoutMs = requestTimeoutMs;
    this.workers = new Map(); this.requests = new Map(); this.inflight = new Map(); this.preparations = new Set(); this.queues = new Map(); this.events = new EventEmitter();
    this.events.setMaxListeners(256);
    this.waiters = 0; this.stopping = false; this.storageError = false;
    const prior = store.load();
    for (const data of prior.workers) {
      const w = { data, questions: new Map(), retiredTurns: new Set() };
      this.workers.set(data.workerId, w);
      if (data.state !== 'closed') {
        data.state = 'failed'; data.recovery = 'context-lost-explicit-new-assignment-required'; data.uncertain = true;
        data.turnId = null;
        this.event(w, 'recovery', { reason: data.recovery }, false);
      }
    }
    for (const r of prior.requests) {
      if (r.status === 'pending') Object.assign(r, { status: 'error', error: { code: 'UNCERTAIN_RESTART', message: 'Delivery before restart is unknown; request will not be replayed', uncertain: true } });
      this.requests.set(r.requestId, r);
    }
    this.persist();
  }

  persist() {
    try { this.store.save(this.sanitize({ version: 1, workers: [...this.workers.values()].map(w => w.data), requests: [...this.requests.values()] })); }
    catch {
      this.storageError = true;
      // Cleanup must not depend on another successful write to the broken store.
      for (const w of this.workers.values()) {
        w.closing = true;
        if (w.resource) void this.cleanup(w).catch(() => {});
      }
      throw fault('STATE_STORE_FAILED', 'Cannot persist launcher state; launcher must stop');
    }
  }
  sanitize(value) {
    for (const w of this.workers.values()) if (w.resource?.sanitize) {
      const sanitized = w.resource.sanitize(value);
      if (value && typeof value === 'object' && (!sanitized || typeof sanitized !== 'object' || Array.isArray(value) !== Array.isArray(sanitized))) throw fault('SANITIZER_FAILED', 'Driver sanitizer did not preserve metadata shape');
      value = sanitized;
    }
    return value;
  }
  scrub(w, value, max = 4000) { return clean(w.resource?.sanitize ? w.resource.sanitize(String(value ?? '')) : value, max); }
  active(w) { return !terminal.has(w.data.state) || Boolean((w.resource || w.data.recovery) && w.data.cleanup !== 'complete'); }
  event(w, type, detail = {}, persist = true) {
    if (w.resource?.sanitize) detail = w.resource.sanitize(detail);
    const event = { cursor: ++w.data.cursor, type, at: new Date().toISOString(), ...detail };
    w.data.events.push(event);
    w.data.events = w.data.events.slice(-(this.store.maxEvents ?? 200));
    if (persist) this.persist();
    this.events.emit(w.data.workerId);
  }
  view(w) { const { events, ...data } = w.data; return structuredClone(this.sanitize(data)); }
  worker(id) { const w = this.workers.get(id); if (!w) throw fault('UNKNOWN_WORKER', 'Unknown launcher worker'); return w; }
  async dispatch(op, input = {}) {
    validate(op, input);
    if (op === 'health') return { protocol: 'codex-app-server-0.155.1', liveValidated: false, acceptingAssignments: !this.stopping && !this.storageError, activeWorkers: [...this.workers.values()].filter(w => this.active(w)).length, maxWorkers: this.maxWorkers, stateStoreHealthy: !this.storageError };
    if (op === 'list') return { workers: [...this.workers.values()].map(w => {
      const { source, artifacts, runtime, ...summary } = this.view(w);
      return summary;
    }) };
    if (op === 'observe') return this.observe(input);
    const hash = createHash('sha256').update(canonical({ op, input })).digest('hex');
    const existing = this.requests.get(input.requestId);
    if (existing) {
      if (existing.hash !== hash) throw fault('REQUEST_CONFLICT', 'requestId already used for a different operation or payload');
      if (this.inflight.has(input.requestId)) return structuredClone(await this.inflight.get(input.requestId));
      if (existing.status === 'error') throw fault(existing.error.code, existing.error.message, existing.error.uncertain);
      if (existing.status === 'pending') throw fault('UNCERTAIN_DELIVERY', 'Request is pending; it will not be replayed', true);
      return structuredClone(existing.result);
    }
    if (this.stopping || this.storageError) throw fault('UNAVAILABLE', 'Launcher is stopping or state storage failed');
    if (this.requests.size >= (this.store.maxRequests ?? 2000)) throw fault('STATE_CAPACITY', 'Request retention capacity reached; explicit state archival is required');
    const record = { requestId: input.requestId, hash, status: 'pending' };
    this.requests.set(input.requestId, record); this.persist();
    const key = op === 'start' ? input.requestId : input.workerId;
    const promise = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        const result = this.sanitize(await this[op](input));
        Object.assign(record, { status: 'done', result }); this.persist(); return result;
      } catch (error) {
        const safe = this.sanitize({ code: typeof error.code === 'string' ? clean(error.code, 128) : 'OPERATION_FAILED', message: error.code ? clean(this.sanitize(error.message), 500) : 'Worker operation failed', uncertain: Boolean(error.uncertain) });
        Object.assign(record, { status: 'error', error: safe }); this.persist(); throw fault(safe.code, safe.message, safe.uncertain);
      }
    });
    this.queues.set(key, promise); this.inflight.set(input.requestId, promise);
    try { return structuredClone(await promise); }
    finally { this.inflight.delete(input.requestId); if (this.queues.get(key) === promise) this.queues.delete(key); }
  }
  async bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('REQUEST_TIMEOUT', 'Worker request timed out; delivery is uncertain', true)), this.requestTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async rpc(w, method, params) {
    if (w.closing || terminal.has(w.data.state)) throw fault('WORKER_UNAVAILABLE', 'Worker context is unavailable; assign a new worker explicitly');
    try {
      const result = await this.bounded(w.resource.client.request(method, params));
      if (w.closing || terminal.has(w.data.state)) throw fault('WORKER_UNAVAILABLE', 'Worker failed during request', true);
      return result;
    }
    catch (error) { await this.fail(w, error.uncertain ? 'uncertain-delivery' : 'protocol-request-failed'); throw fault(error.code === 'REQUEST_TIMEOUT' ? 'REQUEST_TIMEOUT' : 'WORKER_REQUEST_FAILED', 'Worker request failed; inspect worker status', Boolean(error.uncertain)); }
  }
  async cleanup(w) {
    if (!w.resource || w.cleanup) return w.cleanup;
    w.cleanup = this.bounded(Promise.resolve().then(() => w.resource.close())).then(() => {
      w.data.cleanup = 'complete';
      if (!this.storageError) this.persist();
    }, () => {
      w.data.cleanup = 'failed'; w.data.state = 'failed'; w.cleanup = null;
      if (!this.storageError) this.persist();
      throw fault('CLEANUP_FAILED', 'Worker cleanup failed; explicit close retry is required', true);
    });
    return w.cleanup;
  }
  async fail(w, reason) {
    if (w.data.state === 'closed') return;
    w.data.state = 'failed'; w.data.uncertain = true; w.questions.clear();
    try { this.event(w, 'failed', { reason }); }
    finally { await this.cleanup(w); }
  }
  async start({ role, revision, task }) {
    if (this.workers.size >= 64) throw fault('WORKER_RETENTION_LIMIT', 'Retained worker capacity reached; explicit state archival is required');
    if ([...this.workers.values()].filter(w => this.active(w)).length >= this.maxWorkers) throw fault('WORKER_LIMIT', 'Concurrent worker limit reached');
    const policy = workerPolicy(role);
    const w = { data: { workerId: randomBytes(12).toString('hex'), role, revision, state: 'starting', threadId: null, turnId: null, requested: policy, reported: null, cursor: 0, events: [], artifacts: null, uncertain: false }, questions: new Map(), retiredTurns: new Set(), pendingEvents: [] };
    this.workers.set(w.data.workerId, w); this.event(w, 'starting');
    try {
      const preparation = Promise.resolve().then(() => this.driver.prepare({ workerId: w.data.workerId, role, revision, task }));
      this.preparations.add(preparation);
      preparation.then(() => this.preparations.delete(preparation), () => this.preparations.delete(preparation));
      preparation.then(resource => { if (w.closing || w.data.state === 'failed' || w.data.state === 'closed') { w.resource = resource; void this.cleanup(w).catch(() => {}); } }, error => {
        if (error.resource && !w.resource) {
          w.resource = error.resource;
          try { for (const k of ['source', 'artifacts', 'runtime']) w.data[k] = safeMetadata(this.sanitize(w.resource[k])); }
          catch { /* Ownership is retained even when resource metadata is malformed. */ }
          void this.fail(w, 'late-preparation-cleanup-required').catch(() => {});
        }
      });
      w.resource = await this.bounded(preparation);
      if (this.stopping || this.storageError || w.closing) throw fault('UNAVAILABLE', 'Launcher stopped during worker preparation');
      // Only the trusted driver's bounded metadata is copied; never transport/auth configuration.
      for (const k of ['source', 'artifacts', 'runtime']) w.data[k] = safeMetadata(this.sanitize(w.resource[k]));
      const client = w.resource.client;
      client.on('notification', value => { try { this.notification(w, value); } catch { void this.fail(w, 'invalid-notification').catch(() => {}); } });
      client.on('request', value => { void this.serverRequest(w, value).catch(() => this.fail(w, 'request-routing-failed')).catch(() => {}); });
      // resource.close() intentionally closes the client and emits dead before cleanup completes.
      client.on('dead', () => { if (!w.closing && !terminal.has(w.data.state)) void this.fail(w, 'transport-dead').catch(() => {}); });
      await this.rpc(w, 'initialize', { clientInfo: { name: 'chandler-worker-launcher', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      await this.bounded(Promise.resolve(client.notify('initialized')));
      const started = await this.rpc(w, 'thread/start', { model: policy.model, config: { model_reasoning_effort: policy.effort }, ephemeral: true });
      w.data.reported = { model: typeof started.model === 'string' ? this.scrub(w, started.model, 128) : null, effort: typeof started.reasoningEffort === 'string' ? this.scrub(w, started.reasoningEffort, 32) : null };
      if (started.model !== policy.model || started.reasoningEffort !== policy.effort || typeof started.thread?.id !== 'string' || started.thread.id.length > 128) throw fault('POLICY_MISMATCH', 'Runtime did not confirm the required model and reasoning effort');
      w.data.threadId = started.thread.id; this.event(w, 'configured', { requested: policy, reported: w.data.reported });
      await this.newTurn(w, task); return this.view(w);
    } catch (error) {
      if (error.resource && !w.resource) {
        w.resource = error.resource;
        try { for (const k of ['source', 'artifacts', 'runtime']) w.data[k] = safeMetadata(this.sanitize(w.resource[k])); }
        catch { /* fail() still owns and closes the incomplete preparation. */ }
      }
      await this.fail(w, error.code === 'POLICY_MISMATCH' ? 'policy-mismatch' : 'startup-failed'); throw error;
    }
  }
  async newTurn(w, message) {
    const policy = workerPolicy(w.data.role);
    w.pendingTurn = true; w.data.state = 'working'; w.data.turnId = null; w.pendingEvents = []; this.persist();
    try {
      const result = await this.rpc(w, 'turn/start', { threadId: w.data.threadId, model: policy.model, effort: policy.effort, input: [{ type: 'text', text: message }] });
      const id = result.turn?.id;
      if (typeof id !== 'string' || !id || id.length > 128 || (w.data.turnId && w.data.turnId !== id)) { await this.fail(w, 'invalid-turn-response'); throw fault('PROTOCOL_MISMATCH', 'Invalid turn identity'); }
      if (!w.retiredTurns.has(id) && !terminal.has(w.data.state)) w.data.turnId = id;
      w.pendingTurn = false;
      for (const event of w.pendingEvents.splice(0)) {
        if (event.request) await this.serverRequest(w, event.value);
        else this.notification(w, event.value);
      }
      this.event(w, 'turn-accepted', { turnId: id }); return id;
    } finally { w.pendingTurn = false; }
  }
  async send({ workerId, message }) {
    const w = this.worker(workerId);
    if (terminal.has(w.data.state)) throw fault('WORKER_UNAVAILABLE', 'Worker context is unavailable');
    if (w.data.turnId) {
      const turnId = w.data.turnId;
      await this.rpc(w, 'turn/steer', { threadId: w.data.threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message }] });
      this.event(w, 'message-accepted', { mode: 'steer', turnId }); return { workerId, mode: 'steer', turnId, delivery: 'accepted' };
    }
    const read = await this.rpc(w, 'thread/read', { threadId: w.data.threadId, includeTurns: false });
    const effective = read.thread;
    const policy = workerPolicy(w.data.role);
    if (!effective || effective.id !== w.data.threadId || effective.model !== policy.model || effective.reasoningEffort !== policy.effort) {
      await this.fail(w, 'effective-settings-unconfirmed'); throw fault('POLICY_UNCONFIRMED', 'Thread read did not confirm effective model and reasoning; followup was not started');
    }
    const turnId = await this.newTurn(w, message);
    return { workerId, mode: 'followup', turnId, delivery: 'accepted' };
  }
  async serverRequest(w, { id, method, params }) {
    const client = w.resource.client;
    if (w.closing || terminal.has(w.data.state) || method !== 'item/tool/requestUserInput') {
      await client.reject(id, { code: -32601, message: 'Unsupported worker request; launcher grants no additional access' }); return;
    }
    if (w.pendingTurn) {
      if (w.pendingEvents.length >= 100) throw fault('EVENT_OVERFLOW', 'Early turn event limit exceeded');
      w.pendingEvents.push({ request: true, value: { id, method, params } }); return;
    }
    if (!params || params.threadId !== w.data.threadId || params.turnId !== w.data.turnId || !Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 20 || w.questions.size >= 20) {
      await client.reject(id, { code: -32602, message: 'Stale or invalid question request' }); return;
    }
    if (params.questions.some(q => q?.isSecret)) {
      await client.reject(id, { code: -32602, message: 'Secret input is unsupported' }); return;
    }
    let questions;
    try { questions = params.questions.map(q => {
      text(q.id, 'question id', 128); text(q.question, 'question', 4000);
      if (['constructor', 'prototype', '__proto__'].includes(q.id) || q.id.includes('\0') || Buffer.byteLength(q.id) > 128 || this.scrub(w, q.id, 128) !== q.id) throw fault('INVALID_INPUT', 'Question key cannot be routed safely');
      return { id: q.id, header: this.scrub(w, q.header, 128), question: this.scrub(w, q.question), options: Array.isArray(q.options) ? q.options.slice(0, 20).map(o => ({ label: this.scrub(w, o.label, 200), description: this.scrub(w, o.description, 500) })) : null };
    }); } catch {
      await client.reject(id, { code: -32602, message: 'Invalid question fields' }); return;
    }
    if (new Set(questions.map(q => q.id)).size !== questions.length || Buffer.byteLength(JSON.stringify(questions)) > 24000) {
      await client.reject(id, { code: -32602, message: 'Question payload exceeds launcher bounds or repeats question IDs' }); return;
    }
    const questionId = randomUUID();
    w.questions.set(questionId, { id, turnId: params.turnId, keys: questions.map(q => q.id), blocking: params.isBlocking });
    if (params.isBlocking) w.data.state = 'waiting';
    this.event(w, 'question', { questionId, turnId: params.turnId, questions });
  }
  async answer({ workerId, questionId, answers }) {
    const w = this.worker(workerId); const q = w.questions.get(questionId);
    if (!q || q.turnId !== w.data.turnId || terminal.has(w.data.state)) throw fault('STALE_QUESTION', 'Question is no longer pending');
    if (Object.keys(answers).length !== q.keys.length || !q.keys.every(key => Object.hasOwn(answers, key))) throw fault('INVALID_INPUT', 'Answer keys must exactly match pending questions');
    try { await this.bounded(Promise.resolve(w.resource.client.respond(q.id, { answers }))); }
    catch { await this.fail(w, 'answer-delivery-uncertain'); throw fault('UNCERTAIN_DELIVERY', 'Answer delivery is uncertain; it will not be replayed', true); }
    w.questions.delete(questionId);
    if (w.data.state === 'waiting' && ![...w.questions.values()].some(q => q.blocking)) w.data.state = 'working';
    this.event(w, 'answer-sent', { questionId }); return { workerId, questionId, delivery: 'sent-unacknowledged' };
  }
  notification(w, { method, params: p }) {
    if (w.closing || terminal.has(w.data.state) || !p || p.threadId !== w.data.threadId) return;
    if (w.pendingTurn) {
      if (w.pendingEvents.length >= 100) throw fault('EVENT_OVERFLOW', 'Early turn event limit exceeded');
      w.pendingEvents.push({ request: false, value: { method, params: p } }); return;
    }
    if (method === 'serverRequest/resolved') {
      for (const [key, q] of w.questions) if (q.id === p.requestId) w.questions.delete(key);
      if (w.data.state === 'waiting' && ![...w.questions.values()].some(q => q.blocking)) w.data.state = 'working';
      this.event(w, 'question-resolved'); return;
    }
    const turnId = p.turnId ?? p.turn?.id;
    if (!turnId || turnId !== w.data.turnId || w.retiredTurns.has(turnId)) return;
    if (method === 'turn/completed') {
      const status = p.turn.status;
      if (!['completed', 'interrupted', 'failed'].includes(status)) return;
      w.retiredTurns.add(turnId); w.data.turnId = null; w.questions.clear();
      w.data.state = status === 'completed' ? 'idle' : status;
      this.event(w, 'turn-completed', { turnId, status, artifacts: w.data.artifacts });
      if (status === 'failed') void this.cleanup(w).catch(() => {});
    } else if (method === 'item/agentMessage/delta') {
      // Individual deltas cannot safely redact a credential split across packets.
      this.event(w, 'agent-progress', { turnId });
    } else if (method === 'item/completed' || method === 'item/started') {
      const item = p.item;
      if (!item || typeof item.type !== 'string') return;
      if (item.type === 'agentMessage' && method === 'item/completed') this.event(w, 'agent-message-final', { turnId, text: this.scrub(w, item.text) });
      else this.event(w, 'tool-progress', { turnId, phase: method === 'item/started' ? 'started' : 'completed', kind: this.scrub(w, item.type, 80), itemId: this.scrub(w, item.id, 128) });
    }
  }
  async interrupt({ workerId }) {
    const w = this.worker(workerId);
    if (!w.data.turnId || terminal.has(w.data.state)) return { workerId, acknowledged: false, state: w.data.state };
    const turnId = w.data.turnId;
    await this.rpc(w, 'turn/interrupt', { threadId: w.data.threadId, turnId });
    this.event(w, 'interrupt-acknowledged', { turnId });
    return { workerId, acknowledged: true, terminationConfirmed: w.data.state === 'interrupted', state: w.data.state };
  }
  async close({ workerId }) {
    const w = this.worker(workerId);
    if (w.data.state === 'closed') return this.view(w);
    if (!w.resource && w.data.recovery && w.data.cleanup !== 'complete') throw fault('RECOVERY_CLEANUP_REQUIRED', 'Prior worker resources have unknown ownership state; explicit operator cleanup is required', true);
    w.closing = true; w.questions.clear();
    await this.cleanup(w);
    w.data.state = 'closed'; this.event(w, 'closed', { terminationConfirmed: Boolean(w.resource && w.data.cleanup === 'complete') });
    return this.view(w);
  }
  async observe({ workerId, after = 0, limit = 50, waitMs = 0 }) {
    const w = this.worker(workerId);
    if (after > w.data.cursor) throw fault('INVALID_CURSOR', 'Cursor is ahead of this worker');
    if (waitMs && after === w.data.cursor && !terminal.has(w.data.state)) {
      if (this.waiters >= 128) throw fault('WAITER_LIMIT', 'Too many observers');
      this.waiters++;
      try { await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); this.events.off(workerId, done); resolve(); };
        this.events.on(workerId, done); timer = setTimeout(done, waitMs);
      }); } finally { this.waiters--; }
    }
    const selected = [];
    let bytes = Buffer.byteLength(JSON.stringify(this.view(w)));
    for (const event of w.data.events.filter(e => e.cursor > after)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (selected.length >= limit || bytes + size > 64000) break;
      selected.push(event); bytes += size;
    }
    return { worker: this.view(w), events: structuredClone(selected), nextCursor: selected.at(-1)?.cursor ?? after, oldestCursor: w.data.events[0]?.cursor ?? w.data.cursor, truncated: Boolean(w.data.events.length && after < w.data.events[0].cursor - 1) };
  }
  async shutdown() {
    this.stopping = true;
    const results = await Promise.allSettled([...this.workers.values()].map(w => this.close({ workerId: w.data.workerId })));
    // Keep the ownership lock until all mutation chains have finished storing results.
    await Promise.allSettled([...this.inflight.values()]);
    try { await this.bounded(Promise.allSettled([...this.preparations])); }
    catch { throw fault('SHUTDOWN_FAILED', 'Worker preparation is still pending; retain state ownership and retry shutdown', true); }
    const cleanupResults = await Promise.allSettled([...this.workers.values()].filter(w => w.resource).map(w => this.cleanup(w)));
    if ([...results, ...cleanupResults].some(r => r.status === 'rejected')) throw fault('SHUTDOWN_FAILED', 'Some worker resources could not be confirmed stopped; retry shutdown explicitly', true);
    this.store.close?.();
  }
}

function safeMetadata(value, depth = 0) {
  if (depth > 4 || value === undefined) return null;
  if (typeof value === 'string') return clean(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(v => safeMetadata(v, depth + 1));
  if (typeof value !== 'object') return null;
  const result = Object.fromEntries(Object.entries(value).slice(0, 40).filter(([k]) => !/token|auth|secret|password|credential|environment|env/i.test(k)).map(([k, v]) => [clean(k, 100), safeMetadata(v, depth + 1)]));
  return Buffer.byteLength(JSON.stringify(result)) > 8000 ? { omitted: 'metadata exceeds byte limit' } : result;
}

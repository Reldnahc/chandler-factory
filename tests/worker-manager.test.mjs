import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../scripts/lib/worker-manager.mjs';
import { AppServerClient } from '../scripts/lib/app-server-client.mjs';
import { FileWorkerStore, MemoryWorkerStore } from '../scripts/lib/worker-store.mjs';

const revision = 'a'.repeat(40);
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const clients = []; const resources = [];
  const driver = { async prepare({ role, workerId }) {
    const c = new AppServerClient(new PassThrough(), new PassThrough()); c.calls = []; c.responses = []; c.rejections = []; c.turn = 0;
    c.role = role; c.thread = `thread-${workerId}`; c.effort = role === 'reviewer' ? 'high' : 'medium';
    c.notify = () => {};
    c.respond = (id, result) => c.responses.push({ id, result });
    c.reject = (id, error) => c.rejections.push({ id, error });
    c.request = async (method, params) => {
      c.calls.push({ method, params });
      if (options.handle) { const v = options.handle(c, method, params); if (v !== undefined) return v; }
      if (method === 'thread/start') return { model: options.mismatch ? 'wrong' : 'gpt-6-astra', reasoningEffort: c.effort, thread: { id: c.thread } };
      if (method === 'thread/read') return { thread: { id: c.thread, model: 'gpt-6-astra', reasoningEffort: c.effort } };
      if (method === 'turn/start') return { turn: { id: `turn-${++c.turn}`, status: 'inProgress' } };
      return {};
    };
    c.note = (method, p) => c.emit('notification', { method, params: { threadId: c.thread, ...p } });
    const r = { client: c, source: { revision }, artifacts: { workspace: '/trusted/work' }, runtime: { version: 'fixture' }, closes: 0,
      sanitize: v => JSON.parse(JSON.stringify(v).replaceAll('fixture-secret', '[redacted]')),
      async close() { this.closes++; c.close(); if (options.closeFail) throw new Error('secret error'); } };
    clients.push(c); resources.push(r); return r;
  } };
  const store = options.store ?? new MemoryWorkerStore(options);
  const manager = new WorkerManager({ driver, store, maxWorkers: options.maxWorkers ?? 4, requestTimeoutMs: options.requestTimeoutMs ?? 100 });
  const start = (requestId = 'start', role = 'implementation') => manager.dispatch('start', { requestId, role, revision, task: 'private assignment' });
  return { manager, clients, resources, store, start, driver };
}

test('fixed policy, role independence, questions, steering and same-thread continuation', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.start('a'), h.start('b', 'reviewer')]);
  assert.notEqual(a.workerId, b.workerId); assert.equal(a.requested.effort, 'medium'); assert.equal(b.reported.effort, 'high');
  const c = h.clients[0];
  c.emit('request', { id: 44, method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: a.turnId, isBlocking: true, itemId: 'q', questions: [{ id: 'choice', header: 'Choice', question: 'Which fixture-secret?' }] } });
  await tick();
  const seen = await h.manager.dispatch('observe', { workerId: a.workerId });
  const question = seen.events.find(e => e.type === 'question');
  assert.equal(seen.worker.state, 'waiting'); assert.match(question.questions[0].question, /redacted/);
  await h.manager.dispatch('answer', { requestId: 'answer', workerId: a.workerId, questionId: question.questionId, answers: { choice: { answers: ['private answer'] } } });
  assert.deepEqual(c.responses[0], { id: 44, result: { answers: { choice: { answers: ['private answer'] } } } });
  assert.equal((await h.manager.dispatch('send', { requestId: 'steer', workerId: a.workerId, message: 'private correction' })).mode, 'steer');
  c.note('turn/completed', { turn: { id: a.turnId, status: 'completed' } });
  assert.equal((await h.manager.dispatch('list')).workers[0].state, 'idle');
  const follow = await h.manager.dispatch('send', { requestId: 'follow', workerId: a.workerId, message: 'private followup' });
  assert.equal(follow.mode, 'followup'); assert.equal(c.calls.filter(x => x.method === 'thread/start').length, 1);
  for (const call of c.calls.filter(x => x.method === 'turn/start')) { assert.equal(call.params.model, 'gpt-6-astra'); assert.equal(call.params.effort, 'medium'); }
  const saved = JSON.stringify(h.store.load());
  for (const secret of ['private assignment', 'private answer', 'private correction', 'private followup', 'fixture-secret']) assert.ok(!saved.includes(secret));
  await h.manager.shutdown();
});

test('idempotent duplicates and conflict, including persisted restart without relaunch', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.start(), h.start()]); assert.deepEqual(a, b); assert.equal(h.clients.length, 1);
  await assert.rejects(h.start('start', 'reviewer'), { code: 'REQUEST_CONFLICT' });
  const next = new WorkerManager({ driver: h.driver, store: h.store });
  assert.deepEqual(await next.dispatch('start', { requestId: 'start', role: 'implementation', revision, task: 'private assignment' }), a);
  assert.equal(h.clients.length, 1);
  const lost = (await next.dispatch('list')).workers[0]; assert.equal(lost.state, 'failed'); assert.match(lost.recovery, /context-lost/);
  await h.manager.shutdown();
});

test('restart pending write is uncertain and never replayed', async () => {
  const h = harness({ handle: (c, m) => m === 'turn/start' ? new Promise(() => {}) : undefined, requestTimeoutMs: 20 });
  const launch = h.start();
  await tick();
  const store = new MemoryWorkerStore(); store.save(h.store.load());
  const next = new WorkerManager({ driver: h.driver, store });
  await assert.rejects(next.dispatch('start', { requestId: 'start', role: 'implementation', revision, task: 'private assignment' }), { code: 'UNCERTAIN_RESTART', uncertain: true });
  await assert.rejects(launch, { code: 'REQUEST_TIMEOUT' }); assert.equal(h.clients.length, 1); assert.equal(h.resources[0].closes, 1);
});

test('policy mismatch blocks first turn; unavailable effective settings block followup', async () => {
  const h = harness({ mismatch: true }); await assert.rejects(h.start(), { code: 'POLICY_MISMATCH' });
  assert.equal(h.clients[0].calls.some(c => c.method === 'turn/start'), false); assert.equal(h.resources[0].closes, 1);
  const h2 = harness({ handle: (c, m) => m === 'thread/read' ? { thread: { id: c.thread, model: null, reasoningEffort: null } } : undefined });
  const w = await h2.start(); h2.clients[0].note('turn/completed', { turn: { id: w.turnId, status: 'completed' } });
  await assert.rejects(h2.manager.dispatch('send', { requestId: 'f', workerId: w.workerId, message: 'continue' }), { code: 'POLICY_UNCONFIRMED' });
  assert.equal(h2.clients[0].calls.filter(c => c.method === 'turn/start').length, 1);
});

test('interruption acknowledgement is distinct, stale events cannot finish another turn', async () => {
  const h = harness(); const w = await h.start(); const c = h.clients[0];
  const ack = await h.manager.dispatch('interrupt', { requestId: 'i', workerId: w.workerId });
  assert.equal(ack.acknowledged, true); assert.equal(ack.terminationConfirmed, false); assert.equal(ack.state, 'working');
  c.note('turn/completed', { turn: { id: w.turnId, status: 'interrupted' } });
  assert.equal((await h.manager.dispatch('list')).workers[0].state, 'interrupted');
  const follow = await h.manager.dispatch('send', { requestId: 'f', workerId: w.workerId, message: 'continue' });
  c.note('turn/completed', { turn: { id: w.turnId, status: 'completed' } });
  assert.equal((await h.manager.dispatch('list')).workers[0].turnId, follow.turnId);
  await h.manager.shutdown();
});

test('long observers do not block messages, retained cursor gaps are explicit', async () => {
  const h = harness({ maxEvents: 3 }); const w = await h.start();
  const before = await h.manager.dispatch('observe', { workerId: w.workerId });
  const wait = h.manager.dispatch('observe', { workerId: w.workerId, after: before.worker.cursor, waitMs: 1000 });
  await h.manager.dispatch('send', { requestId: 's', workerId: w.workerId, message: 'continue' });
  assert.equal((await wait).events[0].type, 'message-accepted');
  for (let i = 0; i < 5; i++) h.clients[0].note('item/agentMessage/delta', { turnId: w.turnId, delta: `update ${i}` });
  const seen = await h.manager.dispatch('observe', { workerId: w.workerId }); assert.equal(seen.truncated, true); assert.equal(seen.events.length, 3);
  await h.manager.shutdown();
});

test('unsupported approval, secret input and resolved questions are never answered', async () => {
  const h = harness(); const w = await h.start(); const c = h.clients[0];
  const params = { threadId: c.thread, turnId: w.turnId, itemId: 'q', isBlocking: true, questions: [{ id: 'x', question: 'secret?', isSecret: true }] };
  c.emit('request', { id: 1, method: 'item/commandExecution/requestApproval', params });
  c.emit('request', { id: 2, method: 'item/tool/requestUserInput', params });
  await tick(); assert.equal(c.rejections.length, 2); assert.equal(c.responses.length, 0);
  params.questions[0].isSecret = false; c.emit('request', { id: 3, method: 'item/tool/requestUserInput', params }); await tick();
  const q = (await h.manager.dispatch('observe', { workerId: w.workerId })).events.find(e => e.type === 'question');
  c.note('serverRequest/resolved', { requestId: 3 });
  await assert.rejects(h.manager.dispatch('answer', { requestId: 'ans', workerId: w.workerId, questionId: q.questionId, answers: { x: { answers: ['yes'] } } }), { code: 'STALE_QUESTION' });
  await h.manager.shutdown();
});

test('intentional close completes without transport failure or manufactured uncertainty', async () => {
  const h = harness(); const w = await h.start(); const deaths = [];
  h.clients[0].on('dead', error => deaths.push(error.code));
  const closed = await h.manager.dispatch('close', { requestId: 'close', workerId: w.workerId });
  assert.deepEqual(deaths, ['CLOSED']);
  assert.equal(closed.state, 'closed'); assert.equal(closed.cleanup, 'complete'); assert.equal(closed.uncertain, false);
  const seen = await h.manager.dispatch('observe', { workerId: w.workerId });
  assert.equal(seen.events.some(e => e.type === 'failed'), false);
  assert.equal(seen.events.at(-1).type, 'closed'); assert.equal(h.resources[0].closes, 1);
  assert.equal(h.store.load().workers[0].uncertain, false);
});

test('transport death closes resources; late messages are ignored and explicit close retains uncertainty', async () => {
  const h = harness(); const w = await h.start(); const c = h.clients[0];
  c.emit('dead', new Error('secret packet')); await tick();
  const before = (await h.manager.dispatch('list')).workers[0]; assert.equal(before.state, 'failed'); assert.equal(h.resources[0].closes, 1);
  c.note('item/agentMessage/delta', { turnId: w.turnId, delta: 'late' });
  assert.equal((await h.manager.dispatch('list')).workers[0].cursor, before.cursor);
  assert.equal(before.uncertain, true);
  const closed = await h.manager.dispatch('close', { requestId: 'close', workerId: w.workerId });
  assert.equal(closed.state, 'closed'); assert.equal(closed.cleanup, 'complete'); assert.equal(closed.uncertain, true);
  const seen = await h.manager.dispatch('observe', { workerId: w.workerId });
  assert.deepEqual(seen.events.filter(e => e.type === 'failed').map(e => e.reason), ['transport-dead']);
});

test('cleanup failure stays failed, consumes capacity, allows explicit close retry', async () => {
  const opts = { closeFail: true, maxWorkers: 1 }; const h = harness(opts); const w = await h.start();
  await assert.rejects(h.manager.dispatch('close', { requestId: 'c', workerId: w.workerId }), { code: 'CLEANUP_FAILED', uncertain: true });
  assert.equal((await h.manager.dispatch('list')).workers[0].cleanup, 'failed');
  const seen = await h.manager.dispatch('observe', { workerId: w.workerId });
  assert.equal(seen.worker.state, 'failed');
  assert.equal(seen.events.some(e => e.type === 'failed' && e.reason === 'transport-dead'), false);
  await assert.rejects(h.start('another'), { code: 'WORKER_LIMIT' });
  await assert.rejects(h.manager.shutdown(), { code: 'SHUTDOWN_FAILED' });
  opts.closeFail = false;
  await h.manager.shutdown(); assert.equal((await h.manager.dispatch('list')).workers[0].state, 'closed');
});

test('field allowlists, concurrent capacity and request retention bound', async () => {
  const h = harness({ maxWorkers: 1, maxRequests: 3 });
  await assert.rejects(h.manager.dispatch('start', { requestId: 'x', role: 'implementation', revision, task: 'x', model: 'override' }), { code: 'INVALID_INPUT' });
  const [a, b] = await Promise.allSettled([h.start('one'), h.start('two')]); assert.equal(a.status, 'fulfilled'); assert.equal(b.reason.code, 'WORKER_LIMIT');
  await h.manager.dispatch('close', { requestId: 'close', workerId: a.value.workerId });
  await assert.rejects(h.start('four'), { code: 'STATE_CAPACITY' });
});

test('FileWorkerStore roundtrip, exclusive lock, release and corrupt state fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-store-'));
  try {
    const a = new FileWorkerStore({ directory }); assert.throws(() => new FileWorkerStore({ directory }), /locked/);
    a.save({ version: 1, workers: [], requests: [{ requestId: 'one' }] }); a.close();
    const b = new FileWorkerStore({ directory }); assert.equal(b.load().requests[0].requestId, 'one'); b.close();
    fs.writeFileSync(path.join(directory, 'workers.json'), '{broken');
    const c = new FileWorkerStore({ directory }); assert.throws(() => c.load()); c.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('state write failure independently cleans up owned process', async () => {
  const h = harness(); const w = await h.start();
  h.store.save = () => { throw new Error('disk full'); };
  h.clients[0].note('item/agentMessage/delta', { turnId: w.turnId, delta: 'new' });
  await tick(); assert.equal(h.resources[0].closes, 1);
  assert.equal((await h.manager.dispatch('health')).stateStoreHealthy, false);
});

test('whole-message sanitation covers routing metadata, policy reports and split deltas', async () => {
  const h = harness({ handle: (c, method) => {
    if (method === 'thread/start') { c.thread = 'fixture-secret'; return { model: 'gpt-6-astra', reasoningEffort: c.effort, thread: { id: c.thread } }; }
    if (method === 'turn/start') return { turn: { id: 'fixture-secret' } };
  } });
  const w = await h.start(); assert.equal(w.threadId, '[redacted]'); assert.equal(w.turnId, '[redacted]');
  const c = h.clients[0];
  c.note('item/agentMessage/delta', { turnId: 'fixture-secret', delta: 'fixture-' });
  c.note('item/agentMessage/delta', { turnId: 'fixture-secret', delta: 'secret' });
  c.note('item/completed', { turnId: 'fixture-secret', item: { id: 'item', type: 'agentMessage', text: `${'a'.repeat(3995)}fixture-secret` } });
  const seen = await h.manager.dispatch('observe', { workerId: w.workerId });
  assert.ok(seen.events.filter(e => e.type === 'agent-progress').every(e => !('text' in e)));
  assert.ok(!JSON.stringify(seen).includes('fixture-secret')); assert.ok(!JSON.stringify(h.store.load()).includes('fixture-secret'));
  await h.manager.shutdown();
  const bad = harness({ handle: (c, m) => m === 'thread/start' ? { model: 'fixture-secret', reasoningEffort: c.effort, thread: { id: c.thread } } : undefined });
  await assert.rejects(bad.start(), { code: 'POLICY_MISMATCH' }); assert.ok(!JSON.stringify(bad.store.load()).includes('fixture-secret'));
});

test('question and resolution arriving before turn acknowledgement preserve order', async () => {
  const h = harness({ handle: (c, method) => {
    if (method !== 'turn/start') return;
    c.emit('request', { id: 9, method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: 'early', isBlocking: true, itemId: 'q', questions: [{ id: 'choice', question: 'Which?' }] } });
    c.note('turn/started', { turn: { id: 'early', status: 'inProgress' } });
    c.note('serverRequest/resolved', { requestId: 9 });
    return { turn: { id: 'early' } };
  } });
  const w = await h.start(); const seen = await h.manager.dispatch('observe', { workerId: w.workerId });
  assert.equal(seen.worker.state, 'working');
  const q = seen.events.find(e => e.type === 'question');
  await assert.rejects(h.manager.dispatch('answer', { requestId: 'a', workerId: w.workerId, questionId: q.questionId, answers: { choice: { answers: ['x'] } } }), { code: 'STALE_QUESTION' });
  await h.manager.shutdown();
});

test('partial preparation cleanup handle is retained and can be retried', async () => {
  const store = new MemoryWorkerStore(); let attempts = 0;
  const resource = { close: async () => { if (++attempts < 2) throw new Error('still owned'); }, runtime: { containerName: 'owned' } };
  const manager = new WorkerManager({ store, driver: { prepare: async () => { throw Object.assign(new Error('prepare failed'), { code: 'PREPARATION_CLEANUP_INCOMPLETE', resource }); } } });
  await assert.rejects(manager.dispatch('start', { requestId: 's', role: 'implementation', revision, task: 'x' }), { code: 'CLEANUP_FAILED' });
  const w = (await manager.dispatch('list')).workers[0]; assert.equal(w.cleanup, 'failed');
  const closed = await manager.dispatch('close', { requestId: 'c', workerId: w.workerId }); assert.equal(closed.state, 'closed'); assert.equal(attempts, 2);
});

test('oversized questions reject without waiting and observe pages stay byte bounded', async () => {
  const h = harness(); const w = await h.start(); const c = h.clients[0];
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: 'x'.repeat(4000), options: Array.from({ length: 20 }, () => ({ label: 'x'.repeat(200), description: 'x'.repeat(500) })) }));
  c.emit('request', { id: 20, method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: w.turnId, itemId: 'q', isBlocking: true, questions } });
  await tick(); assert.equal(c.rejections.length, 1); assert.equal((await h.manager.dispatch('list')).workers[0].state, 'working');
  for (let i = 0; i < 50; i++) c.note('item/completed', { turnId: w.turnId, item: { id: 'i', type: 'agentMessage', text: '😀'.repeat(2000) } });
  let after = 0; let count = 0;
  do {
    const page = await h.manager.dispatch('observe', { workerId: w.workerId, after, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 66000);
    after = page.nextCursor; count += page.events.length;
  } while (after < (await h.manager.dispatch('list')).workers[0].cursor);
  assert.ok(count >= 50); await h.manager.shutdown();
});

test('early question followed by completion cannot resurrect waiting state', async () => {
  const h = harness({ handle: (c, method) => {
    if (method !== 'turn/start') return;
    c.emit('request', { id: 9, method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: 'early', isBlocking: true, itemId: 'q', questions: [{ id: 'choice', question: 'Which?' }] } });
    c.note('turn/started', { turn: { id: 'early' } }); c.note('turn/completed', { turn: { id: 'early', status: 'completed' } });
    return { turn: { id: 'early' } };
  } });
  const w = await h.start(); assert.equal(w.state, 'idle'); assert.equal(w.turnId, null);
  await h.manager.shutdown();
});

test('late failed preparation retains cleanup ownership after request timeout', async () => {
  let failPreparation; let shouldFail = true; let closed = 0;
  const resource = { sanitize: value => value, close: async () => { closed++; if (shouldFail) throw new Error('cleanup blocked'); } };
  const manager = new WorkerManager({ driver: { prepare: () => new Promise((_, reject) => { failPreparation = reject; }) }, store: new MemoryWorkerStore(), requestTimeoutMs: 10 });
  await assert.rejects(manager.dispatch('start', { requestId: 's', role: 'implementation', revision, task: 'x' }), { code: 'REQUEST_TIMEOUT' });
  failPreparation(Object.assign(new Error('prepare failed'), { code: 'PREPARATION_CLEANUP_INCOMPLETE', resource }));
  await tick(); assert.equal(closed, 1);
  const w = (await manager.dispatch('list')).workers[0]; assert.equal(w.cleanup, 'failed');
  shouldFail = false; await manager.dispatch('close', { requestId: 'c', workerId: w.workerId }); assert.equal(closed, 2);
});

test('recovery with possible surviving resources does not pretend close or free capacity', async () => {
  const h = harness(); await h.start();
  const recovery = new WorkerManager({ driver: h.driver, store: h.store, maxWorkers: 1 });
  const w = (await recovery.dispatch('list')).workers[0];
  await assert.rejects(recovery.dispatch('close', { requestId: 'c', workerId: w.workerId }), { code: 'RECOVERY_CLEANUP_REQUIRED' });
  await assert.rejects(recovery.dispatch('start', { requestId: 'new', role: 'implementation', revision, task: 'x' }), { code: 'WORKER_LIMIT' });
  await h.manager.shutdown();
});

test('unanswerable reserved, multibyte, duplicate and secret question keys reject', async () => {
  const h = harness(); const w = await h.start(); const c = h.clients[0];
  for (const key of ['constructor', 'prototype', '__proto__', 'nul\0key', 'é'.repeat(100), 'fixture-secret']) {
    c.emit('request', { id: key, method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: w.turnId, itemId: 'q', isBlocking: true, questions: [{ id: key, question: 'Choose?' }] } });
  }
  c.emit('request', { id: 'duplicate', method: 'item/tool/requestUserInput', params: { threadId: c.thread, turnId: w.turnId, itemId: 'q', isBlocking: true, questions: [{ id: 'same', question: 'A?' }, { id: 'same', question: 'B?' }] } });
  await tick(); assert.equal(c.rejections.length, 7); assert.equal((await h.manager.dispatch('list')).workers[0].state, 'working');
  await h.manager.shutdown();
});

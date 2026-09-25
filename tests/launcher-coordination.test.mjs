import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../scripts/lib/app-server-client.mjs';
import { WorkerManager } from '../scripts/lib/worker-manager.mjs';
import { MemoryWorkerStore } from '../scripts/lib/worker-store.mjs';
import { createHandler } from '../scripts/lib/launcher-interface.mjs';

const revision = 'a'.repeat(40);
const fixture = fileURLToPath(new URL('./fixtures/app-server-fixture.mjs', import.meta.url));
let sequence = 0;
const requestId = () => `acceptance-${++sequence}`;

function harness(t, mode = 'normal', timeoutMs = 2000) {
  const peers = new Map();
  const driver = { async prepare({ workerId, role }) {
    const child = spawn(process.execPath, [fixture, role, mode, workerId], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      // Do not pass the host's environment/credentials to the fixture.
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const replies = new Map();
    const wireLog = [];
    child.on('message', message => {
      if (message.event === 'wire') wireLog.push(message.message);
      if (replies.has(message.token)) { replies.get(message.token)(message); replies.delete(message.token); }
    });
    const peer = {
      child, wireLog,
      async control(command) {
        const token = requestId();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { replies.delete(token); reject(new Error(`Fixture control timeout: ${command}; ${stderr}`)); }, 3000);
          replies.set(token, value => { clearTimeout(timer); resolve(value); });
          child.send({ token, command });
        });
      },
    };
    peers.set(workerId, peer);
    const client = new AppServerClient(child.stdout, child.stdin, { timeoutMs });
    return {
      client, source: { revision, workspace: `/fixture/${workerId}` },
      artifacts: { directory: `/fixture-output/${workerId}` },
      runtime: { kind: 'deterministic-node-fixture', id: workerId },
      sanitize: value => value,
      async close() {
        client.close();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill(); await exited;
        }
      },
    };
  } };
  const manager = new WorkerManager({ driver, store: new MemoryWorkerStore(), maxWorkers: 4, requestTimeoutMs: timeoutMs });
  t.after(async () => {
    await manager.shutdown();
    for (const { child } of peers.values()) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  });
  return { manager, peers, dispatch: (op, input = {}) => manager.dispatch(op, input) };
}

// Small schema evaluator sufficient for the generated protocol structures used
// here; the schema corpus remains an optional, uncommitted local reference.
function matches(value, schema, root = schema) {
  if (schema.$ref) return matches(value, schema.$ref.slice(2).split('/').reduce((o, k) => o[k], root), root);
  if (schema.allOf && !schema.allOf.every(s => matches(value, s, root))) return false;
  if (schema.anyOf && !schema.anyOf.some(s => matches(value, s, root))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => matches(value, s, root)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![schema.type].flat().some(t => t === type || (t === 'integer' && Number.isInteger(value)))) return false;
  if (type === 'object') {
    if ((schema.required ?? []).some(k => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k] && !matches(v, schema.properties[k], root)) return false;
      if (!schema.properties?.[k] && schema.additionalProperties === false) return false;
      if (!schema.properties?.[k] && typeof schema.additionalProperties === 'object' && !matches(v, schema.additionalProperties, root)) return false;
    }
  }
  if (type === 'array' && schema.items && !value.every(v => matches(v, schema.items, root))) return false;
  return true;
}

async function schemaWire(t, log) {
  let schema;
  try { schema = JSON.parse(await readFile(new URL('../.local/launcher-protocol-0.155.1/ClientRequest.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { t.diagnostic('Generated CLI 0.155.1 schema unavailable; local schema cross-check omitted.'); return; } throw error; }
  for (const message of log.filter(m => m.method && Object.hasOwn(m, 'id'))) {
    assert.ok(matches(message, schema), `CLI 0.155.1 schema rejects ${JSON.stringify(message)}`);
  }
}

async function until(h, workerId, predicate) {
  let after = 0;
  const all = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await h.dispatch('observe', { workerId, after, limit: 100, waitMs: 250 });
    all.push(...result.events);
    if (predicate(result, all)) return { ...result, events: all };
    after = result.nextCursor;
  }
  assert.fail(`Expected worker condition not observed: ${JSON.stringify(all)}`);
}
const start = (h, role) => h.dispatch('start', { requestId: requestId(), role, revision, task: `Bounded ${role} fixture task` });
const mutation = (h, op, workerId, extra = {}) => h.dispatch(op, { requestId: requestId(), workerId, ...extra });

for (const role of ['implementation', 'reviewer']) test(`${role}: configured question, answer, active steering, result and same-thread followup`, async t => {
  const h = harness(t);
  const worker = await start(h, role);
  assert.match(worker.workerId, /^[a-f0-9]{24}$/);
  const effort = role === 'reviewer' ? 'high' : 'medium';
  assert.deepEqual(worker.requested, { model: 'gpt-6-astra', effort });
  assert.deepEqual(worker.reported, { model: 'gpt-6-astra', effort });
  const waiting = await until(h, worker.workerId, r => r.worker.state === 'waiting');
  const question = waiting.events.find(e => e.type === 'question');
  assert.ok(question?.questionId);
  assert.equal(waiting.events.some(e => e.type === 'turn-completed'), false);
  const peer = h.peers.get(worker.workerId);
  assert.equal((await peer.control('snapshot')).answered, false);
  await mutation(h, 'answer', worker.workerId, { questionId: question.questionId, answers: { q: { answers: [`answer-${role}`] } } });
  await until(h, worker.workerId, (_, events) => events.some(e => e.type === 'agent-message-final' && e.text === `${role}:answer-acknowledged`));
  const steer = await mutation(h, 'send', worker.workerId, { message: 'Correct the active result' });
  assert.equal(steer.mode, 'steer');
  await peer.control('complete');
  const done = await until(h, worker.workerId, r => r.worker.state === 'idle');
  assert.ok(done.events.some(e => e.type === 'agent-message-final' && e.text === `${role}:result:1`));
  assert.ok(done.events.some(e => e.type === 'turn-completed' && e.status === 'completed'));
  const followup = await mutation(h, 'send', worker.workerId, { message: 'Continue the same assignment' });
  assert.equal(followup.mode, 'followup');
  await peer.control('complete');
  await until(h, worker.workerId, r => r.worker.state === 'idle' && r.events.some(e => e.type === 'turn-completed' && e.turnId === followup.turnId));
  const { log, threadId } = await peer.control('snapshot');
  assert.equal(threadId, worker.threadId);
  const creations = log.filter(m => m.method === 'thread/start');
  assert.equal(creations.length, 1);
  assert.equal(creations[0].params.model, 'gpt-6-astra');
  assert.equal(creations[0].params.config.model_reasoning_effort, effort);
  const turns = log.filter(m => m.method === 'turn/start');
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.equal(turn.params.model, 'gpt-6-astra'); assert.equal(turn.params.effort, effort);
    assert.equal(turn.params.threadId, worker.threadId);
  }
  const steered = log.find(m => m.method === 'turn/steer');
  assert.equal(steered.params.expectedTurnId, steer.turnId);
  assert.equal(steered.params.threadId, worker.threadId);
  assert.deepEqual(log.find(m => m.id === `question-${worker.workerId}`).result, { answers: { q: { answers: [`answer-${role}`] } } });
  await schemaWire(t, log);
});

for (const mode of ['wrong-model', 'wrong-effort', 'missing-model', 'missing-effort']) test(`${mode}: reject before first model turn`, async t => {
  const h = harness(t, mode);
  await assert.rejects(start(h, 'implementation'), { code: 'POLICY_MISMATCH' });
  assert.equal(h.peers.size, 1);
  const peer = [...h.peers.values()][0];
  assert.equal(peer.wireLog.filter(m => m.method === 'thread/start').length, 1);
  assert.equal(peer.wireLog.some(m => m.method === 'turn/start'), false);
  assert.equal((await h.dispatch('list')).workers[0].state, 'failed');
});

test('concurrent workers keep questions, answers, output and waiters separate', async t => {
  const h = harness(t);
  const [implementer, reviewer] = await Promise.all([start(h, 'implementation'), start(h, 'reviewer')]);
  assert.notEqual(implementer.workerId, reviewer.workerId);
  assert.notEqual(implementer.threadId, reviewer.threadId);
  assert.notEqual(implementer.source.workspace, reviewer.source.workspace);
  const [a, b] = await Promise.all([implementer, reviewer].map(w => until(h, w.workerId, r => r.worker.state === 'waiting')));
  const qa = a.events.find(e => e.type === 'question');
  const qb = b.events.find(e => e.type === 'question');
  await assert.rejects(mutation(h, 'answer', reviewer.workerId, { questionId: qa.questionId, answers: { q: { answers: ['answer-implementation'] } } }), { code: 'STALE_QUESTION' });
  const blockedObserver = h.dispatch('observe', { workerId: implementer.workerId, after: a.worker.cursor, waitMs: 300, limit: 100 });
  await mutation(h, 'answer', reviewer.workerId, { questionId: qb.questionId, answers: { q: { answers: ['answer-reviewer'] } } });
  await until(h, reviewer.workerId, (_, events) => events.some(e => e.type === 'agent-message-final' && e.text === 'reviewer:answer-acknowledged'));
  await h.peers.get(reviewer.workerId).control('complete');
  const reviewDone = await until(h, reviewer.workerId, r => r.worker.state === 'idle');
  assert.ok(reviewDone.events.some(e => e.text === 'reviewer:result:1'));
  assert.equal(reviewDone.events.some(e => e.text?.includes('implementation:')), false);
  assert.equal((await blockedObserver).worker.state, 'waiting');
  assert.equal((await h.peers.get(implementer.workerId).control('snapshot')).answered, false);
  await mutation(h, 'answer', implementer.workerId, { questionId: qa.questionId, answers: { q: { answers: ['answer-implementation'] } } });
  await until(h, implementer.workerId, (_, events) => events.some(e => e.type === 'agent-message-final' && e.text === 'implementation:answer-acknowledged'));
  await h.peers.get(implementer.workerId).control('complete');
  const implementationDone = await until(h, implementer.workerId, r => r.worker.state === 'idle');
  assert.ok(implementationDone.events.some(e => e.text === 'implementation:result:1'));
  assert.equal(implementationDone.events.some(e => e.text?.includes('reviewer:')), false);
});

test('interrupt acknowledgement precedes actual termination and close is idempotent', async t => {
  const h = harness(t);
  const worker = await start(h, 'implementation');
  await until(h, worker.workerId, r => r.worker.state === 'waiting');
  const interrupted = await mutation(h, 'interrupt', worker.workerId);
  assert.equal(interrupted.acknowledged, true);
  assert.equal(interrupted.terminationConfirmed, false);
  assert.notEqual(interrupted.state, 'interrupted');
  await h.peers.get(worker.workerId).control('terminate');
  const terminated = await until(h, worker.workerId, r => r.worker.state === 'interrupted');
  assert.ok(terminated.events.some(e => e.type === 'turn-completed' && e.status === 'interrupted'));
  assert.equal((await mutation(h, 'close', worker.workerId)).state, 'closed');
  assert.equal((await mutation(h, 'close', worker.workerId)).state, 'closed');
});

test('uncertain timed-out write is retained and never silently replayed', async t => {
  const h = harness(t, 'timeout-turn', 500);
  const input = { requestId: requestId(), role: 'implementation', revision, task: 'Uncertain delivery fixture' };
  await assert.rejects(h.dispatch('start', input), error => error.uncertain === true);
  await assert.rejects(h.dispatch('start', input), error => error.uncertain === true);
  assert.equal(h.peers.size, 1, 'retry must not launch a duplicate worker');
  assert.equal([...h.peers.values()][0].wireLog.filter(m => m.method === 'turn/start').length, 1);
  const listing = await h.dispatch('list');
  assert.equal(listing.workers[0].state, 'failed');
  assert.equal(listing.workers[0].uncertain, true);
});

for (const mode of ['changed-model', 'lost-effort']) test(`${mode}: refuse followup when effective settings cannot be confirmed`, async t => {
  const h = harness(t, mode);
  const worker = await start(h, 'reviewer');
  const waiting = await until(h, worker.workerId, r => r.worker.state === 'waiting');
  await mutation(h, 'answer', worker.workerId, {
    questionId: waiting.events.find(e => e.type === 'question').questionId,
    answers: { q: { answers: ['answer-reviewer'] } },
  });
  await until(h, worker.workerId, (_, events) => events.some(e => e.type === 'agent-message-final' && e.text === 'reviewer:answer-acknowledged'));
  const peer = h.peers.get(worker.workerId);
  await peer.control('complete');
  await until(h, worker.workerId, r => r.worker.state === 'idle');
  await assert.rejects(mutation(h, 'send', worker.workerId, { message: 'Follow up' }), { code: 'POLICY_UNCONFIRMED' });
  assert.equal(peer.wireLog.filter(m => m.method === 'turn/start').length, 1);
});

test('MCP tool handler integrates with real manager, client and child-process protocol peer', async t => {
  const h = harness(t);
  const handler = createHandler({ manager: h.manager, enableWorkerRuns: true });
  await handler({ jsonrpc: '2.0', id: requestId(), method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const invoke = async (operation, args) => {
    const response = await handler({ jsonrpc: '2.0', id: requestId(), method: 'tools/call', params: { name: `factory_${operation}`, arguments: args } });
    assert.equal(response.result.isError, false, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  const worker = await invoke('start', { requestId: requestId(), role: 'implementation', revision, task: 'Tool integration task' });
  await until(h, worker.workerId, r => r.worker.state === 'waiting');
  const waiting = await invoke('observe', { workerId: worker.workerId });
  await invoke('answer', {
    requestId: requestId(), workerId: worker.workerId,
    questionId: waiting.events.find(e => e.type === 'question').questionId,
    answers: { q: { answers: ['answer-implementation'] } },
  });
  await until(h, worker.workerId, (_, events) => events.some(e => e.type === 'agent-message-final' && e.text === 'implementation:answer-acknowledged'));
  await h.peers.get(worker.workerId).control('complete');
  await until(h, worker.workerId, r => r.worker.state === 'idle');
  const result = await invoke('observe', { workerId: worker.workerId });
  assert.ok(result.events.some(e => e.type === 'agent-message-final' && e.text === 'implementation:result:1'));
  assert.equal((await invoke('close', { requestId: requestId(), workerId: worker.workerId })).state, 'closed');
});

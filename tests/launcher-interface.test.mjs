import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, serve, validateConfig, TOOLS } from '../scripts/lib/launcher-interface.mjs';

const workerId = 'a'.repeat(24);
const request = (method, params, id = 'rpc-1') => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const init = async handler => {
  const response = await handler(request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.equal(response.result.protocolVersion, '2025-03-26');
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
};
const invoke = (handler, name, args) => handler(request('tools/call', { name: `factory_${name}`, arguments: args }));
const value = response => JSON.parse(response.result.content[0].text);

test('MCP tools route start, question, answer, steering and lifecycle with JSON request ids', async () => {
  const calls = [];
  const manager = { async dispatch(operation, input) {
    calls.push({ operation, input });
    return operation === 'observe' ? { events: [{ type: 'question', workerId, questionId: 'q-1', questions: [{ id: 'choice', question: 'Which option?' }] }] } : { workerId, accepted: true };
  } };
  const handler = createHandler({ manager, enableWorkerRuns: true });
  await init(handler);
  assert.equal((await handler(request('tools/list'))).result.tools.length, 8);
  const start = { requestId: 'start-1', role: 'implementation', revision: 'a'.repeat(40), task: 'Scoped task' };
  assert.equal(value(await invoke(handler, 'start', start)).workerId, workerId);
  const observation = value(await invoke(handler, 'observe', { workerId, after: 0, limit: 10, waitMs: 0 }));
  await invoke(handler, 'answer', { workerId, requestId: 'answer-1', questionId: observation.events[0].questionId, answers: { choice: { answers: ['first'] } } });
  await invoke(handler, 'send', { workerId, requestId: 'send-1', message: 'Correction' });
  await invoke(handler, 'interrupt', { workerId, requestId: 'interrupt-1' });
  await invoke(handler, 'close', { workerId, requestId: 'close-1' });
  assert.deepEqual(calls.map(call => call.operation), ['start', 'observe', 'answer', 'send', 'interrupt', 'close']);
  assert.deepEqual(calls[2].input.answers, { choice: { answers: ['first'] } });
  assert.equal((await handler(request('ping', undefined, 42))).id, 42);
  assert.equal((await handler(request('ping', undefined, { wrong: true }))).error.code, -32600);
});

test('unknown operations, override fields, malformed inputs, and gated execution never reach manager', async () => {
  let count = 0;
  const handler = createHandler({ manager: { async dispatch() { count++; throw new Error('secret-auth-packet'); } } });
  await init(handler);
  assert.equal(value(await invoke(handler, 'start', { requestId: 's', role: 'implementation', revision: 'a'.repeat(40), task: 'test' })).error, 'WORKER_RUNS_DISABLED');
  for (const [name, args] of [['shell', {}], ['send', { workerId, requestId: 's', message: 'x', model: 'override' }], ['start', { requestId: 's', role: 'coordinator', revision: 'a'.repeat(40), task: 'x' }], ['observe', { workerId, waitMs: 30001 }], ['answer', { workerId, requestId: 'x', questionId: 'q', answers: { choice: 'invalid' } }], ['observe', { workerId: 'not-a-worker' }]]) assert.equal((await invoke(handler, name, args)).result.isError, true);
  assert.equal(count, 0);
  const failed = await invoke(handler, 'health', {});
  assert.equal(value(failed).error, 'OPERATION_FAILED');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal((await handler(request('raw/protocol', {}))).error.code, -32601);
});

test('UTF-8 bytes and additionalProperties are enforced', async () => {
  const handler = createHandler({ manager: { dispatch: async () => ({}) }, enableWorkerRuns: true });
  await init(handler);
  assert.equal((await invoke(handler, 'send', { workerId, requestId: 'r', message: 'é'.repeat(9000) })).result.isError, true);
  assert.ok(TOOLS.every(tool => tool.inputSchema.additionalProperties === false));
});

test('initialization must negotiate before notification, and cannot be repeated', async () => {
  const handler = createHandler({ manager: { dispatch: async () => ({}) } });
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await handler(request('tools/list'))).error.code, -32000);
  assert.equal((await handler(request('initialize', { protocolVersion: 'unknown' }))).error.code, -32602);
  await init(handler);
  assert.equal((await handler(request('initialize', { protocolVersion: '2025-03-26' }))).error.code, -32600);
});

test('known error codes retain uncertainty without exposing exception messages', async () => {
  const handler = createHandler({ manager: { dispatch: async () => { throw Object.assign(new Error('secret-auth'), { code: 'UNCERTAIN_DELIVERY', uncertain: true }); } } });
  await init(handler);
  assert.deepEqual(value(await invoke(handler, 'list', {})), { error: 'UNCERTAIN_DELIVERY', uncertain: true });
});

test('cleanup and recovery failures preserve actionable codes and uncertainty', async () => {
  for (const code of ['CLEANUP_FAILED', 'RECOVERY_CLEANUP_REQUIRED', 'PREPARATION_CLEANUP_INCOMPLETE', 'EVENT_OVERFLOW', 'SHUTDOWN_FAILED', 'WORKER_RETENTION_LIMIT']) {
    const handler = createHandler({ manager: { dispatch: async operation => {
      assert.equal(operation, 'close');
      throw Object.assign(new Error('secret-auth-packet'), { code, uncertain: true });
    } } });
    await init(handler);
    const response = await invoke(handler, 'close', { workerId, requestId: 'close-error' });
    assert.equal(response.result.isError, true);
    assert.deepEqual(value(response), { error: code, uncertain: true });
    assert.equal(JSON.stringify(response).includes('secret-auth-packet'), false);
  }
});

test('arbitrary exception codes and messages are suppressed', async () => {
  const handler = createHandler({ manager: { dispatch: async () => {
    throw Object.assign(new Error('secret-auth-packet'), { code: 'PRIVATE_TOKEN_VALUE', uncertain: true });
  } } });
  await init(handler);
  const response = await invoke(handler, 'close', { workerId, requestId: 'close-error' });
  assert.equal(response.result.isError, true);
  assert.deepEqual(value(response), { error: 'OPERATION_FAILED' });
});

test('shutdown failure is reported and explicit stop rejects', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let failures = 0;
  const server = serve({ input, output, manager: { shutdown: async () => { throw new Error('cleanup failed'); } }, onShutdownError: () => { failures++; } });
  input.end();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(server.stop(), /cleanup failed/);
  assert.equal(failures, 1);
});

test('oversized manager responses and concurrency excess fail boundedly', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const server = serve({ input, output, maxConcurrent: 1, maxResponseBytes: 512, manager: { dispatch: async () => ({ large: 'x'.repeat(1000) }), shutdown: async () => {} } });
  const write = value => input.write(`${JSON.stringify(value)}\n`);
  write(request('initialize', { protocolVersion: '2025-03-26' }));
  await new Promise(resolve => setImmediate(resolve));
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise(resolve => setImmediate(resolve));
  write(request('tools/call', { name: 'factory_list', arguments: {} }, 'large'));
  write(request('ping', undefined, 'excess'));
  await new Promise(resolve => setImmediate(resolve));
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.ok(responses.some(response => response.error?.message === 'Response exceeds limit'));
  assert.ok(responses.some(response => response.error?.code === -32001));
  await server.stop();
});

test('concurrent JSONL observe does not block answer; malformed and oversized lines recover; EOF shuts down once', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '', release, shutdowns = 0;
  output.on('data', chunk => { text += chunk; });
  const manager = { async dispatch(operation) { if (operation === 'observe') return new Promise(resolve => { release = resolve; }); return { operation }; }, async shutdown() { shutdowns++; release?.({ ended: true }); } };
  const server = serve({ input, output, manager, enableWorkerRuns: true, maxLineBytes: 1024 });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  input.write(`${JSON.stringify(request('initialize', { protocolVersion: '2025-03-26' }))}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify(request('tools/call', { name: 'factory_observe', arguments: { workerId, waitMs: 30000 } }, 'wait'))}\n`);
  input.write(`${JSON.stringify(request('tools/call', { name: 'factory_answer', arguments: { workerId, requestId: 'ans', questionId: 'q', answers: { choice: { answers: ['yes'] } } } }, 'answer'))}\n`);
  input.write(`broken\n${'x'.repeat(1025)}\n${JSON.stringify(request('ping', undefined, 9))}\n`);
  await tick();
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.ok(responses.find(response => response.id === 'answer').result);
  assert.equal(responses.some(response => response.id === 'wait'), false);
  assert.ok(responses.some(response => response.error?.code === -32700));
  assert.ok(responses.some(response => response.error?.message === 'Request exceeds limit'));
  assert.ok(responses.some(response => response.id === 9));
  input.end(); await tick(); await server.stop();
  assert.equal(shutdowns, 1);
});

test('strict host config rejects overlap and overrides and defaults worker runs off', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-interface-'));
  try {
    const paths = Object.fromEntries(['checkout', 'credentials', 'runs', 'state', 'deployment'].map(name => { const path = join(directory, name); mkdirSync(path); return [name, path]; }));
    const { deployment, ...config } = paths;
    assert.equal(validateConfig(config, deployment).enableWorkerRuns, false);
    assert.throws(() => validateConfig({ ...config, arbitraryShell: 'bad' }, deployment));
    assert.throws(() => validateConfig({ ...config, state: config.runs }, deployment));
    assert.throws(() => validateConfig({ ...config, credentials: directory }, deployment));
    assert.throws(() => validateConfig({ ...config, runs: './relative' }, deployment));
    assert.throws(() => validateConfig({ ...config, maxWorkers: 1000 }, deployment));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

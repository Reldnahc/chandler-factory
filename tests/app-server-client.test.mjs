import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AppServerClient } from '../scripts/lib/app-server-client.mjs';
import { readBootstrap } from '../runtime/app-server-bridge.mjs';

function fixture(options) {
  const input = new PassThrough(), output = new PassThrough();
  const client = new AppServerClient(input, output, options);
  const sent = []; output.on('data', data => sent.push(JSON.parse(data)));
  return { client, input, output, sent };
}
test('correlates out-of-order responses and routes requests/notifications', async () => {
  const { client, input, sent } = fixture();
  const first = client.request('thread/start', {}), second = client.request('turn/start', {});
  input.write(JSON.stringify({ id: sent[1].id, result: { second: true } }) + '\n');
  input.write(JSON.stringify({ id: sent[0].id, result: { first: true } }) + '\n');
  assert.deepEqual(await first, { first: true }); assert.deepEqual(await second, { second: true });
  let notification, request;
  client.on('notification', value => notification = value);
  client.on('request', value => request = value);
  const bytes = Buffer.from('{"method":"progress","params":{"text":"é"}}\n');
  input.write(bytes.subarray(0, bytes.length - 4)); input.write(bytes.subarray(bytes.length - 4));
  input.write('{"id":"question","method":"item/tool/requestUserInput","params":{}}\n');
  assert.equal(notification.params.text, 'é'); assert.equal(request.id, 'question');
  client.respond(request.id, { answers: {} }); client.reject('denied', { code: -32601, message: 'Unsupported method' });
  client.notify('initialized', {});
  assert.deepEqual(sent.at(-3), { id: 'question', result: { answers: {} } });
  assert.equal(sent.at(-2).error.code, -32601); assert.equal(sent.at(-1).method, 'initialized');
  client.close();
});
test('timeouts mark uncertain delivery and terminate all pending requests without replay', async () => {
  const { client, sent } = fixture({ timeoutMs: 15 });
  const results = await Promise.allSettled([client.request('turn/start', {}), client.request('turn/steer', {})]);
  for (const result of results) { assert.equal(result.reason.code, 'REQUEST_TIMEOUT'); assert.equal(result.reason.uncertain, true); }
  assert.equal(client.closed, true); assert.equal(sent.length, 2);
});
test('EOF rejects pending requests, remote errors suppress peer text', async () => {
  const { client, input, sent } = fixture();
  const remote = client.request('x', {});
  input.write(JSON.stringify({ id: sent[0].id, error: { code: 9, message: 'SECRET', data: 'SECRET' } }) + '\n');
  await assert.rejects(remote, error => error.code === 'REMOTE_ERROR' && !error.message.includes('SECRET'));
  const pending = client.request('x', {}); input.end();
  await assert.rejects(pending, error => error.code === 'EOF' && error.uncertain);
});
test('pending and line limits reject safely', async () => {
  const { client, input } = fixture({ maxPending: 1, maxLineBytes: 100 });
  const pending = client.request('x', {});
  await assert.rejects(client.request('x', {}), { code: 'PENDING_LIMIT' });
  input.write('X'.repeat(101)); await assert.rejects(pending, { code: 'LINE_LIMIT' });
  const other = fixture(); const malformed = other.client.request('x', {});
  other.input.write('SECRET malformed JSON\n');
  await assert.rejects(malformed, error => error.code === 'INVALID_JSON' && !error.message.includes('SECRET'));
});
test('bootstrap preserves subsequent bytes, rejects incomplete, oversized and invalid input', async () => {
  const stream = new PassThrough(); const first = readBootstrap(stream);
  stream.write('{"githubToken":"fixture",'); stream.write('"codexAuth":{}}\n{"method":"initialize"}\n');
  assert.equal((await first).githubToken, 'fixture');
  assert.equal(stream.read().toString(), '{"method":"initialize"}\n');
  for (const data of ['{}', 'SECRET\n', 'X'.repeat(20)]) {
    const input = new PassThrough(); const pending = readBootstrap(input, { maxBytes: 10 }); input.end(data);
    await assert.rejects(pending, /Invalid credential bootstrap/);
  }
});

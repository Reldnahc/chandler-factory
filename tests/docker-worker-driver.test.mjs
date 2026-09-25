import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerWorkerDriver, WorkerPreparationError } from '../scripts/lib/docker-worker-driver.mjs';
import { workerPolicy } from '../runtime/worker-policy.mjs';
import { contained } from '../scripts/lib/role-launch.mjs';

function fixture(t, { badPolicy = false, failCleanup = false, failProxy = false, foreignOwner = false, stalledInput = false, proxyNotReady = false, startupTimeoutMs = 25000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-driver-'));
  t.after(() => { assert.ok(contained(tmpdir(), root)); rmSync(root, { recursive: true, force: true }); });
  const config = Object.fromEntries(['checkout', 'credentials', 'runs', 'stateDirectory'].map(key => {
    const path = join(root, key); mkdirSync(path); return [key, path];
  }));
  for (const role of ['implementation', 'reviewer']) {
    mkdirSync(join(config.credentials, role));
    writeFileSync(join(config.credentials, role, 'github-token'), `fixture-token-${role}`);
    writeFileSync(join(config.credentials, role, 'codex-auth.json'), '{"access_token":"fixture-auth"}');
  }
  const calls = [], children = [], owners = new Map();
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (args.includes('--label')) owners.set(args[0] === 'volume' ? args.at(-1) : args[args.indexOf('--name') + 1], args[args.indexOf('--label') + 1].split('=')[1]);
    if (['volume', 'container'].includes(args[0]) && args[1] === 'inspect') return callback(null, foreignOwner ? 'foreign-owner' : owners.get(args[2]) ?? 'foreign-owner');
    if (proxyNotReady && args[0] === 'exec') return callback(new Error('not ready'));
    if ((failCleanup && children.length && args[0] === 'rm') || (failProxy && args.includes('-d'))) return callback(new Error('secret stderr'));
    if (args[0] === 'image') return callback(null, `sha256:${'a'.repeat(64)}`);
    if (args.at(-1) === 'policy') {
      const role = args.find(arg => arg.startsWith('FACTORY_ROLE=')).split('=')[1];
      return callback(null, JSON.stringify({ schema: 'chandler-worker-policy', version: badPolicy ? '0' : '1', role,
        ...workerPolicy(role), features: { multi_agent: false, multi_agent_v2: false, default_mode_request_user_input: true }, transport: 'app-server-stdio' }));
    }
    callback(null, 'ok');
  };
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    owners.set(args[args.indexOf('--name') + 1], args[args.indexOf('--label') + 1].split('=')[1]);
    const child = new EventEmitter(); child.packets = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, done) { child.packets.push(chunk.toString()); if (!stalledInput) done(); } });
    child.kill = signal => { child.signal = signal; child.emit('exit', 0); return true; };
    children.push(child); return child;
  };
  const driver = new DockerWorkerDriver({ ...config, execFile, spawn, timeoutMs: 30, closeTimeoutMs: 5, startupTimeoutMs,
    snapshot: (checkout, revision, destination) => { mkdirSync(destination); return { revision, files: 0, bytes: 0 }; } });
  return { driver, calls, children, config, allowCleanup: () => { failCleanup = false; } };
}
const assignment = (workerId = 'a'.repeat(24), role = 'implementation') => ({ workerId, role, revision: 'b'.repeat(40), task: 'Fixture task' });

test('driver passes credentials only as first line and leaves protocol open', async t => {
  const f = fixture(t); const worker = await f.driver.prepare(assignment());
  const child = f.children[0];
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.packets.length, 1); assert.ok(child.packets[0].endsWith('\n'));
  assert.equal(JSON.parse(child.packets[0]).githubToken, 'fixture-token-implementation');
  const launch = f.calls.find(call => call.args.at(-1) === 'app-server');
  assert.equal(launch.args[launch.args.indexOf('--network') + 1], 'none');
  assert.equal(launch.args.filter(arg => arg.startsWith('type=bind')).length, 3);
  assert.equal(JSON.stringify(f.calls).includes('fixture-token'), false);
  assert.equal(JSON.stringify(f.calls).includes('fixture-auth'), false);
  assert.deepEqual(worker.sanitize({ 'fixture-auth': ['fixture-token-implementation'] }), { '[REDACTED]': ['[REDACTED]'] });
  await worker.close(); await worker.close();
  assert.equal(f.calls.filter(call => call.args[0] === 'rm').length, 3);
  assert.ok(f.calls.some(call => call.args.join(' ') === `volume rm factory-egress-${'a'.repeat(24)}`));
});

test('incompatible policy fails before credential selection or spawn', async t => {
  const f = fixture(t, { badPolicy: true });
  rmSync(join(f.config.credentials, 'implementation', 'github-token'));
  await assert.rejects(f.driver.prepare(assignment()), /preparation failed/);
  assert.equal(f.children.length, 0);
  assert.equal(f.calls.some(call => call.args[0] === 'volume'), false);
});

test('multiple workers own distinct resources and snapshots', async t => {
  const f = fixture(t);
  const [first, second] = await Promise.all([f.driver.prepare(assignment()), f.driver.prepare(assignment('c'.repeat(24), 'reviewer'))]);
  assert.notEqual(first.artifacts.directory, second.artifacts.directory);
  assert.notEqual(first.runtime.containerName, second.runtime.containerName);
  await first.close(); assert.equal(f.children[1].signal, undefined); await second.close();
  await assert.rejects(f.driver.prepare(assignment()), /already used/);
});

test('partial proxy failure removes owned resources and suppresses stderr', async t => {
  const f = fixture(t, { failProxy: true });
  await assert.rejects(f.driver.prepare(assignment()), error => error.message === 'Worker preparation failed.');
  assert.equal(f.children.length, 0);
  assert.ok(f.calls.some(call => call.args[0] === 'rm'));
  assert.ok(f.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm'));
});

test('cleanup failure is never reported as successful closure', async t => {
  const f = fixture(t, { failCleanup: true }); const worker = await f.driver.prepare(assignment());
  await assert.rejects(worker.close(), /cleanup incomplete/);
  await assert.rejects(worker.close(), /cleanup incomplete/);
});

test('uncertain ownership does not remove an unrelated container', async t => {
  const f = fixture(t, { foreignOwner: true });
  await assert.rejects(f.driver.prepare(assignment()), error => {
    assert.ok(error instanceof WorkerPreparationError);
    assert.deepEqual(error.resource.sanitize({ workers: [], requests: [] }), { workers: [], requests: [] });
    return /cleanup incomplete/.test(error.message);
  });
  assert.equal(f.calls.some(call => call.args[0] === 'rm'), false);
  assert.equal(f.children.length, 0);
});

test('stalled credential handoff times out and cleans owned resources', async t => {
  const f = fixture(t, { stalledInput: true });
  await assert.rejects(f.driver.prepare(assignment()), /preparation failed/);
  assert.equal(f.children[0].signal, 'SIGTERM');
  assert.ok(f.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm'));
});

test('failed bootstrap plus failed cleanup retains a safe explicit retry handle', async t => {
  const f = fixture(t, { stalledInput: true, failCleanup: true });
  let failure;
  try { await f.driver.prepare(assignment()); } catch (error) { failure = error; }
  assert.ok(failure instanceof WorkerPreparationError);
  assert.equal(failure.code, 'PREPARATION_CLEANUP_INCOMPLETE');
  assert.equal(Object.keys(failure).includes('resource'), false);
  assert.equal(JSON.stringify(failure.resource).includes('fixture-token'), false);
  assert.equal(failure.resource.sanitize('fixture-token-implementation fixture-auth'), '[REDACTED] [REDACTED]');
  await assert.rejects(failure.resource.close(), /cleanup incomplete/);
  f.allowCleanup();
  await failure.resource.close();
  const count = f.calls.length;
  await failure.resource.close();
  assert.equal(f.calls.length, count);
});

test('proxy readiness uses one absolute startup deadline', async t => {
  const f = fixture(t, { proxyNotReady: true, startupTimeoutMs: 40 });
  const start = Date.now();
  await assert.rejects(f.driver.prepare(assignment()), /preparation failed/);
  assert.ok(Date.now() - start < 500);
  assert.ok(f.calls.filter(call => call.args[0] === 'exec').length < 25);
  assert.equal(f.children.length, 0);
  assert.ok(f.calls.filter(call => call.args[0] === 'exec').every(call => call.options.timeout <= 40));
});

test('driver rejects coordinator, overrides, malformed identifiers, and overlapping roots', async t => {
  const f = fixture(t);
  for (const input of [{ ...assignment(), role: 'coordinator' }, { ...assignment(), model: 'other' }, assignment('../escape')]) {
    await assert.rejects(f.driver.prepare(input), /Invalid worker/);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => new DockerWorkerDriver({ ...f.config, stateDirectory: f.config.runs }), /overlap/);
});


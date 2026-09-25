// Synthetic credentials only. This verifies container boundaries, not GitHub permissions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const results = [];
function check(name, action) { action(); results.push({ name, passed: true }); }
check('non-root user', () => assert.equal(process.getuid(), 1000));
check('no effective capabilities', () => assert.match(readFileSync('/proc/self/status', 'utf8'), /CapEff:\s+0+\n/));
check('no new privileges', () => assert.match(readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1/));
check('only own synthetic credentials readable', () => {
  assert.ok(/^factory-canary-/.test(process.env.GH_TOKEN), 'Synthetic credentials required.');
  const auth = JSON.parse(readFileSync(`${process.env.CODEX_HOME}/auth.json`, 'utf8'));
  assert.equal(auth.fixture === true && Object.keys(auth).length === 1, true, 'Synthetic auth required.');
  for (const path of ['/secrets/sibling-token', '/host-owner', '/var/run/docker.sock', '/run/docker.sock', '/mnt/c', '/host_mnt']) assert.equal(existsSync(path), false, path);
});
check('host environment not inherited', () => assert.equal(process.env.FACTORY_OWNER_CANARY, undefined));
check('runtime and task immutable', () => {
  const root = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(line => line.split(' ')[4] === '/');
  assert.ok(root?.split(' ')[5].split(',').includes('ro'), 'root filesystem is read-only');
  for (const path of ['/opt/factory/entrypoint.mjs', '/task.md']) assert.throws(() => writeFileSync(path, 'changed'));
});
check('scratch and own output writable', () => {
  writeFileSync('/tmp/probe', 'ok'); writeFileSync('/home/agent/probe', 'ok'); writeFileSync('/output/probe-marker', 'ok');
  writeFileSync(`${process.env.CODEX_HOME}/auth.json`, '{"fixture":true}'); // Own auth supports refresh in tmpfs.
});
check('workspace respects role mode', () => {
  if (process.env.FACTORY_ROLE === 'implementation') writeFileSync('/workspace/probe-marker', 'ok');
  else assert.throws(() => writeFileSync('/workspace/probe-marker', 'no'));
});
check('no IP route to host or internet', () => {
  assert.deepEqual(Object.keys(networkInterfaces()).filter(name => name !== 'lo'), []);
  assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
});
check('gh cannot fall back to host login', () => {
  const env = { ...process.env }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  assert.throws(() => execFileSync('gh', ['auth', 'token'], { env, stdio: 'pipe' }));
});
console.log(JSON.stringify({ scope: 'offline synthetic container boundary probe', role: process.env.FACTORY_ROLE, results }));

// Fixed live-network diagnostic; all authentication files are synthetic.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { startRelay } from './proxy-relay.mjs';

function execute(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}
function connectRequest(authority) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(3128, '127.0.0.1'); let response = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('proxy timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', data => {
      response += data;
      if (response.includes('\r\n')) { resolve(response.split('\r\n')[0]); socket.destroy(); }
    });
  });
}
function directConnection(host, port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(2000, () => socket.destroy(new Error('unexpected timeout instead of routing rejection')));
    socket.on('connect', () => { socket.destroy(); reject(new Error(`Unexpected direct route to ${host}:${port}`)); });
    socket.on('error', error => {
      if (['ENETUNREACH', 'EHOSTUNREACH', 'EACCES'].includes(error.code)) resolve(error.code);
      else reject(error);
    });
  });
}

assert.ok(/^factory-canary-/.test(process.env.GH_TOKEN), 'Synthetic credentials required.');
const auth = JSON.parse(readFileSync(`${process.env.CODEX_HOME}/auth.json`, 'utf8'));
assert.equal(auth.fixture === true && Object.keys(auth).length === 1, true, 'Synthetic auth required.');
const relay = await startRelay();
const results = [];
let sandbox;
try {
  const response = await execute('curl', ['--fail', '--silent', '--show-error', '--max-time', '20', '--proxy',
    'http://127.0.0.1:3128', 'https://api.github.com/meta']);
  assert.equal(response.code, 0, response.stderr);
  const metadata = JSON.parse(response.stdout);
  assert.equal(typeof metadata.verifiable_password_authentication, 'boolean');
  results.push({ name: 'allowed GitHub HTTPS with verified TLS and valid public metadata', passed: true });
  for (const authority of ['host.docker.internal:443', '127.0.0.1:443', '169.254.169.254:443', 'example.com:443', 'api.github.com:80']) {
    const status = await connectRequest(authority);
    assert.equal(status, 'HTTP/1.1 403 Forbidden');
    results.push({ name: `proxy denies ${authority}`, passed: true, status });
  }
  for (const [host, port] of [['172.17.0.1', 2375], ['192.168.65.2', 443], ['1.1.1.1', 443]]) {
    results.push({ name: `direct route to ${host}:${port} denied`, passed: true, error: await directConnection(host, port) });
  }
  mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const help = await execute('codex', ['sandbox', 'linux', '--help']);
  const mode = process.env.FACTORY_ROLE === 'implementation' ? 'workspace-write' : 'read-only';
  const action = await execute('codex', ['-a', 'never', '-c', `sandbox_mode="${mode}"`, 'sandbox', 'linux', '--', 'node', '-e',
    'require("node:fs").writeFileSync("/tmp/inner-sandbox-marker","ok"); console.log("INNER_SANDBOX_ACTION_EXECUTED")']);
  sandbox = { scope: 'nested Linux sandbox diagnostic; separate from outer boundary checks',
    mode, supported: action.code === 0 && action.stdout.includes('INNER_SANDBOX_ACTION_EXECUTED'),
    help: { code: help.code, stdout: help.stdout.slice(0, 2000), stderr: help.stderr.slice(0, 2000) },
    action: { code: action.code, stdout: action.stdout.slice(0, 2000), stderr: action.stderr.slice(0, 2000) } };
  assert.ok(sandbox.supported || /bwrap:.*(?:namespace|Operation not permitted)/s.test(action.stderr), 'Unexpected nested sandbox result');
  const report = { scope: 'live egress with synthetic credentials', role: process.env.FACTORY_ROLE, results, sandbox };
  writeFileSync('/output/egress-marker', 'ok');
  console.log(JSON.stringify(report));
} finally { relay.close(); }

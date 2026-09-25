// Live HTTPS positive/negative trial using no user credentials.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IMAGE, dockerArguments, plainPath } from './lib/role-launch.mjs';

const parent = plainPath(process.argv[2] ?? resolve('.local'), 'directory');
const run = mkdtempSync(join(parent, 'egress-probe-'));
const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
const imageId = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
const proxyImage = docker(['image', 'inspect', 'chandler-factory-egress:0.1', '--format', '{{.Id}}']);
const identifier = `factory-egress-${randomBytes(12).toString('hex')}`;
let created = false;
try {
  docker(['volume', 'create', identifier]); created = true;
  docker(['run', '-d', '--rm', '--pull', 'never', '--name', identifier, '--network', 'bridge', '--user', '1000:1000', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
    '--mount', `type=volume,src=${identifier},dst=/proxy`, proxyImage]);
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    try { docker(['exec', identifier, 'node', '-e', 'if (!require("node:fs").statSync("/proxy/egress.sock").isSocket()) process.exit(1)']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!ready) throw new Error('Proxy did not become ready.');
  const reports = [];
  for (const role of ['implementation', 'reviewer']) {
    const home = join(run, role); mkdirSync(home);
    const workspace = join(home, 'workspace'); const output = join(home, 'output'); mkdirSync(workspace); mkdirSync(output);
    const task = join(home, 'task.md');
    writeFileSync(task, 'Fixed synthetic egress test.');
    const args = dockerArguments({ role, workspace, output, task, imageId, networkProbe: true, proxyVolume: identifier });
    const report = JSON.parse(docker(args, JSON.stringify({ githubToken: `factory-canary-${role}`, codexAuth: { fixture: true } }) + '\n'));
    if (report.results?.length !== 9 || report.results.some(result => result.passed !== true)) throw new Error('Incomplete network evidence.');
    if (readFileSync(join(output, 'egress-marker'), 'utf8') !== 'ok') throw new Error('Missing network action artifact.');
    reports.push(report);
  }
  const evidence = { timestamp: new Date().toISOString(), imageId, proxyImage, reports };
  writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, checks: 18, nestedSandbox: reports.map(({ role, sandbox }) => ({ role, supported: sandbox.supported })), evidence: join(run, 'evidence.json') }));
} finally {
  try { docker(['stop', '--time', '2', identifier]); } catch { /* Preserve original diagnostic failure. */ }
  if (created) docker(['volume', 'rm', identifier]);
}

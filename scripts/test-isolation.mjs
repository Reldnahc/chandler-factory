// Real Docker boundary probes using generated canaries; no user credentials or network access.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IMAGE, ROLES, dockerArguments, plainPath } from './lib/role-launch.mjs';

const parent = plainPath(process.argv[2] ?? resolve('.local'), 'directory');
const run = mkdtempSync(join(parent, 'isolation-probe-'));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
const imageId = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']).trim();
const sentinel = randomBytes(24).toString('hex');
writeFileSync(join(run, 'owner-token'), sentinel); // Exists on host, never mounted.
writeFileSync(join(run, 'sibling-token'), sentinel);
const reports = [];
for (const role of ROLES) {
  const home = join(run, role); mkdirSync(home);
  const workspace = join(home, 'workspace'); const output = join(home, 'output');
  mkdirSync(workspace); mkdirSync(output);
  const task = join(home, 'task.md');
  writeFileSync(task, 'Synthetic boundary test.');
  const args = dockerArguments({ role, workspace, output, task, imageId, probe: true });
  const raw = execFileSync('docker', args, { encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ githubToken: `factory-canary-${role}`, codexAuth: { fixture: true } }),
    env: { ...process.env, FACTORY_OWNER_CANARY: sentinel }, maxBuffer: 1024 * 1024 });
  if (raw.includes(sentinel)) throw new Error('A host canary escaped into the role report.');
  const report = JSON.parse(raw.trim());
  if (report.role !== role || report.results?.length !== 10 || report.results.some(check => check.passed !== true)) throw new Error('Incomplete probe evidence.');
  if (readFileSync(join(output, 'probe-marker'), 'utf8') !== 'ok') throw new Error('Missing action artifact.');
  reports.push(report);
}
const evidence = { timestamp: new Date().toISOString(), imageId, scope: 'offline synthetic probes; not live identity or egress tests', reports };
writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: true, roles: reports.length, checks: reports.reduce((sum, report) => sum + report.results.length, 0), evidence: join(run, 'evidence.json') }));

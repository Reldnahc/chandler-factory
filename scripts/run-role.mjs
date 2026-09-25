// Invoke from a reviewed, trusted deployment, never from a worker-writable checkout.
// Manual dispatch only: no scheduler, model-selected Docker flags, or host execution API.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IMAGE, ROLES, plainPath, contained, snapshot, credentials, credentialPayload, dockerArguments } from './lib/role-launch.mjs';

function docker(args) { return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function parse(args) {
  const options = {};
  const allowed = ['role', 'checkout', 'revision', 'task', 'credentials', 'runs'];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !allowed.includes(name) || !args[i + 1] || options[name]) throw new Error(`Invalid or repeated launcher argument: ${args[i]}`);
    options[name] = args[i + 1];
  }
  for (const name of allowed) if (!options[name]) throw new Error(`Missing --${name}.`);
  if (!ROLES.includes(options.role)) throw new Error('Unknown role.');
  return options;
}

let proxyName;
let volume;
try {
  const options = parse(process.argv.slice(2));
  const checkout = plainPath(options.checkout, 'directory');
  const task = plainPath(options.task);
  const runs = plainPath(options.runs, 'directory');
  // Only a dedicated child is mounted. The trusted deployment and credential roots never are.
  const run = mkdtempSync(join(runs, `${options.role}-`));
  const deployment = resolve(import.meta.dirname, '..');
  if (contained(run, deployment)) throw new Error('Trusted launcher deployment cannot be inside the run workspace.');
  const secrets = credentials(options.credentials, options.role, checkout, run);
  const workspace = join(run, 'workspace');
  const source = snapshot(checkout, options.revision, workspace);
  const output = join(run, 'output'); mkdirSync(output);
  const taskCopy = join(run, 'task.md');
  writeFileSync(taskCopy, `Source revision: ${source.revision}\n\n${readFileSync(task, 'utf8')}`, { flag: 'wx' });
  const imageId = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  const proxyImage = docker(['image', 'inspect', 'chandler-factory-egress:0.1', '--format', '{{.Id}}']);
  if (!/^sha256:[a-f\d]{64}$/.test(proxyImage)) throw new Error('Invalid egress image ID.');
  const suffix = randomBytes(12).toString('hex');
  volume = `factory-egress-${suffix}`; proxyName = `factory-egress-${suffix}`;
  docker(['volume', 'create', volume]);
  docker(['run', '-d', '--rm', '--pull', 'never', '--name', proxyName, '--network', 'bridge', '--user', '1000:1000',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
    '--mount', `type=volume,src=${volume},dst=/proxy`, proxyImage]);
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      docker(['exec', proxyName, 'node', '-e', 'if (!require("node:fs").statSync("/proxy/egress.sock").isSocket()) process.exit(1)']);
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!ready) throw new Error('Egress proxy did not create its socket; no role process started.');
  const args = dockerArguments({ role: options.role, workspace, task: taskCopy, output, ...secrets, imageId, proxyVolume: volume });
  writeFileSync(join(run, 'launch.json'), JSON.stringify({ role: options.role, source, imageId, proxyImage,
    isolation: 'network-none role; fixed CONNECT allowlist through read-only Unix socket', createdAt: new Date().toISOString() }, null, 2));
  console.log(`Starting ${options.role}; snapshot and results: ${run}`);
  const payload = credentialPayload(secrets);
  let result;
  try { result = spawnSync('docker', args, { input: payload, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true }); }
  finally { payload.fill(0); }
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (proxyName) { try { docker(['stop', '--time', '2', proxyName]); } catch { /* Preserve original failure. */ } }
  if (volume) { try { docker(['volume', 'rm', volume]); } catch { console.error(`Could not remove disposable proxy volume ${volume}.`); process.exitCode = 1; } }
}

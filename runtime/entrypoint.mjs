import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startRelay } from './proxy-relay.mjs';
import { POLICY_VERSION, workerPolicy, workerArguments } from './worker-policy.mjs';
import { readBootstrap } from './app-server-bridge.mjs';

async function main() {
  const role = process.env.FACTORY_ROLE;
  const policy = workerPolicy(role);
  const command = process.argv[2];
  if (process.argv.length !== 3) throw new Error('Exactly one fixed runtime command is required.');
  if (command === 'policy') {
    console.log(JSON.stringify({ schema: 'chandler-worker-policy', version: POLICY_VERSION,
      role, ...policy, features: { multi_agent: false, multi_agent_v2: false,
        default_mode_request_user_input: true }, transport: 'app-server-stdio' }));
    return;
  }
  if (command === 'run') throw new Error('One-shot run is disabled. Use the managed app-server entrypoint.');
  if (!['app-server', 'probe', 'network-probe'].includes(command)) throw new Error('Unsupported fixed runtime command.');
  const args = workerArguments(role);
  let credentials = await readBootstrap(process.stdin);
  if (typeof credentials.githubToken !== 'string' || !credentials.githubToken.trim() ||
      !credentials.codexAuth || typeof credentials.codexAuth !== 'object' || Array.isArray(credentials.codexAuth)) throw new Error('Missing role credentials.');
  const home = process.env.CODEX_HOME;
  if (!home) throw new Error('Missing runtime authentication directory.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const authPath = `${home}/auth.json`;
  writeFileSync(authPath, JSON.stringify(credentials.codexAuth), { mode: 0o600 });
  process.env.GH_TOKEN = credentials.githubToken.trim();
  credentials = undefined;
  if (command !== 'app-server') {
    try { await import(command === 'probe' ? './probe.mjs' : './network-probe.mjs'); }
    finally { rmSync(authPath, { force: true }); delete process.env.GH_TOKEN; }
    return;
  }
  let proxy, child, stopping = false, killTimer;
  const sockets = new Set();
  const cleanup = () => {
    rmSync(authPath, { force: true }); delete process.env.GH_TOKEN;
    for (const socket of sockets) socket.destroy();
    proxy?.close();
  };
  const stop = (code = 1) => {
    if (stopping) return;
    stopping = true; process.exitCode = code;
    process.stdin.unpipe(); process.stdin.pause();
    cleanup();
    if (child && child.exitCode === null) {
      child.stdin.destroy(); child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    }
  };
  process.once('SIGTERM', () => stop(143)); process.once('SIGINT', () => stop(130));
  try {
    proxy = await startRelay();
    if (stopping) { proxy.close(); return; }
    proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    proxy.on('error', () => stop(1));
    const env = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:3128',
      HTTP_PROXY: 'http://127.0.0.1:3128', ALL_PROXY: 'http://127.0.0.1:3128', NO_PROXY: '' };
    child = spawn('codex', args, { env, cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'] });
    // Raw stderr can contain authentication packets or model output. Never forward it.
    child.stderr.resume();
    child.once('error', () => stop(1));
    child.once('exit', code => { clearTimeout(killTimer); stop(code ?? 1); });
    child.stdin.on('error', () => stop(1)); child.stdout.on('error', () => stop(1));
    child.stdout.once('end', () => { if (!stopping) stop(1); });
    process.stdin.on('error', () => stop(1)); process.stdout.on('error', () => stop(1));
    process.stdin.once('end', () => stop(0));
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
    if (process.stdin.readableEnded) stop(0);
  } catch { stop(1); throw new Error('App-server runtime startup failed.'); }
}

main().catch(error => {
  const safe = ['Unsupported runtime worker role.', 'Exactly one fixed runtime command is required.',
    'One-shot run is disabled. Use the managed app-server entrypoint.', 'Unsupported fixed runtime command.',
    'Missing role credentials.', 'Missing runtime authentication directory.'];
  console.error(safe.includes(error.message) ? error.message : 'Runtime failed; sensitive diagnostics suppressed.');
  process.exitCode = 1;
});

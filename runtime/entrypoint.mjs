import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startRelay } from './proxy-relay.mjs';

const role = process.env.FACTORY_ROLE;
if (!['coordinator', 'implementation', 'reviewer'].includes(role)) throw new Error('Invalid fixed role.');
// Credentials arrive only over Docker stdin, never container arguments/environment
// configuration or a host bind mount. Consume the bounded payload before any model.
let payload = '';
for await (const chunk of process.stdin) {
  payload += chunk.toString('utf8');
  if (Buffer.byteLength(payload) > 65536) throw new Error('Credential payload exceeds 64 KiB.');
}
let credentials;
try { credentials = JSON.parse(payload); } catch { throw new Error('Invalid credential payload.'); }
payload = '';
if (typeof credentials.githubToken !== 'string' || !credentials.githubToken.trim() ||
    !credentials.codexAuth || typeof credentials.codexAuth !== 'object' || Array.isArray(credentials.codexAuth)) throw new Error('Missing role credentials.');
mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
writeFileSync(`${process.env.CODEX_HOME}/auth.json`, JSON.stringify(credentials.codexAuth), { mode: 0o600 });
process.env.GH_TOKEN = credentials.githubToken.trim();
credentials = undefined;
if (process.argv[2] === 'probe') {
  await import('./probe.mjs');
} else if (process.argv[2] === 'network-probe') {
  await import('./network-probe.mjs');
} else if (process.argv[2] === 'run') {
  // No IP network in this container. The only egress is this loopback-to-Unix shim.
  const proxy = await startRelay();
  const env = { ...process.env,
    HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128', ALL_PROXY: 'http://127.0.0.1:3128', NO_PROXY: '' };
  const roleInstructions = readFileSync(`/opt/factory/roles/${role}.md`, 'utf8');
  const args = ['-a', 'never', '-c', `developer_instructions=${JSON.stringify(roleInstructions)}`,
    '-c', 'projects."/workspace".trust_level="untrusted"', 'exec', '--ignore-user-config', '--strict-config',
    '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access',
    '-C', '/workspace', '--json', '--output-last-message', '/output/last-message.md', '-'];
  const child = spawn('codex', args, { env, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(readFileSync('/task.md', 'utf8'));
  child.on('error', error => { console.error(error.message); proxy.close(); process.exitCode = 1; });
  child.on('exit', code => { proxy.close(); process.exitCode = code ?? 1; });
} else {
  throw new Error('Only the fixed run, probe, and network-probe entrypoints are supported.');
}

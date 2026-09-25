// Trusted host launcher helpers. None of these paths are shared wholesale with a role.
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, mkdirSync, writeFileSync, existsSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, parse, dirname, join } from 'node:path';

export const ROLES = ['implementation', 'reviewer'];
export const IMAGE = 'chandler-factory-role:0.2';

export function contained(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path));
}

export function plainPath(input, kind = 'file') {
  const path = resolve(input);
  if (/[\r\n,]/.test(path)) throw new Error('Mount paths cannot contain commas or line breaks.');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Links and junctions are not permitted: ${current}`);
  }
  const stat = lstatSync(path);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Expected plain ${kind}: ${path}`);
  if (realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error(`Path alias rejected: ${path}`);
  return path;
}

function git(checkout, args) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  return execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], {
    maxBuffer: 120 * 1024 * 1024, windowsHide: true,
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

export function snapshot(checkoutInput, revision, destination) {
  const checkout = plainPath(checkoutInput, 'directory');
  plainPath(join(checkout, '.git'), 'directory'); // Linked worktrees/gitfiles are deliberately unsupported.
  for (const path of ['commondir', 'gitdir', 'objects/info/alternates']) {
    if (existsSync(join(checkout, '.git', path))) throw new Error('External Git storage is not supported.');
  }
  function inspectGit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw new Error('Git metadata links are not supported.');
      if (entry.isDirectory()) inspectGit(path);
    }
  }
  inspectGit(join(checkout, '.git'));
  if (!/^[a-f\d]{40}$/i.test(revision)) throw new Error('Use an exact 40-character commit SHA.');
  const head = git(checkout, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
  if (head !== revision.toLowerCase()) throw new Error('Revision does not identify the requested commit.');
  const entries = git(checkout, ['ls-tree', '-rz', '--full-tree', revision]).toString('utf8').split('\0').filter(Boolean);
  if (entries.length > 10000) throw new Error('Snapshot exceeds the 10,000-file limit.');
  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f\d]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error('Snapshot rejects symlinks, submodules, and unsupported Git entries.');
    const [, mode, object, path] = match;
    if (path.split('/').some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || /[\\:\x00-\x1f<>"|?*]/.test(path)) {
      throw new Error(`Unsafe snapshot path: ${path}`);
    }
    if (path.split('/').some(part => ['.local', '.codex', '.agents', 'node_modules', 'target'].includes(part.toLowerCase()))) continue;
    if (/(?:^|\/)\.env(?:\.|$)/i.test(path) && !path.endsWith('.env.example') || /\.(?:pem|key)$/i.test(path)) {
      throw new Error(`Potential secret file must not be tracked in a role snapshot: ${path}`);
    }
    const contents = git(checkout, ['cat-file', 'blob', object]);
    bytes += contents.length;
    if (contents.length > 16 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw new Error('Snapshot size limit exceeded.');
    files.push({ path, mode, contents });
  }
  mkdirSync(destination, { recursive: false });
  for (const file of files) {
    const target = resolve(destination, file.path);
    if (!contained(destination, target)) throw new Error('Snapshot path escapes destination.');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, { mode: file.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
  }
  return { revision: head, files: files.length, bytes };
}

export function credentials(directoryInput, role, checkout, runDirectory) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  const directory = plainPath(directoryInput, 'directory');
  if (contained(checkout, directory) || contained(runDirectory, directory) || contained(directory, checkout)) {
    throw new Error('Credentials must be outside the checkout and run directories.');
  }
  const token = plainPath(join(directory, role, 'github-token'));
  const auth = plainPath(join(directory, role, 'codex-auth.json'));
  readCredentialFiles({ token, auth });
  return { token, auth };
}

function readBoundedSecret(path, limit, label) {
  let file;
  try {
    file = openSync(path, 'r');
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new Error(`Role ${label} must be a regular file.`);
    if (stat.size > limit) throw new Error(`Role ${label} exceeds ${limit} bytes.`);
    // Bound the actual read too, including a file that grows after fstat.
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(file, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > limit) throw new Error(`Role ${label} exceeds ${limit} bytes.`);
    return buffer.toString('utf8', 0, bytes);
  } catch (error) {
    // Do not expose filesystem/parser diagnostics that could quote credential data.
    if (error.message === `Role ${label} exceeds ${limit} bytes.` || error.message === `Role ${label} must be a regular file.`) throw error;
    throw new Error(`Unable to read role ${label}.`);
  } finally { if (file !== undefined) closeSync(file); }
}

function readCredentialFiles({ token, auth }) {
  const githubToken = readBoundedSecret(token, 4096, 'GitHub token').trim();
  const authText = readBoundedSecret(auth, 65536, 'Codex auth');
  if (!githubToken) throw new Error('Role GitHub token is empty.');
  let codexAuth;
  try { codexAuth = JSON.parse(authText); } catch { throw new Error('Codex auth is not valid JSON.'); }
  if (!codexAuth || typeof codexAuth !== 'object' || Array.isArray(codexAuth)) throw new Error('Codex auth must be a JSON object.');
  return { githubToken, codexAuth };
}

export function credentialPayload(files) {
  const { githubToken, codexAuth } = readCredentialFiles(files);
  const payload = Buffer.from(JSON.stringify({ githubToken, codexAuth }));
  if (!githubToken || !codexAuth || typeof codexAuth !== 'object' || Array.isArray(codexAuth) || payload.length > 65536) {
    throw new Error('Invalid or oversized role credential payload.');
  }
  return payload;
}

export function dockerArguments({ role, workspace, task, output, imageId, probe = false, networkProbe = false, proxyVolume }) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  if (!/^sha256:[a-f\d]{64}$/.test(imageId)) throw new Error('Run requires a resolved Docker image ID.');
  const mount = (source, target, readOnly = true) => {
    if (/[\r\n,]/.test(source)) throw new Error('Unsafe Docker mount path.');
    return ['--mount', `type=bind,src=${resolve(source)},dst=${target}${readOnly ? ',readonly' : ''}`];
  };
  const args = ['run', '--rm', '--interactive', '--pull', 'never', '--network', 'none', '--user', '1000:1000', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/home/agent:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700',
    '--env', 'HOME=/home/agent', '--env', 'CODEX_HOME=/home/agent/.codex', '--env', 'GH_CONFIG_DIR=/home/agent/.config/gh',
    '--env', 'GH_PROMPT_DISABLED=1', '--env', 'GIT_TERMINAL_PROMPT=0', '--env', `FACTORY_ROLE=${role}`,
    ...mount(workspace, '/workspace', role !== 'implementation'), ...mount(task, '/task.md'), ...mount(output, '/output', false)];
  if (proxyVolume) {
    if (!/^factory-egress-[a-f\d]{24}$/.test(proxyVolume)) throw new Error('Invalid per-run proxy volume.');
    args.push('--mount', `type=volume,src=${proxyVolume},dst=/proxy,readonly`);
  }
  if (probe && networkProbe) throw new Error('Choose one fixed diagnostic.');
  args.push(imageId, probe ? 'probe' : networkProbe ? 'network-probe' : 'app-server');
  return args;
}

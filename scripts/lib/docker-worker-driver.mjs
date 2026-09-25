// Trusted host adapter. Constructor configuration must come from protected deployment.
import { execFile as nativeExecFile, spawn as nativeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppServerClient } from './app-server-client.mjs';
import { POLICY_VERSION, workerPolicy } from '../../runtime/worker-policy.mjs';
import { IMAGE, ROLES, plainPath, contained, snapshot, credentials, credentialPayload, dockerArguments } from './role-launch.mjs';

const IMAGE_ID = /^sha256:[a-f\d]{64}$/;
const overlap = (a, b) => contained(a, b) || contained(b, a);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hostEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home'].includes(key.toLowerCase())));

export class WorkerPreparationError extends Error {
  constructor(resource) {
    super('Worker preparation failed; cleanup incomplete.');
    this.name = 'WorkerPreparationError';
    this.code = 'PREPARATION_CLEANUP_INCOMPLETE';
    // The manager must retain this handle, not serialize it or release capacity.
    Object.defineProperty(this, 'resource', { value: resource });
  }
}

export class DockerWorkerDriver {
  constructor({ checkout, credentials: credentialRoot, runs, stateDirectory, timeoutMs = 10000,
    closeTimeoutMs = 3000, startupTimeoutMs = 25000, execFile = nativeExecFile, spawn = nativeSpawn, snapshot: takeSnapshot = snapshot }) {
    this.checkout = plainPath(checkout, 'directory');
    this.credentials = plainPath(credentialRoot, 'directory');
    this.runs = plainPath(runs, 'directory');
    const protectedPaths = [this.checkout, this.credentials, this.runs];
    if (stateDirectory) protectedPaths.push(plainPath(stateDirectory, 'directory'));
    for (let i = 0; i < protectedPaths.length; i++) for (let j = i + 1; j < protectedPaths.length; j++) {
      if (overlap(protectedPaths[i], protectedPaths[j])) throw new Error('Launcher roots must not overlap.');
    }
    if (contained(this.runs, resolve(import.meta.dirname, '../..'))) throw new Error('Run root contains trusted deployment.');
    for (const value of [timeoutMs, closeTimeoutMs]) if (!Number.isInteger(value) || value < 1 || value > 60000) throw new Error('Invalid driver timeout.');
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 25000) throw new Error('Invalid startup timeout.');
    Object.assign(this, { timeoutMs, closeTimeoutMs, startupTimeoutMs, execFile, spawn, takeSnapshot });
    this.used = new Set();
  }

  docker(args, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      this.execFile('docker', args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
        maxBuffer: 128 * 1024, killSignal: 'SIGKILL', env: hostEnvironment() }, (error, stdout) => {
        if (error) reject(new Error('Docker operation failed.'));
        else resolve(String(stdout).trim());
      });
    });
  }

  async prepare({ workerId, role, revision, task, ...unknown }) {
    if (Object.keys(unknown).length || !/^[a-f\d]{24}$/.test(workerId) || !ROLES.includes(role) ||
      !/^[a-f\d]{40}$/.test(revision) || typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 65536) {
      throw new Error('Invalid worker assignment.');
    }
    if (this.used.has(workerId)) throw new Error('Worker identifier already used.');
    this.used.add(workerId);
    // A single deadline covers preparation operations, not a fresh budget per retry.
    const deadline = Date.now() + this.startupTimeoutMs;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw new Error('Worker startup deadline exceeded.');
      return Math.min(this.timeoutMs, value);
    };
    const startupDocker = args => this.docker(args, remaining());
    const containerName = `factory-worker-${workerId}`;
    const proxyName = `factory-egress-${workerId}`;
    const volume = proxyName;
    const owner = randomBytes(24).toString('hex');
    const label = `chandler.launcher-owner=${owner}`;
    const removeOwned = async (name, isVolume = false, execute = args => this.docker(args)) => {
      const actual = await execute([isVolume ? 'volume' : 'container', 'inspect', name, '--format',
        isVolume ? '{{index .Labels "chandler.launcher-owner"}}' : '{{index .Config.Labels "chandler.launcher-owner"}}']);
      if (actual !== owner) throw new Error('Resource ownership could not be confirmed.');
      await execute(isVolume ? ['volume', 'rm', name] : ['rm', '--force', name]);
    };
    const directory = join(this.runs, workerId);
    const workspace = join(directory, 'workspace');
    const output = join(directory, 'output');
    const taskPath = join(directory, 'task.md');
    let child, client, volumeOwned = false, proxyOwned = false, workerOwned = false, exited = false;
    // No credentials have been read yet; preserve manager metadata shape on early failure.
    let sanitize = value => value;
    let closing, closed = false;
    const close = async () => {
      if (closed) return;
      if (closing) return closing;
      closing = (async () => {
        let failed = false;
        try { client?.close(); } catch { failed = true; }
        if (child && !exited) {
          try { child.kill('SIGTERM'); } catch { failed = true; }
          const until = Date.now() + this.closeTimeoutMs;
          while (!exited && Date.now() < until) await sleep(Math.min(20, this.closeTimeoutMs));
        }
        if (workerOwned) {
          try { await removeOwned(containerName); workerOwned = false; }
          catch { failed = true; }
        }
        if (child && !exited) {
          try { child.kill('SIGKILL'); } catch { failed = true; }
          const until = Date.now() + this.closeTimeoutMs;
          while (!exited && Date.now() < until) await sleep(Math.min(20, this.closeTimeoutMs));
          if (!exited) failed = true;
        }
        if (proxyOwned) {
          try { await removeOwned(proxyName); proxyOwned = false; }
          catch { failed = true; }
        }
        if (volumeOwned) {
          try { await removeOwned(volume, true); volumeOwned = false; }
          catch { failed = true; }
        }
        if (failed) throw new Error('Worker cleanup incomplete.');
        closed = true;
      })();
      try { await closing; } finally { closing = undefined; }
    };
    try {
      mkdirSync(directory);
      const source = this.takeSnapshot(this.checkout, revision, workspace);
      mkdirSync(output);
      writeFileSync(taskPath, `Source revision: ${source.revision}\n\n${task}`, { flag: 'wx' });
      const imageId = await startupDocker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
      const proxyImage = await startupDocker(['image', 'inspect', 'chandler-factory-egress:0.1', '--format', '{{.Id}}']);
      if (!IMAGE_ID.test(imageId) || !IMAGE_ID.test(proxyImage)) throw new Error('Invalid runtime image.');
      const expected = workerPolicy(role);
      let policy;
      try {
        workerOwned = true;
        policy = JSON.parse(await startupDocker(['run', '--name', containerName, '--label', label, '--pull', 'never', '--network', 'none', '--read-only',
          '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
          '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--env', `FACTORY_ROLE=${role}`, imageId, 'policy']));
      } catch { throw new Error('Runtime policy check failed.'); }
      if (policy?.schema !== 'chandler-worker-policy' || policy.version !== POLICY_VERSION || policy.role !== role ||
        policy.model !== expected.model || policy.effort !== expected.effort || policy.transport !== 'app-server-stdio' ||
        policy.features?.multi_agent !== false || policy.features?.multi_agent_v2 !== false ||
        policy.features?.default_mode_request_user_input !== true) throw new Error('Incompatible runtime policy.');
      await removeOwned(containerName, false, startupDocker); workerOwned = false;
      // Read only the selected role, after policy acceptance. Never put secrets in arguments or mounts.
      const files = credentials(this.credentials, role, this.checkout, directory);
      volumeOwned = true;
      await startupDocker(['volume', 'create', '--label', label, volume]);
      if (await startupDocker(['volume', 'inspect', volume, '--format', '{{index .Labels "chandler.launcher-owner"}}']) !== owner) {
        throw new Error('Proxy volume ownership could not be confirmed.');
      }
      proxyOwned = true;
      await startupDocker(['run', '-d', '--pull', 'never', '--name', proxyName, '--label', label, '--network', 'bridge', '--user', '1000:1000',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
        '--mount', `type=volume,src=${volume},dst=/proxy`, proxyImage]);
      let ready = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          await startupDocker(['exec', proxyName, 'node', '-e', 'if (!require("node:fs").statSync("/proxy/egress.sock").isSocket()) process.exit(1)']);
          ready = true; break;
        } catch { if (Date.now() >= deadline) break; if (attempt < 24) await sleep(Math.min(200, deadline - Date.now())); }
      }
      if (!ready) throw new Error('Egress proxy unavailable.');
      const args = dockerArguments({ role, workspace, task: taskPath, output, imageId, proxyVolume: volume });
      // Retain stopped containers until explicit removal so cleanup is observable and retryable.
      args.splice(args.indexOf('--rm'), 1);
      args.splice(1, 0, '--name', containerName, '--label', label);
      const payload = credentialPayload(files);
      const secretValues = [];
      const collect = value => {
        if (typeof value === 'string' && value) secretValues.push(value);
        else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
      };
      collect(JSON.parse(payload.toString()));
      secretValues.sort((a, b) => b.length - a.length);
      sanitize = value => {
        if (typeof value === 'string') return secretValues.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), sanitize(item)]));
        return value;
      };
      try {
        remaining();
        workerOwned = true;
        child = this.spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: hostEnvironment() });
        child.once('exit', () => { exited = true; });
        child.on('error', () => { exited = true; child.stdout.destroy(new Error('Worker transport failed.')); });
        // Drain diagnostics without retaining or forwarding potentially sensitive runtime text.
        child.stderr?.resume();
        client = new AppServerClient(child.stdout, child.stdin, { timeoutMs: this.timeoutMs, maxLineBytes: 1048576, maxPending: 64 });
        const packet = Buffer.concat([payload, Buffer.from('\n')]);
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Credential handoff timed out.')), remaining());
            try { child.stdin.write(packet, error => { clearTimeout(timer); error ? reject(new Error('Credential handoff failed.')) : resolve(); }); }
            catch { clearTimeout(timer); reject(new Error('Credential handoff failed.')); }
          });
        } finally { packet.fill(0); }
      } finally { payload.fill(0); }
      return { client, source, artifacts: { directory, workspace, output, task: taskPath },
        runtime: { containerName, imageId, proxyImage, policy: { schema: policy.schema, version: policy.version,
          role, model: expected.model, effort: expected.effort, features: { multi_agent: false, multi_agent_v2: false,
            default_mode_request_user_input: true }, transport: policy.transport } }, close, sanitize };
    } catch {
      try { await close(); } catch {
        throw new WorkerPreparationError({ close, artifacts: { directory, workspace, output, task: taskPath },
          runtime: { containerName, proxyName, volume }, sanitize });
      }
      throw new Error('Worker preparation failed.');
    }
  }
}

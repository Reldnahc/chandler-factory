#!/usr/bin/env node
import { openSync, readSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, serve } from './lib/launcher-interface.mjs';
import { plainPath } from './lib/role-launch.mjs';

// No credentials are read until an explicitly enabled worker operation needs them.
let store;
const shutdownError = () => { process.stderr.write('Launcher cleanup failed; inspect retained state before restarting.\n'); process.exitCode = 1; };
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) throw new Error('Invalid startup arguments.');
  const fd = openSync(plainPath(args[1], 'file'), 'r');
  const bytes = Buffer.alloc(16385);
  let count = 0;
  try {
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
  } finally { closeSync(fd); }
  if (count > 16384) throw new Error('Configuration exceeds limit.');
  const config = validateConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))), dirname(dirname(fileURLToPath(import.meta.url))));
  const { WorkerManager } = await import('./lib/worker-manager.mjs');
  const { FileWorkerStore } = await import('./lib/worker-store.mjs');
  const { DockerWorkerDriver } = await import('./lib/docker-worker-driver.mjs');
  store = new FileWorkerStore({ directory: config.state });
  const manager = new WorkerManager({ driver: new DockerWorkerDriver({ checkout: config.checkout, credentials: config.credentials, runs: config.runs, stateDirectory: config.state }), store, maxWorkers: config.maxWorkers });
  const server = serve({ input: process.stdin, output: process.stdout, manager, enableWorkerRuns: config.enableWorkerRuns, onShutdownError: shutdownError });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.stop().catch(shutdownError).finally(() => { process.stdin.destroy(); }); });
} catch {
  try { store?.close(); } catch { shutdownError(); }
  process.stderr.write('Launcher startup failed: provide a valid absolute --config file with separate plain directories.\n');
  process.exitCode = 1;
}

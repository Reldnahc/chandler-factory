import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const empty = () => ({ version: 1, workers: [], requests: [] });
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.workers) || !Array.isArray(value.requests)) {
    throw new Error('Invalid launcher state; restore trusted state before accepting assignments');
  }
  return value;
}

export class MemoryWorkerStore {
  constructor({ maxEvents = 200, maxRequests = 2000 } = {}) {
    this.maxEvents = maxEvents;
    this.maxRequests = maxRequests;
    this.value = empty();
  }
  load() { return structuredClone(this.value); }
  save(value) { this.value = structuredClone(validate(value)); }
  close() {}
}

// directory is a trusted host configuration value, never a worker/caller path.
// One launcher owns a store. Keys are never evicted: reaching capacity requires
// explicit archival/new state, so an old uncertain request can never be replayed.
export class FileWorkerStore {
  constructor({ directory, maxEvents = 200, maxRequests = 2000 }) {
    if (!path.isAbsolute(directory)) throw new Error('State directory must be absolute');
    this.directory = directory;
    this.maxEvents = maxEvents;
    this.maxRequests = maxRequests;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(directory, 'workers.json');
    this.lockfile = path.join(directory, 'launcher.lock');
    try {
      this.lock = fs.openSync(this.lockfile, 'wx', 0o600);
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    } catch {
      throw new Error('Launcher state is locked; stop its owner or explicitly recover a stale lock before opening');
    }
  }
  load() {
    if (!fs.existsSync(this.filename)) return empty();
    if (fs.statSync(this.filename).size > 32 * 1024 * 1024) throw new Error('Launcher state exceeds size limit');
    return validate(JSON.parse(fs.readFileSync(this.filename, 'utf8')));
  }
  save(value) {
    if (this.lock === undefined) throw new Error('Launcher store is closed');
    const data = JSON.stringify(validate(value));
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('Launcher state exceeds size limit');
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.filename);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  close() {
    if (this.lock === undefined) return;
    fs.closeSync(this.lock);
    this.lock = undefined;
    fs.unlinkSync(this.lockfile);
  }
}

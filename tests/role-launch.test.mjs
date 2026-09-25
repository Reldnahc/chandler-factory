import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, dockerArguments, credentials, credentialPayload, contained } from '../scripts/lib/role-launch.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-role-test-'));
  t.after(() => { assert.ok(contained(tmpdir(), root)); rmSync(root, { recursive: true, force: true }); });
  const checkout = join(root, 'repo'); mkdirSync(checkout);
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = () => { git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { root, checkout, git, commit };
}

test('snapshot takes exact committed content and never copies host Git/config state', t => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, 'work.txt'), 'committed');
  mkdirSync(join(f.checkout, '.codex')); writeFileSync(join(f.checkout, '.codex', 'config.toml'), 'bad config');
  mkdirSync(join(f.checkout, '.AGENTS')); writeFileSync(join(f.checkout, '.AGENTS', 'skill.md'), 'untrusted skill');
  const revision = f.commit();
  writeFileSync(join(f.checkout, 'work.txt'), 'uncommitted');
  writeFileSync(join(f.checkout, 'untracked.txt'), 'not included');
  const destination = join(f.root, 'snapshot');
  const result = snapshot(f.checkout, revision, destination);
  assert.equal(readFileSync(join(destination, 'work.txt'), 'utf8'), 'committed');
  assert.equal(existsSync(join(destination, '.git')), false);
  assert.equal(existsSync(join(destination, '.codex')), false);
  assert.equal(existsSync(join(destination, '.AGENTS')), false);
  assert.equal(existsSync(join(destination, 'untracked.txt')), false);
  assert.equal(result.revision, revision);
});

test('snapshot refuses symbolic-link Git entries before writing any files', t => {
  const f = fixture(t); writeFileSync(join(f.checkout, 'file'), 'base'); f.commit();
  const object = execFileSync('git', ['-C', f.checkout, 'hash-object', '-w', '--stdin'], { input: '../../owner-token', encoding: 'utf8', windowsHide: true }).trim();
  f.git('update-index', '--add', '--cacheinfo', `120000,${object},escape`);
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'link fixture');
  const destination = join(f.root, 'snapshot');
  assert.throws(() => snapshot(f.checkout, f.git('rev-parse', 'HEAD'), destination), /symlinks/);
  assert.equal(existsSync(destination), false);
});

test('snapshot refuses Git alternates and worktree gitfiles', t => {
  const f = fixture(t); writeFileSync(join(f.checkout, 'file'), 'base'); const revision = f.commit();
  const alternate = join(f.checkout, '.git', 'objects', 'info', 'alternates');
  writeFileSync(alternate, '/owner/private-repository/.git/objects');
  assert.throws(() => snapshot(f.checkout, revision, join(f.root, 'out')), /External Git storage/);
  const linked = join(f.root, 'linked'); mkdirSync(linked); writeFileSync(join(linked, '.git'), 'gitdir: ../repo/.git');
  assert.throws(() => snapshot(linked, revision, join(f.root, 'out2')), /plain directory/);
});

test('snapshot rejects tracked secret files and symbolic revision names', t => {
  const f = fixture(t); writeFileSync(join(f.checkout, '.env'), 'FAKE=fixture'); const revision = f.commit();
  assert.throws(() => snapshot(f.checkout, revision, join(f.root, 'out')), /Potential secret file/);
  assert.throws(() => snapshot(f.checkout, 'HEAD', join(f.root, 'out2')), /40-character/);
});

test('snapshot rejects Windows device names and filename aliases from Git objects', t => {
  const f = fixture(t);
  const object = execFileSync('git', ['-C', f.checkout, 'hash-object', '-w', '--stdin'], { input: 'fixture', encoding: 'utf8', windowsHide: true }).trim();
  for (const name of ['file.', '.codex.', 'CON', 'nested ', 'bad?name']) {
    const tree = execFileSync('git', ['-C', f.checkout, 'mktree'], { input: `100644 blob ${object}\t${name}\n`, encoding: 'utf8', windowsHide: true }).trim();
    const revision = f.git('commit-tree', tree, '-m', 'unsafe pathname fixture');
    assert.throws(() => snapshot(f.checkout, revision, join(f.root, 'output')), /Unsafe snapshot path/);
  }
});

const inputs = { role: 'implementation', workspace: resolve('workspace'), task: resolve('task.md'), output: resolve('output'),
  token: resolve('token'), auth: resolve('auth.json'), imageId: `sha256:${'a'.repeat(64)}` };

test('all roles have no network, host namespace, inherited environment, or Docker socket', () => {
  for (const role of ['coordinator', 'implementation', 'reviewer']) {
    const args = dockerArguments({ ...inputs, role });
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.ok(args.includes('--read-only')); assert.ok(args.includes('no-new-privileges=true'));
    assert.equal(args.some(arg => /docker\.sock|privileged|network=host|pid=host|GH_TOKEN=/.test(arg)), false);
    assert.equal(args.filter(arg => arg.startsWith('type=bind')).length, 3);
    assert.ok(args.includes('--interactive'));
    assert.equal(args.some(arg => arg.includes('dst=/secrets')), false);
    const workspace = args.find(arg => arg.includes('dst=/workspace'));
    assert.equal(workspace.endsWith(',readonly'), role !== 'implementation');
  }
});

test('launcher rejects arbitrary roles, image tags, mount injection, and proxy identifiers', () => {
  assert.throws(() => dockerArguments({ ...inputs, role: 'owner' }), /Unknown role/);
  assert.throws(() => dockerArguments({ ...inputs, imageId: 'untrusted:latest' }), /image ID/);
  assert.throws(() => dockerArguments({ ...inputs, workspace: 'repo,src=/owner' }), /Unsafe Docker mount/);
  assert.throws(() => dockerArguments({ ...inputs, proxyVolume: 'shared-owner-home' }), /proxy volume/);
});

test('credentials are chosen from one role and cannot be within the checkout', t => {
  const f = fixture(t);
  const root = join(f.root, 'credentials'); mkdirSync(root);
  for (const role of ['implementation', 'reviewer']) {
    mkdirSync(join(root, role)); writeFileSync(join(root, role, 'github-token'), `synthetic-${role}`);
    writeFileSync(join(root, role, 'codex-auth.json'), '{}');
  }
  const selected = credentials(root, 'reviewer', f.checkout, join(f.root, 'run'));
  assert.equal(selected.token, join(root, 'reviewer', 'github-token'));
  assert.deepEqual(JSON.parse(credentialPayload(selected).toString()), { githubToken: 'synthetic-reviewer', codexAuth: {} });
  mkdirSync(join(f.checkout, 'secrets'));
  assert.throws(() => credentials(join(f.checkout, 'secrets'), 'reviewer', f.checkout, join(f.root, 'run')), /outside the checkout/);
  assert.throws(() => credentials(root, 'coordinator', f.checkout, join(f.root, 'run')), /ENOENT/);
});

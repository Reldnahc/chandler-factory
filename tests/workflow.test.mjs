import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateIssue, STATUSES } from '../scripts/lib/workflow.mjs';

const issue = overrides => ({ number: 42, title: 'Ship workflow', body: '', state: 'OPEN', stateReason: null,
  status: 'Ready', priority: 'High', blockedBy: [], ...overrides });
const pr = overrides => ({ url: 'https://github.com/example/repo/pull/43', headSha: 'abc123', merged: true,
  checkConclusion: 'SUCCESS', review: { reviewer: 'reviewer', author: 'author', headSha: 'abc123', decision: 'APPROVED' }, ...overrides });
const done = overrides => issue({ status: 'Done', state: 'CLOSED', stateReason: 'COMPLETED', pullRequests: [pr()], ...overrides });
const fails = (snapshot, message) => assert.ok(validateIssue(snapshot).some(error => message.test(error)),
  `Expected ${message}, got ${JSON.stringify(validateIssue(snapshot))}`);

test('active statuses accept open issues and reject closure', () => {
  for (const status of STATUSES.filter(value => !['Done', 'Cancelled'].includes(value))) {
    const snapshot = issue({ status, body: '## Blocked: Awaiting API key\nUnblocks when: Maintainer supplies the key.' });
    assert.deepEqual(validateIssue(snapshot), []);
    fails({ ...snapshot, state: 'CLOSED' }, /requires an open issue/);
  }
});
test('missing and unknown status or priority fail', () => {
  for (const status of [undefined, '', 'Closed']) fails(issue({ status }), /Status/);
  for (const priority of [undefined, '', 'Urgent']) fails(issue({ priority }), /Priority/);
});
test('blocker requires a reason on the first meaningful line', () => {
  for (const body of ['', '# Blocked: #\nUnblocks when: Access is restored.', '## Blocked:\nUnblocks when: Access is restored.', 'Summary\n## Blocked: Missing access\nUnblocks when: Access is restored.']) {
    fails(issue({ status: 'Blocked', body }), /first meaningful/);
  }
});
test('blocker requires an actionable unblocking line', () => {
  fails(issue({ status: 'Blocked', body: '# Blocked: Missing access\nUnblocks when: ' }), /nonempty "Unblocks when/);
});
test('blocker headline may follow blank lines and hidden template comments', () => {
  assert.deepEqual(validateIssue(issue({ status: 'Blocked', body: '\n<!-- template\ncomment -->\n## Blocked: Missing access\nUnblocks when: Admin grants access.' })), []);
});
test('cancelled issue preserves reason and closes as not planned', () => {
  for (const body of ['# Cancelled: Replaced by issue #52', '## Cancellation reason\nReplaced by issue #52', '## Cancellation reason ##\nReplaced by issue #52']) {
    assert.deepEqual(validateIssue(issue({ status: 'Cancelled', state: 'CLOSED', stateReason: 'NOT_PLANNED', body })), []);
  }
  fails(issue({ status: 'Cancelled', state: 'CLOSED', stateReason: 'COMPLETED', body: 'Cancelled: Superseded.' }), /NOT_PLANNED/);
  fails(issue({ status: 'Cancelled', state: 'CLOSED', stateReason: 'NOT_PLANNED', body: '## Cancellation reason\n## Notes' }), /preserved cancellation reason/);
  for (const body of ['# Cancelled: #', '## Cancellation reason: ##']) {
    fails(issue({ status: 'Cancelled', state: 'CLOSED', stateReason: 'NOT_PLANNED', body }), /preserved cancellation reason/);
  }
});
test('cancelled closure never qualifies as Done', () => {
  fails(done({ stateReason: 'NOT_PLANNED', body: 'Cancelled: Superseded.' }), /cancellation is not completion/);
});
test('cancellation reason can be retained in comments without accepting malformed comments', () => {
  const snapshot = issue({ status: 'Cancelled', state: 'CLOSED', stateReason: 'NOT_PLANNED' });
  assert.deepEqual(validateIssue({ ...snapshot, comments: [{ body: '## Cancellation reason\nSuperseded by issue #52.' }] }), []);
  for (const comments of [null, {}, [null], [{ body: 42 }]]) fails({ ...snapshot, comments }, /comments must be an array/);
});
test('Ready accepts completed prerequisites and rejects merely closed or cancelled ones', () => {
  assert.deepEqual(validateIssue(issue({ blockedBy: [{ number: 10, state: 'CLOSED', stateReason: 'COMPLETED' }] })), []);
  for (const prerequisite of [{ state: 'OPEN', stateReason: null }, { state: 'CLOSED' }, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }]) {
    fails(issue({ blockedBy: [{ number: 10, ...prerequisite }] }), /prerequisite #10/);
  }
});
test('Done requires a closed completed issue and accepts reviewed document PRs', () => {
  assert.deepEqual(validateIssue(done({ title: 'Document research findings' })), []);
  fails(done({ state: 'OPEN' }), /closed issue/);
  fails(done({ stateReason: null }), /COMPLETED/);
});
test('Done rejects open or cancelled prerequisites despite valid PR evidence', () => {
  for (const dependency of [{ state: 'OPEN', stateReason: null }, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }]) {
    fails(done({ blockedBy: [{ number: 10, ...dependency }] }), /Done requires prerequisite #10/);
  }
});
test('Done cannot omit a completion PR', () => {
  for (const pullRequests of [undefined, [], {}]) fails(done({ pullRequests }), /cannot verify: initial auditor only supports PR-backed completion/);
});
test('every supplied completion PR must have merged', () => {
  fails(done({ pullRequests: [pr(), pr({ merged: false })] }), /PR 2 must be merged/);
});
test('pending, failed, or skipped checks cannot complete work', () => {
  for (const checkConclusion of [undefined, 'FAILURE', 'PENDING', 'SKIPPED']) {
    fails(done({ pullRequests: [pr({ checkConclusion })] }), /successful checks/);
  }
});
test('approval of a previous head is stale', () => {
  fails(done({ pullRequests: [pr({ headSha: 'new456' })] }), /exact current head/);
});
test('self approval fails even when login casing differs', () => {
  const review = { ...pr().review, reviewer: 'AUTHOR' };
  fails(done({ pullRequests: [pr({ review })] }), /someone other than its author/);
});
test('missing review or non-approval decision fails', () => {
  for (const review of [undefined, { ...pr().review, decision: 'CHANGES_REQUESTED' }]) {
    fails(done({ pullRequests: [pr({ review })] }), /APPROVED review/);
  }
});
test('malformed input reports violations without crashing or mutating the snapshot', () => {
  assert.deepEqual(validateIssue(null), ['Issue must be an object.']);
  fails(issue({ blockedBy: {} }), /must be an array/);
  fails(issue({ blockedBy: [{ number: { toString: null, valueOf: null }, state: 'OPEN' }] }), /prerequisite #\?/);
  fails(done({ pullRequests: [null] }), /must be an object/);
  const snapshot = done(); const copy = structuredClone(snapshot);
  validateIssue(snapshot); assert.deepEqual(snapshot, copy);
});
test('CLI audits supplied files and returns failure for violations or invalid JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-audit-'));
  const path = join(directory, 'snapshot.json');
  const cli = fileURLToPath(new URL('../scripts/check-workflow.mjs', import.meta.url));
  try {
    for (const snapshot of [done(), [done()], { issues: [done()] }]) {
      await writeFile(path, JSON.stringify(snapshot));
      assert.equal(spawnSync(process.execPath, [cli, path], { encoding: 'utf8' }).status, 0);
    }
    for (const content of [JSON.stringify(done({ pullRequests: [] })), JSON.stringify({ number: { toString: null, valueOf: null } }), '{ invalid', '[]']) {
      await writeFile(path, content);
      const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
      assert.equal(result.status, 1); assert.match(result.stderr, /Workflow audit failed/);
    }
  } finally { await rm(path, { force: true }); await rmdir(directory); }
});

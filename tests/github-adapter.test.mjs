import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssues, completionUrls, normalizePullRequest, loadSnapshot } from '../scripts/audit-github.mjs';
import { validateIssue } from '../scripts/lib/workflow.mjs';

const repository = 'Reldnahc/chandler-factory';
const url = `https://github.com/${repository}/pull/9`;
const item = { content: { type: 'Issue', repository, number: 1 }, status: 'Ready', priority: 'High' };
const project = () => ({ items: [structuredClone(item)], totalCount: 1 });
const tracked = () => [{ number: 1, labels: [{ name: 'story' }] }];
const review = overrides => ({ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: 'abc' }, submittedAt: '2026-09-24T12:00:00Z', ...overrides });
const pr = overrides => ({ url, headRefOid: 'abc', author: { login: 'author' }, mergedAt: '2026-09-24T13:00:00Z',
  reviews: [review()], statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...overrides });
const auditPr = input => validateIssue({ number: 1, status: 'Done', priority: 'High', state: 'CLOSED', stateReason: 'COMPLETED', pullRequests: [normalizePullRequest(input)] });

test('Project selection filters other repositories and preserves native fields', () => {
  const data = project(); data.items.push({ content: { type: 'Issue', repository: 'other/repo', number: 2 } }); data.totalCount++;
  assert.deepEqual(selectIssues(data, tracked(), repository), [item]);
});
test('partial Project, saturated issue lists, missing tracked issues and duplicates fail closed', () => {
  assert.throws(() => selectIssues({ ...project(), totalCount: 2 }, tracked(), repository), /incomplete/);
  assert.throws(() => selectIssues(project(), Array(1000).fill(tracked()[0]), repository), /completeness/);
  assert.throws(() => selectIssues(project(), [{ number: 2, labels: [{ name: 'epic' }] }], repository), /#2.*missing/);
  assert.throws(() => selectIssues({ items: [item, item], totalCount: 2 }, tracked(), repository), /duplicate/);
});
test('completion evidence requires an explicit same-repository PR line', () => {
  assert.deepEqual(completionUrls(`See ${url}`, repository), []);
  assert.deepEqual(completionUrls(`Completion PR: ${url}\nCompletion PR: ${url}`, repository), [url]);
  assert.deepEqual(completionUrls(`<!-- Completion PR: ${url} -->`, repository), []);
  assert.throws(() => completionUrls('Completion PR: https://github.com/other/repo/pull/9', repository), /this repository/);
});
test('current-head independent approval with completed checks passes', () => assert.deepEqual(auditPr(pr()), []));
test('missing, pending, skipped, failed or unknown checks cannot pass', () => {
  for (const statusCheckRollup of [[], [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: 'SUCCESS' }],
    [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }], [{ __typename: 'StatusContext', state: 'FAILURE' }], [{ state: 'SUCCESS' }]]) {
    assert.ok(auditPr(pr({ statusCheckRollup })).some(message => /successful checks/.test(message)));
  }
  assert.deepEqual(auditPr(pr({ statusCheckRollup: [{ __typename: 'StatusContext', state: 'SUCCESS' }] })), []);
});
test('stale or self approval never qualifies', () => {
  for (const approval of [review({ commit: { oid: 'old' } }), review({ author: { login: 'AUTHOR' } })]) {
    assert.ok(auditPr(pr({ reviews: [approval] })).some(message => /APPROVED review/.test(message)));
  }
});
test('later review changes revoke approval while comments do not', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    assert.ok(auditPr(pr({ reviews: [review(), review({ state, submittedAt: '2026-09-24T12:30:00Z' })] })).length > 0);
  }
  assert.deepEqual(auditPr(pr({ reviews: [review(), review({ state: 'COMMENTED', submittedAt: '2026-09-24T12:30:00Z' })] })), []);
  assert.ok(auditPr(pr({ reviewDecision: 'CHANGES_REQUESTED' })).length > 0);
  assert.throws(() => normalizePullRequest(pr({ reviews: [review(), review({ state: 'CHANGES_REQUESTED' })] })), /Ambiguous/);
});
test('adapter resolves dependency closure reasons and rejects partial native connections', () => {
  const calls = [];
  const dependency = { number: 2, url: `https://github.com/${repository}/issues/2` };
  let totalCount = 1;
  const gh = args => {
    calls.push(args);
    if (args[0] === 'project') return project();
    if (args[1] === 'list') return tracked();
    if (args[2] === dependency.url) return { number: 2, state: 'CLOSED', stateReason: 'NOT_PLANNED' };
    return { number: 1, body: '', state: 'OPEN', blockedBy: { nodes: [dependency], totalCount } };
  };
  const config = { repository, owner: 'Reldnahc', number: 2 };
  const snapshot = loadSnapshot(config, gh);
  assert.ok(validateIssue(snapshot.issues[0]).some(message => /prerequisite #2/.test(message)));
  assert.ok(calls.some(args => args[2] === dependency.url && args.includes('state,stateReason,number')));
  totalCount = 2;
  assert.throws(() => loadSnapshot(config, gh), /#1.*incomplete/);
});
test('Done adapter loads explicit PR evidence and rejects a head changed during reading', () => {
  let head = 'abc';
  const gh = args => {
    if (args[0] === 'project') return { items: [{ ...item, status: 'Done' }], totalCount: 1 };
    if (args[1] === 'list') return tracked();
    if (args[0] === 'pr') return args.at(-1) === 'headRefOid' ? { headRefOid: head } : pr();
    assert.ok(args.at(-1).includes('comments'));
    return { number: 1, body: `Completion PR: ${url}`, comments: [], state: 'CLOSED', stateReason: 'COMPLETED', blockedBy: { nodes: [], totalCount: 0 } };
  };
  const config = { repository, owner: 'Reldnahc', number: 2 };
  assert.deepEqual(validateIssue(loadSnapshot(config, gh).issues[0]), []);
  head = 'changed';
  assert.throws(() => loadSnapshot(config, gh), /#1.*head changed/);
});

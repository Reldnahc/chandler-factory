import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, publishReviewCheck, REPOSITORY, CHECK_NAME, REVIEWER_APP_ID } from '../scripts/publish-review-check.mjs';

const revision = 'a'.repeat(40);
const viewer = { login: 'reldnahc-chandler-reviewer[bot]', id: 'BOT_NODE' };
const review = overrides => ({ id: 12, user: { login: viewer.login, node_id: viewer.id, type: 'Bot' }, state: 'APPROVED',
  submitted_at: '2026-09-25T01:00:00Z', commit_id: revision, html_url: `https://github.com/${REPOSITORY}/pull/8#pullrequestreview-12`,
  body: 'Inspected the scoped implementation and verified the workflow tests pass with the requested negative cases.', ...overrides });
const pull = overrides => ({ number: 8, html_url: `https://github.com/${REPOSITORY}/pull/8`, state: 'open', merged: false,
  head: { sha: revision }, base: { ref: 'workflow-boundary-trial', sha: 'b'.repeat(40), repo: { full_name: REPOSITORY } },
  user: { login: 'reldnahc-chandler-implementer[bot]', node_id: 'AUTHOR_NODE' }, ...overrides });
function fixture({ identity = viewer, pulls = [pull(), pull()], pages = [[review()]], finalPages = pages, response = {} } = {}) {
  const calls = []; let reads = 0; let reviewReads = 0;
  const gh = (args, body) => {
    calls.push({ args, body });
    assert.ok(args.includes('--hostname') && args.includes('github.com'));
    if (args[1] === 'graphql') return { data: { viewer: identity } };
    if (args[1].includes('/reviews?')) { assert.ok(args.includes('--paginate') && args.includes('--slurp')); return reviewReads++ ? finalPages : pages; }
    if (args.includes('POST')) return { ...body, app: { id: REVIEWER_APP_ID }, html_url: 'https://github.com/check/1', ...response };
    return pulls[reads++];
  };
  return { calls, run: () => publishReviewCheck({ pr: 8, revision }, gh) };
}
function rejected(options, message) {
  const f = fixture(options); assert.throws(f.run, message);
  assert.equal(f.calls.filter(call => call.args.includes('POST')).length, 0);
}
function failed(options, message) {
  const f = fixture(options); assert.equal(f.run().conclusion, 'failure');
  assert.match(f.calls.at(-1).body.output.summary, message);
  assert.equal(f.calls.at(-1).body.head_sha, revision);
}

test('CLI accepts only PR and exact revision, with no selectable destination or conclusion', () => {
  assert.deepEqual(parseArgs(['--pr', '8', '--revision', revision]), { pr: 8, revision });
  for (const args of [[], ['--pr', '8', '--revision', 'abc'], ['--pr', '8', '--pr', '9'], ['--conclusion', 'success'], ['--pr', '-1', '--revision', revision]]) {
    assert.throws(() => parseArgs(args));
  }
});
test('exact trusted current-head approval publishes fixed success linked to real review', () => {
  const f = fixture({ pages: [[], [review()]] }); const result = f.run();
  assert.equal(result.conclusion, 'success');
  const post = f.calls.find(call => call.args.includes('POST'));
  assert.equal(post.args[1], `repos/${REPOSITORY}/check-runs`);
  assert.deepEqual([post.body.name, post.body.head_sha, post.body.details_url], [CHECK_NAME, revision, review().html_url]);
});
test('changes requested publishes failure and never lets the caller choose success', () => {
  const f = fixture({ pages: [[review({ state: 'CHANGES_REQUESTED' })]] });
  assert.equal(f.run().conclusion, 'failure');
  assert.equal(f.calls.at(-1).body.conclusion, 'failure');
});
test('only exact known bot spellings and the authenticated bot node ID are trusted', () => {
  rejected({ identity: { ...viewer, login: 'Reldnahc' } }, /Authenticated identity/);
  failed({ pages: [[review({ user: { login: 'app/reldnahc-chandler-reviewer', node_id: viewer.id, type: 'Bot' } })]] }, /does not match/);
  failed({ pages: [[review({ user: { ...review().user, node_id: 'OTHER' } })]] }, /does not match/);
  failed({ pages: [[review(), review({ id: 13, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-25T01:01:00Z', user: { node_id: viewer.id, type: 'Bot' } })]] }, /does not match/);
  assert.equal(fixture({ pages: [[review({ user: { ...review().user, login: 'reldnahc-chandler-reviewer' } })]] }).run().conclusion, 'success');
});
test('self-review, changed head, wrong repository and closed PR fail before publication', () => {
  for (const changed of [pull({ user: { login: viewer.login, node_id: viewer.id } }), pull({ head: { sha: 'c'.repeat(40) } }),
    pull({ base: { ...pull().base, repo: { full_name: 'other/repo' } } }), pull({ state: 'closed', merged: true })]) {
    rejected({ pulls: [changed] }, /own PR|current PR head|repository|open, unmerged/);
  }
});
test('latest review across all commits controls the result; stale and dismissed cannot authorize', () => {
  const later = review({ id: 13, submitted_at: '2026-09-25T01:01:00Z', commit_id: 'c'.repeat(40) });
  failed({ pages: [[review()], [later]] }, /stale/);
  failed({ pages: [[review(), { ...later, commit_id: revision, state: 'DISMISSED' }]] }, /dismissed/);
  failed({ pages: [[review({ state: 'COMMENTED' })]] }, /No substantive/);
  failed({ pages: [] }, /Incomplete/);
  failed({ pages: [[review({ submitted_at: { toString: null, valueOf: null } })]] }, /timestamp/);
});
test('ties, missing evidence and forged review links fail closed', () => {
  failed({ pages: [[review(), review({ id: 13, state: 'CHANGES_REQUESTED' })]] }, /Conflicting/);
  for (const body of ['', 'LGTM', 'TODO evidence '.repeat(10), '<!-- long fabricated evidence stays hidden and does not establish a review -->']) failed({ pages: [[review({ body })]] }, /substantive scope/);
  failed({ pages: [[review({ html_url: 'https://example.com/review' })]] }, /evidence URL/);
});
test('review and PR reads are refreshed immediately before publication', () => {
  failed({ finalPages: [[review({ state: 'CHANGES_REQUESTED' })]] }, /Review changed/);
  rejected({ pulls: [pull(), pull({ head: { sha: 'c'.repeat(40) } })] }, /current PR head/);
  rejected({ pulls: [pull(), pull({ base: { ...pull().base, ref: 'different' } })] }, /base or author changed/);
});
test('unexpected check source, SHA, conclusion or name is never reported as verified', () => {
  for (const response of [{ app: { id: 15368 } }, { head_sha: 'c'.repeat(40) }, { conclusion: 'neutral' }, { name: 'Other check' }]) {
    assert.throws(fixture({ response }).run, /Published response did not match/);
  }
});

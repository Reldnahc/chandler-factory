#!/usr/bin/env node
// Run only as the reviewer role. This helper does not provision credentials or permissions.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'Reldnahc/chandler-factory';
export const REVIEWER_APP_ID = 5067522;
export const CHECK_NAME = 'Independent review';
const bot = 'reldnahc-chandler-reviewer';
const knownReviewer = login => login === bot || login === `${bot}[bot]`;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const api = (endpoint, ...args) => ['api', endpoint, '--hostname', 'github.com', ...args];
const ghJson = (args, body) => JSON.parse(execFileSync('gh', args, {
  encoding: 'utf8', shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 16 * 1024 * 1024, input: body === undefined ? undefined : JSON.stringify(body),
}));

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert(['--pr', '--revision'].includes(name) && options[name] === undefined && present(args[index + 1]), 'Only --pr N --revision <40-character SHA> are accepted.');
    options[name] = args[index + 1];
  }
  const pr = Number(options['--pr']);
  assert(/^[1-9]\d*$/.test(options['--pr']) && Number.isSafeInteger(pr) && sha(options['--revision']), 'A positive PR number and exact lowercase 40-character revision are required.');
  return { pr, revision: options['--revision'] };
}

function verifyPull(pull, number, revision, viewer) {
  assert(pull?.number === number && pull.html_url === `https://github.com/${REPOSITORY}/pull/${number}`
    && pull.base?.repo?.full_name === REPOSITORY && present(pull.base.ref) && sha(pull.base.sha), 'Unexpected PR repository, base, or identity.');
  assert(pull.state === 'open' && pull.merged === false, 'Review checks require an open, unmerged PR.');
  assert(pull.head?.sha === revision, 'Requested revision is not the current PR head.');
  assert(present(pull.user?.login) && present(pull.user?.node_id), 'Missing PR author identity.');
  assert(!knownReviewer(pull.user.login) && pull.user.node_id !== viewer.id, 'The reviewer cannot approve its own PR.');
}

export function selectReview(reviews, viewer, revision, number) {
  assert(Array.isArray(reviews), 'Missing complete review history.');
  const trusted = reviews.filter(review => knownReviewer(review?.user?.login) || review?.user?.node_id === viewer.id);
  for (const review of trusted) {
    assert(knownReviewer(review.user.login) && review.user.type === 'Bot' && review.user.node_id === viewer.id, 'Review author does not match the authenticated reviewer bot.');
    assert(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(review.state), 'Unsupported reviewer state.');
  }
  const substantive = trusted.filter(review => !['COMMENTED', 'PENDING'].includes(review.state));
  assert(substantive.length > 0, 'No substantive review from the designated reviewer bot.');
  for (const review of substantive) assert(Number.isSafeInteger(review.id) && review.id > 0
    && timestamp(review.submitted_at), 'Malformed review identity or timestamp.');
  substantive.sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
  for (let index = 1; index < substantive.length; index++) assert(substantive[index].id !== substantive[index - 1].id
    && Date.parse(substantive[index].submitted_at) !== Date.parse(substantive[index - 1].submitted_at), 'Conflicting or duplicate review history.');
  const review = substantive.at(-1);
  assert(review.commit_id === revision, 'Latest reviewer decision is stale for the requested revision.');
  assert(['APPROVED', 'CHANGES_REQUESTED'].includes(review.state), 'Latest review was dismissed; a fresh explicit decision is required.');
  assert(review.html_url === `https://github.com/${REPOSITORY}/pull/${number}#pullrequestreview-${review.id}`, 'Unexpected review evidence URL.');
  const evidence = typeof review.body === 'string' ? review.body.replace(/<!--[\s\S]*?-->/g, '').replace(/[#*_`>]/g, '').trim() : '';
  assert(evidence.length >= 40 && new Set((evidence.match(/[\p{L}\p{N}]{2,}/gu) ?? []).map(word => word.toLowerCase())).size >= 6,
    'Review body must contain substantive scope and verification evidence, not an empty or terse approval.');
  // Presence checks cannot establish whether a review's assertions are true.
  return review;
}

export function publishReviewCheck({ pr, revision }, gh = ghJson) {
  assert(Number.isSafeInteger(pr) && pr > 0 && sha(revision), 'Invalid PR number or exact revision.');
  const identity = gh(api('graphql', '-f', 'query=query { viewer { login id } }'));
  const viewer = identity?.data?.viewer;
  assert(!identity.errors && viewer?.login === `${bot}[bot]` && present(viewer.id), 'Authenticated identity is not the designated reviewer bot.');
  const endpoint = `repos/${REPOSITORY}/pulls/${pr}`;
  const readPull = () => gh(api(endpoint, '--method', 'GET'));
  const readReviews = () => {
    const pages = gh(api(`${endpoint}/reviews?per_page=100`, '--method', 'GET', '--paginate', '--slurp'));
    assert(Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray), 'Incomplete or malformed paginated review response.');
    return pages.flat();
  };
  const pull = readPull();
  verifyPull(pull, pr, revision, viewer);
  const readDecision = () => {
    let reviews = [];
    try {
      reviews = readReviews();
      const review = selectReview(reviews, viewer, revision, pr);
      return { review, conclusion: review.state === 'APPROVED' ? 'success' : 'failure', reason: `Latest reviewer decision: ${review.state}.` };
    } catch (error) {
      const review = reviews.filter(value => knownReviewer(value?.user?.login) && value.user.node_id === viewer.id
        && value.user.type === 'Bot' && Number.isSafeInteger(value.id) && timestamp(value.submitted_at)
        && value.html_url === `https://github.com/${REPOSITORY}/pull/${pr}#pullrequestreview-${value.id}`)
        .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at)).at(-1);
      return { review, conclusion: 'failure', reason: String(error.message).slice(0, 300) };
    }
  };
  const initial = readDecision();
  const decision = readDecision();
  if (initial.conclusion !== decision.conclusion || initial.reason !== decision.reason
      || !['id', 'state', 'body', 'commit_id', 'submitted_at', 'html_url'].every(key => initial.review?.[key] === decision.review?.[key])) {
    decision.conclusion = 'failure'; decision.reason = 'Review changed during evidence collection; retry before merging.';
  }
  const current = readPull();
  verifyPull(current, pr, revision, viewer);
  assert(current.base.ref === pull.base.ref && current.base.sha === pull.base.sha
    && current.user.node_id === pull.user.node_id, 'PR base or author changed during evidence collection; retry.');
  const { review, conclusion } = decision;
  const detailsUrl = review?.html_url ?? pull.html_url;
  const payload = { name: CHECK_NAME, head_sha: revision, status: 'completed', conclusion,
    details_url: detailsUrl, external_id: `${REPOSITORY}#${pr}:${review?.id ?? 'unverified'}:${revision}`,
    output: { title: conclusion === 'success' ? 'Independent review approved' : 'Independent review not verified',
      summary: `PR #${pr} at ${revision}, targeting ${pull.base.ref}. ${decision.reason} Reviewer: ${viewer.login}. Evidence: ${detailsUrl}.` } };
  const check = gh(api(`repos/${REPOSITORY}/check-runs`, '--method', 'POST', '--input', '-'), payload);
  assert(check?.app?.id === REVIEWER_APP_ID && check.head_sha === revision && check.name === CHECK_NAME
    && check.status === 'completed' && check.conclusion === conclusion && check.details_url === detailsUrl,
    'Published response did not match the required reviewer App, revision, name, or review decision.');
  return { conclusion, reviewUrl: detailsUrl, checkUrl: check.html_url, revision };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = publishReviewCheck(parseArgs(process.argv.slice(2)));
    console.log(`${CHECK_NAME}: ${result.conclusion} at ${result.revision}; evidence ${result.reviewUrl}`);
    if (result.conclusion !== 'success') process.exitCode = 1;
  } catch (error) { console.error(`Review check not verified: ${error.message}`); process.exitCode = 1; }
}

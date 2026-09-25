#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIssue } from './lib/workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const limit = 1000;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const issueUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/([1-9]\d*)$/i;
const login = value => typeof value === 'string' ? value.toLowerCase() : '';
const ghJson = args => JSON.parse(execFileSync('gh', args, {
  encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
}));

export function selectIssues(project, repositoryIssues, repository) {
  requireThat(Array.isArray(project?.items) && project.totalCount === project.items.length,
    'Project read is incomplete or missing totalCount; refusing a partial audit.');
  requireThat(Array.isArray(repositoryIssues) && repositoryIssues.length < limit,
    'Repository issue read is invalid or reached the 1000-issue limit; completeness is unknown.');
  const items = project.items.filter(item => item.content?.type === 'Issue'
    && login(item.content.repository) === login(repository));
  const numbers = new Set();
  for (const item of items) {
    const number = item.content.number;
    requireThat(Number.isSafeInteger(number) && number > 0 && !numbers.has(number), 'Invalid or duplicate Project issue.');
    numbers.add(number);
  }
  for (const issue of repositoryIssues) {
    requireThat(Number.isSafeInteger(issue?.number) && Array.isArray(issue.labels)
      && issue.labels.every(label => typeof label?.name === 'string'), 'Malformed repository issue list.');
    if (issue.labels.some(label => ['story', 'epic'].includes(login(label.name)))) {
      requireThat(numbers.has(issue.number), `#${issue.number}: tracked story/epic is missing from the Project.`);
    }
  }
  requireThat(items.length > 0, 'No repository issues found in the Project.');
  return items;
}

export function completionUrls(body, repository) {
  const urls = [];
  for (const line of (body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (!/^Completion PR:/i.test(line.trim())) continue;
    const url = line.trim().slice('Completion PR:'.length).trim();
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9]\d*$/i.exec(url);
    requireThat(match && login(match[1]) === login(repository), 'Completion PR must be a plain HTTPS pull-request URL in this repository.');
    urls.push(url);
  }
  return [...new Set(urls)];
}

export function normalizePullRequest(pr) {
  const latest = new Map();
  requireThat(Array.isArray(pr?.reviews) && Array.isArray(pr.statusCheckRollup), 'Missing PR review/check data.');
  const reviews = pr.reviews.filter(review => !['COMMENTED', 'PENDING'].includes(review.state));
  for (const review of reviews) {
    requireThat(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      && login(review.author?.login) && Number.isFinite(Date.parse(review.submittedAt)), 'Unsupported or incomplete PR review evidence.');
  }
  reviews.sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const review of reviews) {
    const previous = latest.get(login(review.author.login));
    requireThat(!previous || Date.parse(previous.submittedAt) !== Date.parse(review.submittedAt)
      || (previous.state === review.state && previous.commit?.oid === review.commit?.oid), 'Ambiguous tied review timestamps.');
    latest.set(login(review.author.login), review);
  }
  const blocked = [...latest.values()].some(review => review.state === 'CHANGES_REQUESTED')
    || ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision);
  const approval = !blocked && [...latest.values()].find(review => review.state === 'APPROVED'
    && review.commit?.oid === pr.headRefOid && login(review.author.login) !== login(pr.author?.login));
  // gh pr view reads every rollup page from commits(last:1), i.e. this PR's current head.
  const successful = pr.statusCheckRollup.length > 0 && pr.statusCheckRollup.every(check =>
    check.__typename === 'CheckRun' ? check.status === 'COMPLETED' && check.conclusion === 'SUCCESS'
      : check.__typename === 'StatusContext' && check.state === 'SUCCESS');
  return { url: pr.url, headSha: pr.headRefOid, merged: Boolean(pr.mergedAt),
    checkConclusion: successful ? 'SUCCESS' : 'UNVERIFIED',
    review: approval ? { reviewer: approval.author.login, author: pr.author?.login,
      headSha: approval.commit.oid, decision: approval.state } : undefined };
}

export function loadSnapshot(config, gh = ghJson) {
  requireThat(/^[\w.-]+\/[\w.-]+$/.test(config.repository) && /^[\w-]+$/.test(config.owner)
    && Number.isSafeInteger(config.number) && config.number > 0, 'Invalid Project configuration.');
  const project = gh(['project', 'item-list', String(config.number), '--owner', config.owner, '--limit', String(limit), '--format', 'json']);
  const repositoryIssues = gh(['issue', 'list', '--repo', config.repository, '--state', 'all', '--limit', String(limit), '--json', 'number,labels,url']);
  const items = selectIssues(project, repositoryIssues, config.repository);
  const issues = items.map(item => {
    const number = item.content.number;
    try {
      const issue = gh(['issue', 'view', String(number), '--repo', config.repository, '--json', 'number,title,body,comments,state,stateReason,blockedBy,parent,url']);
      requireThat(issue.number === number && Array.isArray(issue.blockedBy?.nodes)
        && issue.blockedBy.totalCount === issue.blockedBy.nodes.length, 'Issue/dependency read is incomplete.');
      const blockedBy = issue.blockedBy.nodes.map(dependency => {
        const match = issueUrl.exec(dependency.url);
        requireThat(match && Number(match[1]) === dependency.number, 'Invalid dependency URL.');
        const detail = gh(['issue', 'view', dependency.url, '--json', 'state,stateReason,number']);
        requireThat(detail.number === dependency.number, 'Dependency identity changed while reading.');
        return detail;
      });
      const pullRequests = item.status === 'Done' ? completionUrls(issue.body, config.repository).map(url => {
        const pr = gh(['pr', 'view', url, '--json', 'url,headRefOid,author,mergedAt,reviews,reviewDecision,statusCheckRollup']);
        requireThat(login(pr.url) === login(url), 'Completion PR identity mismatch.');
        requireThat(gh(['pr', 'view', url, '--json', 'headRefOid']).headRefOid === pr.headRefOid,
          'Completion PR head changed during evidence reads; retry the audit.');
        return normalizePullRequest(pr);
      }) : [];
      return { ...issue, status: item.status, priority: item.priority, parent: issue.parent?.number, blockedBy, pullRequests };
    } catch (error) { throw new Error(`#${number}: ${error.message}`); }
  });
  return { capturedAt: new Date().toISOString(), repository: config.repository, issues };
}

function main() {
  const args = process.argv.slice(2);
  requireThat(args.length === 0 || (args.length === 2 && args[0] === '--output'),
    'Usage: node scripts/audit-github.mjs [--output .local/live-snapshot.json]');
  let output;
  if (args.length) {
    output = resolve(root, args[1]);
    const localPath = relative(resolve(root, '.local'), output);
    requireThat(localPath && !localPath.startsWith('..') && !isAbsolute(localPath), 'Snapshot output must be inside .local/.');
  }
  const snapshot = loadSnapshot(JSON.parse(readFileSync(resolve(root, '.github/project.json'), 'utf8')));
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`); }
  const errors = snapshot.issues.flatMap(issue => validateIssue(issue).map(message => `#${issue.number}: ${message}`));
  for (const error of errors) console.error(error);
  requireThat(errors.length === 0, `${errors.length} workflow violation(s).`);
  console.log(`Live workflow audit passed for ${snapshot.issues.length} issue(s). Read-only audit; no GitHub state was changed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Live workflow audit failed: ${error.message}`); process.exitCode = 1; }
}

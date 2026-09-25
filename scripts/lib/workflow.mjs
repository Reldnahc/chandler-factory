// Read-only snapshot auditor. Callers must obtain current, trustworthy GitHub data.
export const STATUSES = Object.freeze(['Backlog', 'Ready', 'In progress', 'Review', 'Done', 'Blocked', 'Cancelled']);
export const PRIORITIES = Object.freeze(['Showstopper', 'High', 'Medium', 'Low']);

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const upper = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const login = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const meaningfulLines = body => (typeof body === 'string' ? body : '')
  .replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const headline = (line = '') => /^#{1,6}\s+/.test(line)
  ? line.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '') : line;

function hasCancellationReason(lines) {
  if (/^Cancel(?:led|ed):\s*\S/i.test(headline(lines[0]))) return true;
  return lines.some((line, index) => {
    const text = headline(line);
    if (/^Cancellation reason:\s*\S/i.test(text)) return true;
    return /^Cancellation reason:?$/i.test(text)
      && nonempty(lines[index + 1]) && !/^#{1,6}\s/.test(lines[index + 1]);
  });
}

/** Return human-readable violations; an empty array means this snapshot passes. */
export function validateIssue(issue) {
  if (!isRecord(issue)) return ['Issue must be an object.'];
  const errors = [];
  const { status, priority } = issue;
  const lines = meaningfulLines(issue.body);
  const validComments = issue.comments === undefined || (Array.isArray(issue.comments)
    && issue.comments.every(comment => isRecord(comment) && typeof comment.body === 'string'));
  if (!validComments) errors.push('comments must be an array of objects with string bodies when supplied.');
  if (!STATUSES.includes(status)) errors.push('Status is missing or unknown.');
  if (!PRIORITIES.includes(priority)) errors.push('Priority is missing or unknown.');

  if (STATUSES.includes(status)) {
    const terminal = status === 'Done' || status === 'Cancelled';
    if (upper(issue.state) !== (terminal ? 'CLOSED' : 'OPEN')) {
      errors.push(`${status} requires ${terminal ? 'a closed' : 'an open'} issue.`);
    }
  }

  if (status === 'Blocked') {
    if (!/^Blocked:\s*\S/i.test(headline(lines[0]))) {
      errors.push('Blocked requires the first meaningful body line to be "Blocked: <reason>".');
    }
    if (!lines.some(line => /^Unblocks when:\s*\S/i.test(headline(line)))) {
      errors.push('Blocked requires a nonempty "Unblocks when: <condition>" line.');
    }
  }

  if (status === 'Cancelled') {
    if (upper(issue.stateReason) !== 'NOT_PLANNED') errors.push('Cancelled requires stateReason NOT_PLANNED.');
    if (!hasCancellationReason(lines) && !(validComments && issue.comments?.some(comment => hasCancellationReason(meaningfulLines(comment.body))))) {
      errors.push('Cancelled requires a preserved cancellation reason in the body or comments.');
    }
  }

  if (issue.blockedBy !== undefined && !Array.isArray(issue.blockedBy)) {
    errors.push('blockedBy must be an array when supplied.');
  } else if (status === 'Ready' || status === 'Done') {
    for (const dependency of issue.blockedBy ?? []) {
      if (!isRecord(dependency) || upper(dependency.state) !== 'CLOSED'
          || upper(dependency.stateReason) !== 'COMPLETED') {
        const number = Number.isSafeInteger(dependency?.number) ? dependency.number : '?';
        errors.push(`${status} requires prerequisite #${number} to be CLOSED with stateReason COMPLETED.`);
      }
    }
  }

  if (status === 'Done') {
    if (upper(issue.stateReason) !== 'COMPLETED') errors.push('Done requires stateReason COMPLETED; cancellation is not completion.');
    if (!Array.isArray(issue.pullRequests) || issue.pullRequests.length === 0) {
      errors.push('Done cannot verify: initial auditor only supports PR-backed completion; provide a merged PR with completion evidence.');
    } else {
      issue.pullRequests.forEach((pr, index) => {
        const label = `PR ${index + 1}`;
        if (!isRecord(pr)) { errors.push(`${label} must be an object.`); return; }
        if (!nonempty(pr.url) || !nonempty(pr.headSha)) errors.push(`${label} requires a URL and current head SHA.`);
        if (pr.merged !== true) errors.push(`${label} must be merged.`);
        if (upper(pr.checkConclusion) !== 'SUCCESS') errors.push(`${label} requires successful checks on its current head.`);
        const review = pr.review;
        if (!isRecord(review) || upper(review.decision) !== 'APPROVED'
            || !nonempty(pr.headSha) || review.headSha !== pr.headSha
            || !login(review.reviewer) || !login(review.author)
            || login(review.reviewer) === login(review.author)) {
          errors.push(`${label} requires APPROVED review by someone other than its author on the exact current head.`);
        }
      });
    }
  }
  return errors;
}

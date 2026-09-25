#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateIssue } from './lib/workflow.mjs';

// Accept one normalized issue, an issue array, or { issues: [...] }.
// This audits the supplied snapshot; it does not enforce or mutate GitHub state.
try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-workflow.mjs <snapshot.json>');
  const snapshot = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const issues = Array.isArray(snapshot) ? snapshot : snapshot?.issues ?? [snapshot];
  if (!Array.isArray(issues) || issues.length === 0) throw new Error('Snapshot must contain at least one issue.');
  let violations = 0;
  for (const issue of issues) {
    const errors = validateIssue(issue);
    const number = Number.isSafeInteger(issue?.number) ? issue.number : '?';
    for (const error of errors) console.error(`#${number}: ${error}`);
    violations += errors.length;
  }
  if (violations) {
    console.error(`Workflow audit failed: ${violations} violation(s) across ${issues.length} issue(s).`);
    process.exitCode = 1;
  } else {
    console.log(`Workflow audit passed for ${issues.length} issue(s) in the supplied snapshot.`);
  }
} catch (error) {
  console.error(`Workflow audit failed: ${error.message}`);
  process.exitCode = 1;
}

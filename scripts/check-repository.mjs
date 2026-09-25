// Small static checks for the workflow foundation, independent of GitHub access.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const required = [
  'AGENTS.md', 'README.md', 'docs/workflow.md', 'docs/agent-roles.md',
  'docs/project-intent.md', 'docs/verification.md',
  '.github/ISSUE_TEMPLATE/story.md', '.github/ISSUE_TEMPLATE/epic.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/project.json',
];
for (const file of required) {
  if (!existsSync(resolve(root, file))) failures.push(`Missing ${file}`);
}
if (existsSync(resolve(root, 'AGENTS.md')) && statSync(resolve(root, 'AGENTS.md')).size > 2048) {
  failures.push('AGENTS.md exceeds its 2 KiB entry-point budget; move detail into scoped references.');
}
function visit(directory) {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    if (['.git', '.local', 'node_modules', 'target'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const body = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      const local = target.split('#')[0];
      if (local && !existsSync(resolve(dirname(path), decodeURIComponent(local)))) {
        failures.push(`${relative(root,path)} has a missing local link: ${target}`);
      }
    }
  }
}
visit(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Foundation files, local document links, and the AGENTS.md size budget pass.');
}

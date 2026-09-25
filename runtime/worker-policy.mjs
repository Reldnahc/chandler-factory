import { readFileSync } from 'node:fs';

export const POLICY_VERSION = '1';
export const WORKER_ROLES = Object.freeze(['implementation', 'reviewer']);
const policies = Object.freeze({
  implementation: Object.freeze({ model: 'gpt-6-astra', effort: 'medium' }),
  reviewer: Object.freeze({ model: 'gpt-6-astra', effort: 'high' }),
});
export function workerPolicy(role) {
  if (!WORKER_ROLES.includes(role)) throw new Error('Unsupported runtime worker role.');
  return policies[role];
}
export function workerArguments(role) {
  const { model, effort } = workerPolicy(role);
  const instructions = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8');
  return ['app-server', '--stdio', '--strict-config',
    '-c', `model=${JSON.stringify(model)}`, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-c', `developer_instructions=${JSON.stringify(instructions)}`,
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
    '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
    '-c', 'features.default_mode_request_user_input=true',
    '-c', 'projects."/workspace".trust_level="untrusted"'];
}

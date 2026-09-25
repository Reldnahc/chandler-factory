import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { POLICY_VERSION, WORKER_ROLES, workerPolicy, workerArguments } from '../runtime/worker-policy.mjs';

test('worker roles and policies are fixed and immutable', () => {
  assert.equal(POLICY_VERSION, '1'); assert.deepEqual(WORKER_ROLES, ['implementation', 'reviewer']);
  assert.equal(Object.isFrozen(WORKER_ROLES), true);
  for (const [role, effort] of [['implementation', 'medium'], ['reviewer', 'high']]) {
    assert.deepEqual(workerPolicy(role), { model: 'gpt-6-astra', effort });
    assert.equal(Object.isFrozen(workerPolicy(role)), true);
    const args = workerArguments(role);
    assert.deepEqual(args.slice(0, 3), ['app-server', '--stdio', '--strict-config']);
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes('features.multi_agent_v2=false'));
    assert.ok(args.includes('features.default_mode_request_user_input=true'));
    assert.ok(args.includes(`model_reasoning_effort="${effort}"`));
  }
  for (const role of ['coordinator', '__proto__', '../reviewer', '', undefined]) assert.throws(() => workerPolicy(role));
});
test('policy probe needs no credentials, rejects coordinator, extra arguments and legacy run', () => {
  const run = (role, ...args) => spawnSync(process.execPath, ['runtime/entrypoint.mjs', ...args], {
    env: { ...process.env, FACTORY_ROLE: role }, encoding: 'utf8', timeout: 2000,
  });
  const result = run('reviewer', 'policy'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).effort, 'high');
  assert.equal(run('coordinator', 'policy').status, 1);
  assert.equal(run('implementation', 'policy', '--model=other').status, 1);
  assert.match(run('implementation', 'run').stderr, /One-shot run is disabled/);
});

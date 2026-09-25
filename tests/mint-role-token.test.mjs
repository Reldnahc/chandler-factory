import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAppJwt, mintRoleToken, revokeRoleToken, rolePermissions, validateConfig, main } from '../scripts/mint-role-token.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = Date.parse('2026-09-24T12:00:00Z');
const secret = 'FAKE_INSTALLATION_SECRET_FOR_TESTS_ONLY';

function fixture(t, role = 'implementation') {
  const root = mkdtempSync(join(tmpdir(), 'chandler-token-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credentials = join(root, 'credentials'); mkdirSync(credentials);
  const keyFile = join(root, 'test-key.pem'); writeFileSync(keyFile, pem);
  const identity = { appId: 1001, clientId: 'IvTEST', installationId: 2001, privateKeyFile: keyFile, slug: `test-${role}` };
  const configFile = join(root, 'apps.json');
  const config = { roles: { [role]: identity } }; writeFileSync(configFile, JSON.stringify(config));
  const permissions = { ...rolePermissions[role] };
  const app = { id: identity.appId, client_id: identity.clientId, slug: identity.slug, owner: { login: 'Reldnahc', type: 'User' }, permissions };
  const installation = { id: identity.installationId, app_id: identity.appId, app_slug: identity.slug,
    account: { login: 'Reldnahc', type: 'User' }, target_type: 'User', repository_selection: 'selected', suspended_at: null, permissions };
  const repo = { id: 301, name: 'chandler-factory', full_name: 'Reldnahc/chandler-factory', owner: { login: 'Reldnahc' } };
  const minted = { token: secret, permissions, repository_selection: 'selected', repositories: [repo], expires_at: '2026-09-24T13:00:00Z' };
  const scope = { total_count: 1, repositories: [repo] };
  const data = { app, installation, minted, scope };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const path = new URL(url).pathname;
    if (options.method === 'DELETE') return { status: 204 };
    const value = path === '/app' ? data.app : path.endsWith('/access_tokens') ? data.minted
      : path === '/installation/repositories' ? data.scope : data.installation;
    return { status: options.method === 'POST' ? 201 : 200, json: async () => structuredClone(value) };
  };
  return { root, config, identity, configFile, role, credentials, data, calls, fetchImpl,
    options: { configFile, role, credentials }, dependencies: { fetchImpl, now: () => now } };
}

test('JWT is RS256 signed with bounded lifetime and backdated issued-at', () => {
  const jwt = createAppJwt('IvTEST', pem, now);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'IvTEST', iat: now / 1000 - 60, exp: now / 1000 + 540 });
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

for (const role of Object.keys(rolePermissions)) {
  test(`${role}: writes only a validated token and returns nonsecret evidence`, async t => {
    const f = fixture(t, role);
    const result = await mintRoleToken(f.options, f.dependencies);
    assert.equal(readFileSync(join(f.credentials, role, 'github-token'), 'utf8'), secret);
    assert.deepEqual(result.permissions, rolePermissions[role]);
    assert.equal(result.bot, `${f.identity.slug}[bot]`);
    const posted = f.calls.find(call => call.method === 'POST');
    assert.deepEqual(JSON.parse(posted.body), { repositories: ['chandler-factory'], permissions: rolePermissions[role] });
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'GET', 'POST', 'GET']);
    const jwt = posted.headers.Authorization.slice('Bearer '.length);
    assert.ok(!JSON.stringify(result).includes(secret) && !JSON.stringify(result).includes(jwt));
    assert.ok(f.calls.every(call => call.redirect === 'error' && new URL(call.url).origin === 'https://api.github.com'));
  });
}

test('unknown config grants and reused identities are rejected', t => {
  const f = fixture(t);
  assert.throws(() => validateConfig({ ...f.config, permissions: {} }, f.role), /Invalid host/);
  f.config.roles.implementation.permissions = { administration: 'write' };
  assert.throws(() => validateConfig(f.config, f.role), /fields/);
  delete f.config.roles.implementation.permissions;
  f.config.roles.reviewer = { ...f.identity };
  assert.throws(() => validateConfig(f.config, f.role), /distinct/);
});

test('App and installation preflight rejects wrong identity, grants, owner and scope before POST', async t => {
  const mutations = [
    data => { data.app.id++; },
    data => { data.app.permissions.administration = 'write'; },
    data => { data.installation.account.login = 'other-owner'; },
    data => { data.installation.repository_selection = 'all'; },
    data => { data.installation.suspended_at = '2026-09-24T10:00:00Z'; },
    data => { data.installation.permissions.contents = 'read'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f.data);
    await assert.rejects(mintRoleToken(f.options, f.dependencies));
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
    assert.equal(existsSync(join(f.credentials, f.role, 'github-token')), false);
  }
});

test('malformed minted grants, repositories and expiry are revoked without persistence', async t => {
  const mutations = [
    data => { data.minted.permissions = { ...data.minted.permissions, issues: 'write' }; },
    data => { data.minted.repositories = []; },
    data => { data.minted.repositories[0].full_name = 'other/repo'; },
    data => { data.minted.expires_at = '2026-09-24T14:00:00Z'; },
    data => { data.scope.total_count = 2; },
    data => { data.scope.repositories = []; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f.data);
    await assert.rejects(mintRoleToken(f.options, f.dependencies), /Minted token revoked/);
    assert.equal(f.calls.at(-1).method, 'DELETE');
    assert.equal(existsSync(join(f.credentials, f.role, 'github-token')), false);
  }
});

test('fetch errors never expose the JWT or response text', async t => {
  const f = fixture(t);
  await assert.rejects(mintRoleToken(f.options, { now: () => now, fetchImpl: async (url, options) => {
    throw new Error(`${options.headers.Authorization} ${secret}`);
  } }), error => error.message === 'GitHub request failed; response details suppressed.');
});

test('failed revocation is reported without token contents', async t => {
  const f = fixture(t); f.data.minted.permissions = {};
  const fetchImpl = async (url, options) => {
    if (options.method === 'DELETE') throw new Error(secret);
    return f.fetchImpl(url, options);
  };
  await assert.rejects(mintRoleToken(f.options, { fetchImpl, now: () => now }), error =>
    error.message.includes('Revocation not confirmed') && !error.message.includes(secret));
});

test('relative, repository-local and secret-inside-credentials paths are rejected', async t => {
  const f = fixture(t);
  await assert.rejects(mintRoleToken({ ...f.options, configFile: 'apps.json' }, f.dependencies), /absolute/);
  await assert.rejects(mintRoleToken({ ...f.options, configFile: fileURLToPath(new URL('../.github/project.json', import.meta.url)) }, f.dependencies), /outside the repository/);
  const inside = join(f.credentials, 'key.pem'); writeFileSync(inside, pem);
  f.config.roles[f.role].privateKeyFile = inside; writeFileSync(f.configFile, JSON.stringify(f.config));
  await assert.rejects(mintRoleToken(f.options, f.dependencies), /outside the credentials/);
  assert.equal(f.calls.length, 0);
});

test('existing token is never overwritten or followed', async t => {
  const f = fixture(t); mkdirSync(join(f.credentials, f.role));
  const path = join(f.credentials, f.role, 'github-token'); writeFileSync(path, 'existing');
  await assert.rejects(mintRoleToken(f.options, f.dependencies), /already exists/);
  assert.equal(readFileSync(path, 'utf8'), 'existing');
  assert.equal(f.calls.length, 0);
});

test('CLI rejects extra, duplicate or unknown options', async () => {
  await assert.rejects(main(['--help']), /Usage/);
  await assert.rejects(main(['--config', 'x', '--config', 'y', '--role', 'reviewer']), /duplicate/);
  await assert.rejects(main(['--config', 'x', '--token', secret, '--role', 'reviewer']), error => !error.message.includes(secret));
});

test('CLI key-parsing failure emits no private-key or token content', t => {
  const f = fixture(t);
  writeFileSync(f.identity.privateKeyFile, `INVALID_PRIVATE_KEY_${secret}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/mint-role-token.mjs', import.meta.url)),
    '--config', f.configFile, '--role', f.role, '--credentials', f.credentials], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Could not sign/);
  assert.ok(!result.stderr.includes(secret) && !result.stderr.includes('INVALID_PRIVATE_KEY'));
});

test('revoke command reads no App key and deletes only after confirmed revocation', async t => {
  const f = fixture(t);
  await mintRoleToken(f.options, f.dependencies);
  rmSync(f.identity.privateKeyFile);
  const result = await main(['--revoke', '--role', f.role, '--credentials', f.credentials], f.dependencies);
  assert.deepEqual(result, { role: f.role, revoked: true, tokenFileRemoved: true });
  assert.equal(existsSync(join(f.credentials, f.role, 'github-token')), false);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).headers.Authorization, `Bearer ${secret}`);
});

test('unconfirmed revocation retains the token file and suppresses upstream details', async t => {
  const f = fixture(t); await mintRoleToken(f.options, f.dependencies);
  await assert.rejects(revokeRoleToken(f.options, { fetchImpl: async () => {
    throw new Error(secret);
  } }), error => error.message.includes('suppressed') && !error.message.includes(secret));
  assert.equal(readFileSync(join(f.credentials, f.role, 'github-token'), 'utf8'), secret);
});

test('revoke keeps a token file changed while the request was pending', async t => {
  const f = fixture(t); await mintRoleToken(f.options, f.dependencies);
  const path = join(f.credentials, f.role, 'github-token');
  await assert.rejects(revokeRoleToken(f.options, { fetchImpl: async () => {
    writeFileSync(path, 'new-token-with-different-length'); return { status: 204 };
  } }), /file changed/);
  assert.equal(readFileSync(path, 'utf8'), 'new-token-with-different-length');
});

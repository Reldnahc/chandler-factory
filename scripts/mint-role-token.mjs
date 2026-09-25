#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owner = 'Reldnahc';
const repository = `${owner}/chandler-factory`;
export const rolePermissions = Object.freeze({
  implementation: Object.freeze({ metadata: 'read', contents: 'write', pull_requests: 'write' }),
  reviewer: Object.freeze({ metadata: 'read', contents: 'read', pull_requests: 'write' }),
  coordinator: Object.freeze({ metadata: 'read', issues: 'write' }),
});

class MintError extends Error {}
const check = (condition, message) => { if (!condition) throw new MintError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };
const sameKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validId = value => Number.isSafeInteger(value) && value > 0;

export function validatePermissions(actual, role) {
  const expected = rolePermissions[role];
  check(expected && sameKeys(actual, Object.keys(expected))
    && Object.entries(expected).every(([key, value]) => actual[key] === value), 'GitHub permission grants do not exactly match this role.');
}

export function validateConfig(config, role) {
  check(Object.hasOwn(rolePermissions, role), 'Unknown role.');
  check(sameKeys(config, ['roles']) && object(config.roles) && Object.hasOwn(config.roles, role), 'Invalid host configuration.');
  const appIds = new Set(), clients = new Set(), installations = new Set(), slugs = new Set();
  for (const [name, value] of Object.entries(config.roles)) {
    check(Object.hasOwn(rolePermissions, name) && sameKeys(value, ['appId', 'clientId', 'installationId', 'privateKeyFile', 'slug']), 'Invalid role configuration fields.');
    check(validId(value.appId) && validId(value.installationId)
      && typeof value.clientId === 'string' && /^[A-Za-z0-9_.-]+$/.test(value.clientId)
      && typeof value.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
      && typeof value.privateKeyFile === 'string' && isAbsolute(value.privateKeyFile), 'Invalid role identity or private-key path.');
    check(!appIds.has(value.appId) && !clients.has(value.clientId)
      && !installations.has(value.installationId) && !slugs.has(value.slug), 'Roles must use distinct App identities and installations.');
    appIds.add(value.appId); clients.add(value.clientId); installations.add(value.installationId); slugs.add(value.slug);
  }
  return config.roles[role];
}

function safeExistingPath(input, directory, label) {
  check(typeof input === 'string' && isAbsolute(input), `${label} must be an absolute path.`);
  const path = resolve(input);
  try {
    // Reject symlinks/junctions in every existing component, including ancestors.
    const parts = relative(parse(path).root, path).split(/[\\/]+/).filter(Boolean);
    let current = parse(path).root;
    for (const part of parts) { current = join(current, part); check(!lstatSync(current).isSymbolicLink(), `${label} cannot use symlinks or junctions.`); }
    const stat = lstatSync(path);
    check(directory ? stat.isDirectory() : stat.isFile(), `${label} has the wrong file type.`);
    check(directory || (stat.nlink === 1 && stat.size <= 65536), `${label} must be a small, unlinked regular file.`);
    const canonical = realpathSync(path);
    check(!within(realpathSync(repositoryRoot), canonical), `${label} must be outside the repository.`);
    return canonical;
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError(`${label} is not accessible.`);
  }
}

export function createAppJwt(clientId, pem, now = Date.now()) {
  try {
    const key = createPrivateKey(pem);
    check(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048, 'An RSA private key of at least 2048 bits is required.');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const seconds = Math.floor(now / 1000);
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: clientId, iat: seconds - 60, exp: seconds + 540 })}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError('Could not sign the App authentication request.');
  }
}

function validateApp(app, identity, role) {
  check(app?.id === identity.appId && app.client_id === identity.clientId && app.slug === identity.slug
    && app.owner?.login === owner && app.owner.type === 'User', 'Authenticated App identity or owner does not match configuration.');
  validatePermissions(app.permissions, role);
}

function validateInstallation(installation, identity, role) {
  check(installation?.id === identity.installationId && installation.app_id === identity.appId
    && installation.app_slug === identity.slug && installation.account?.login === owner
    && installation.account.type === 'User' && installation.target_type === 'User'
    && installation.repository_selection === 'selected' && installation.suspended_at === null,
  'Installation identity, owner, selected-repository setting, or active state is invalid.');
  validatePermissions(installation.permissions, role);
}

function validateRepositories(repositories) {
  check(Array.isArray(repositories) && repositories.length === 1
    && repositories[0]?.full_name === repository && repositories[0].name === 'chandler-factory'
    && repositories[0].owner?.login === owner && validId(repositories[0].id),
  'Token repository scope is not exactly Reldnahc/chandler-factory.');
}

const validToken = token => typeof token === 'string' && token.length > 0 && token.length <= 16384 && !/\s|[\x00-\x1f\x7f]/.test(token);

async function githubRequest(fetchImpl, method, path, auth, body) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new MintError('GitHub request failed; response details suppressed.'); }
  const expected = method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200;
  check(response.status === expected, `GitHub ${method} request returned an unexpected status; response details suppressed.`);
  if (expected === 204) return;
  try { return await response.json(); } catch { throw new MintError('GitHub returned invalid JSON; response details suppressed.'); }
}

export async function mintRoleToken({ configFile, role, credentials }, { fetchImpl = fetch, now = Date.now } = {}) {
  const configPath = safeExistingPath(configFile, false, 'Host configuration');
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new MintError('Host configuration is not valid JSON.'); }
  const identity = validateConfig(config, role);
  const credentialRoot = safeExistingPath(credentials, true, 'Credentials directory');
  const keyPath = safeExistingPath(identity.privateKeyFile, false, 'Private key');
  check(!within(credentialRoot, configPath) && !within(credentialRoot, keyPath), 'Configuration and private keys must be outside the credentials directory.');
  const roleDirectory = join(credentialRoot, role);
  try { mkdirSync(roleDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new MintError('Cannot create role credentials directory.'); }
  safeExistingPath(roleDirectory, true, 'Role credentials directory');
  const tokenPath = join(roleDirectory, 'github-token');
  try { lstatSync(tokenPath); throw new MintError('Role token already exists; revoke and remove it before minting another.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  let pem;
  try { pem = readFileSync(keyPath); } catch { throw new MintError('Private key is not accessible.'); }
  let jwt;
  try { jwt = createAppJwt(identity.clientId, pem, now()); } finally { pem.fill(0); }

  const request = (method, path, auth, body) => githubRequest(fetchImpl, method, path, auth, body);

  validateApp(await request('GET', '/app', jwt), identity, role);
  validateInstallation(await request('GET', `/app/installations/${identity.installationId}`, jwt), identity, role);
  validateInstallation(await request('GET', `/repos/${repository}/installation`, jwt), identity, role);
  // This verifies selected-repository mode and target membership, not the complete
  // installation list. The freshly minted token's exact list is checked below.
  let token, createdFile = false;
  try {
    const response = await request('POST', `/app/installations/${identity.installationId}/access_tokens`, jwt, {
      repositories: ['chandler-factory'], permissions: rolePermissions[role],
    });
    check(validToken(response?.token), 'GitHub returned an invalid installation token.');
    token = response.token;
    validatePermissions(response.permissions, role);
    check(response.repository_selection === 'selected', 'Token repository selection is not restricted.');
    validateRepositories(response.repositories);
    const expiry = Date.parse(response.expires_at);
    check(Number.isFinite(expiry) && expiry > now() + 60000 && expiry <= now() + 3660000, 'Token expiry is outside the accepted one-hour window.');
    const scope = await request('GET', '/installation/repositories?per_page=100', token);
    check(scope?.total_count === 1, 'Token can access an unexpected number of repositories.');
    validateRepositories(scope.repositories);
    check(scope.repositories[0].id === response.repositories[0].id, 'Repository identity changed during token validation.');
    let handle;
    try {
      safeExistingPath(roleDirectory, true, 'Role credentials directory');
      // Exclusive creation avoids overwriting credentials or following a raced symlink.
      handle = openSync(tokenPath, 'wx', 0o600);
      createdFile = true;
      writeFileSync(handle, token, 'utf8');
    } catch { throw new MintError('Could not write the new role token file.'); }
    finally { if (handle !== undefined) closeSync(handle); }
    return { role, appId: identity.appId, installationId: identity.installationId,
      bot: `${identity.slug}[bot]`, repository, permissions: rolePermissions[role], expiresAt: response.expires_at };
  } catch (error) {
    let removed = true;
    if (createdFile) { try { unlinkSync(tokenPath); } catch { removed = false; } }
    let revoked = false;
    if (token) { try { await request('DELETE', '/installation/token', token); revoked = true; } catch {} }
    const message = error instanceof MintError ? error.message : 'Token provisioning failed; details suppressed.';
    throw new MintError(message + (token ? revoked ? ' Minted token revoked.' : ' Revocation not confirmed; the token may remain valid for one hour.' : '')
      + (removed ? '' : ' Partial token file cleanup failed.'));
  }
}

export async function revokeRoleToken({ role, credentials }, { fetchImpl = fetch } = {}) {
  check(Object.hasOwn(rolePermissions, role), 'Unknown role.');
  const credentialRoot = safeExistingPath(credentials, true, 'Credentials directory');
  const tokenPath = safeExistingPath(join(credentialRoot, role, 'github-token'), false, 'Role token');
  const original = lstatSync(tokenPath);
  let token;
  try { token = readFileSync(tokenPath, 'utf8'); } catch { throw new MintError('Role token is not accessible.'); }
  check(validToken(token), 'Role token file is invalid.');
  await githubRequest(fetchImpl, 'DELETE', '/installation/token', token);
  try {
    const current = lstatSync(tokenPath);
    check(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === original.dev
      && current.ino === original.ino && current.mtimeMs === original.mtimeMs && current.size === original.size,
    'Token revoked, but the token file changed; file retained.');
    unlinkSync(tokenPath);
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError('Token revoked, but token file cleanup failed.');
  }
  return { role, revoked: true, tokenFileRemoved: true };
}

export async function main(args = process.argv.slice(2), dependencies) {
  const revoke = args[0] === '--revoke';
  if (revoke) args = args.slice(1);
  check(args.length === (revoke ? 4 : 6), 'Usage: mint-role-token.mjs [--revoke | --config ABSOLUTE_JSON] --role ROLE --credentials ABSOLUTE_DIRECTORY');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    check((revoke ? ['--role', '--credentials'] : ['--config', '--role', '--credentials']).includes(name)
      && !Object.hasOwn(options, name), 'Unknown or duplicate command option.');
    options[name] = args[index + 1];
  }
  return revoke ? revokeRoleToken({ role: options['--role'], credentials: options['--credentials'] }, dependencies)
    : mintRoleToken({ configFile: options['--config'], role: options['--role'], credentials: options['--credentials'] }, dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(error instanceof MintError ? error.message : 'Token provisioning failed; details suppressed.'); process.exitCode = 1; }
}

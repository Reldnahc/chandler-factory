# GitHub identities for isolated roles

This is the registration and token-provisioning procedure for
`Reldnahc/chandler-factory`. Registration files do not grant access by themselves;
the host-only mint command exchanges an existing App key for a scoped token.
Registration and isolation checks are both necessary before claiming enforcement.
The initial registrations and token scopes are recorded in
[setup evidence](evidence/2026-09-24-containers.md); runtime and operation-denial
claims require their own observed results. See
[agent roles](agent-roles.md) for responsibilities and [verification](verification.md)
for evidence requirements.

## Three separate installations

Register three **different GitHub Apps**, owned by `Reldnahc`, then install each
only on `Reldnahc/chandler-factory`. Use private Apps and installation access
tokens. Do not authorize the Apps to act on the owner's behalf.

| Container role | Proposed App name | Repository permissions |
| --- | --- | --- |
| implementation | Reldnahc Chandler Implementer | Metadata read, Contents write, Pull requests write |
| reviewer | Reldnahc Chandler Reviewer | Metadata read, Contents read, Pull requests write |
| coordinator | Reldnahc Chandler Coordinator | Metadata read, Issues write |

All unlisted repository, organization, and account permissions remain **No access**.
In particular, none receives Administration, Workflows, Checks write, Commit
statuses write, Secrets, or Projects. No App goes on a ruleset bypass list.
The public repository remains publicly readable independently of these grants.

App installation requests are attributed to the App. Minting several tokens for
one App would still yield one App identity. A PR author cannot approve its own PR;
the implementer and reviewer therefore need different registrations.
[Installation identity](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[self-approval restriction](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request).

These grants are not an exact command allowlist. Pull requests write includes
more than submitting reviews. The reviewer lacks the Contents write permission
required by the documented REST merge endpoint; the implementer has that
permission and can merge **when applicable branch rules permit it**. Required
checks and independent approval must therefore be enforced on the target branch.
The implementer cannot update Actions workflow files using these grants.
[Review permission](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request),
[merge permission](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[Git access and Workflows permission](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## Register without a callback service

The checked-in [implementation manifest](../runtime/github-apps/implementation.manifest.json),
[reviewer manifest](../runtime/github-apps/reviewer.manifest.json), and
[coordinator manifest](../runtime/github-apps/coordinator.manifest.json) record
the desired settings. Personal-account App manifests are supported by GitHub.
A complete manifest enrollment flow also needs a trusted redirect receiver and
one-time code exchange, which returns private key material. This repository
does not implement that enrollment service.
[Manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

Use the native registration forms instead; these links preselect the same names,
homepage, and permission grants:

- [Register implementation App](https://github.com/settings/apps/new?name=Reldnahc%20Chandler%20Implementer&url=https%3A%2F%2Fgithub.com%2FReldnahc%2Fchandler-factory&public=false&webhook_active=false&request_oauth_on_install=false&contents=write&pull_requests=write)
- [Register reviewer App](https://github.com/settings/apps/new?name=Reldnahc%20Chandler%20Reviewer&url=https%3A%2F%2Fgithub.com%2FReldnahc%2Fchandler-factory&public=false&webhook_active=false&request_oauth_on_install=false&contents=read&pull_requests=write)
- [Register coordinator App](https://github.com/settings/apps/new?name=Reldnahc%20Chandler%20Coordinator&url=https%3A%2F%2Fgithub.com%2FReldnahc%2Fchandler-factory&public=false&webhook_active=false&request_oauth_on_install=false&issues=write)

For each form, verify the table above, disable webhook delivery, leave OAuth
callbacks empty, leave user authorization during installation disabled, and
choose installation only on this account. If a proposed App name is unavailable,
choose a unique variant and retain the actual App ID and slug. Register the App,
generate its private key in the App settings, and install it with **Only select
repositories: chandler-factory**. Record App ID, client ID, installation ID,
actual slug, selected repository, and granted permissions as nonsecret host
configuration. Registration links are editable form defaults, not enforcement.
[Registration parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters),
[register an App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[installation selection](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).

Keep each downloaded PEM in a host-only secret location outside every checkout,
task packet, and container mount, with access restricted to the trusted host
operator. Do not place a key in the repository, even an ignored directory, or
paste it into a task. The runtime takes an already minted token file; it does
not need an App private key or client secret.

## Mint one short-lived role token on the trusted host

The trusted operator invokes a reviewed deployment of
[mint-role-token.mjs](../scripts/mint-role-token.mjs) immediately before launch.
Do not execute a task's modified copy of this helper. It is not a worker command
or a background renewal service. The helper uses Node's built-in crypto and fetch;
it neither reads owner `gh` credentials nor accepts an arbitrary API URL.

Keep a JSON configuration outside the deployment/checkout and the credentials
directory. The only top-level key is `roles`; each configured role has exactly
the following fields. Replace these example IDs, slug, and PEM path with the
values recorded during registration. Add the `reviewer` and `coordinator` entries
using the same structure and their own distinct identities.

```json
{
  "roles": {
    "implementation": {
      "appId": 123,
      "clientId": "IvEXAMPLE",
      "installationId": 456,
      "privateKeyFile": "C:\\private\\factory-app-keys\\implementation.pem",
      "slug": "actual-implementation-app-slug"
    }
  }
}
```

Create an existing dedicated credentials directory outside the checkout and run
outputs. Protect it and the key/config locations with host filesystem permissions
(including Windows ACLs). Role processes must not have host access to them. The
helper rejects relative, repository-local, linked, or symlink/junction paths;
keys and host configuration cannot reside inside the credentials directory.
POSIX file modes do not establish a Windows ACL boundary.

```powershell
node scripts/mint-role-token.mjs --config C:\private\factory-apps.json --role implementation --credentials C:\private\factory-credentials
```

The helper signs a short-lived RS256 JWT in memory, checks the authenticated App
ID/client ID/slug/owner and exact permission map, then checks the installation and
its association with this repository. It requires selected-repository mode.
The JWT preflight does not enumerate all selected installation repositories.
It requests only `chandler-factory` with the role's frozen permission allowlist,
validates the returned grants/expiry/repository, and separately enumerates the
minted token's repositories to require exactly one. The checked-in
[implementation](../runtime/github-apps/implementation.token-request.json),
[reviewer](../runtime/github-apps/reviewer.token-request.json), and
[coordinator](../runtime/github-apps/coordinator.token-request.json) request bodies
document those grants; the helper does not load editable permission overrides.
[JWT construction](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[App/installation validation](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app).

Only the installation token is written to
`C:\private\factory-credentials\implementation\github-token`. Existing token
files are rejected. Standard output contains only role/App/bot metadata, repository,
permissions, and expiration; failures suppress upstream response text. A token
that fails validation is revoked on a best-effort basis, with an explicit failure
if revocation cannot be confirmed. Local tests use generated fixture keys and
fake API responses; they do not verify live GitHub grants.

Place only this role's `codex-auth.json` beside `github-token`, then follow the
[runtime launcher](../runtime/README.md), which takes the parent directory:

```powershell
node scripts/run-role.mjs --role implementation --checkout C:\path\repo --revision FULL_40_CHARACTER_SHA --task C:\path\task.md --credentials C:\private\factory-credentials --runs C:\private\factory-runs
```

Repeat token minting for another role only with its own registered App. At run
completion, invoke the matching revoke command. It reads only the role token,
calls `DELETE https://api.github.com/installation/token`, and removes the file
only after GitHub confirms revocation. It needs no App key or host configuration.

```powershell
node scripts/mint-role-token.mjs --revoke --role implementation --credentials C:\private\factory-credentials
```

If revocation cannot be confirmed, retain that fact in run evidence; the file is
retained and tokens expire after one hour. Never extend a run by giving it an App
signing key. The helper does not implement renewal or automatic run cleanup.
Installation tokens can narrow the App's repositories and permissions but cannot
expand them.
[Token exchange and scope](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[token revocation](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token).

Inside a permitted networked role process, `GH_TOKEN` selects the installation
token ahead of stored `gh` credentials. Use an empty role-local `GH_CONFIG_DIR`
and no inherited `GITHUB_TOKEN` or enterprise tokens. Do not switch a shared
login with `gh auth switch`; it changes authentication configuration used by
other commands. These are credential-selection rules, not protection from an
agent that can read a different secret location.
[CLI environment](https://cli.github.com/manual/gh_help_environment),
[auth switch](https://cli.github.com/manual/gh_auth_switch).

## Personal Project and Done boundary

The current board is the personal-account
[Project 2](https://github.com/users/Reldnahc/projects/2), not an organization
Project. The documented REST endpoints for reading and updating user-owned
Projects do not support App installation tokens, App user tokens, or fine-grained
PATs. The App permission catalog exposes organization Projects permissions, not
a corresponding personal-account Project grant. `repository_projects` is not
authority over this Project v2 board.
[User Project endpoint](https://docs.github.com/en/rest/projects/projects#get-project-for-user),
[user Project item update](https://docs.github.com/en/rest/projects/items#update-project-item-for-user),
[App permission catalog](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

GitHub's general GraphQL Projects guide accepts installation authentication but
does not establish that this personal Project is writable by these repository-only
Apps. No such grant or successful access has been demonstrated here. Do not
silently fall back to an owner PAT. The coordinator currently proposes board
transitions for a trusted host operation; it receives **no Project write
credential**. Automated board maintenance and a validated completion boundary
remain separate unfinished work.
[GraphQL Projects guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).

Before enabling issue writes, inspect Project workflows and repository automations.
Disable any path that turns an issue close, editable label, or other action
available to a role directly into Done without the required completion evidence.
An issue can be closed as completed or not planned without meeting Done.
Cancellation must remain Cancelled. No raw Project write credential should reach
the coordinator: a grant to edit Project fields would not express the workflow's
evidence-dependent restriction on one Status option. A script's optional
preflight does not restrict a token holder that can call GitHub directly.

## Permanent issue records and acceptance evidence

Issues write permits routine issue management, including editing and closing.
It is not documented as a guarantee that an App cannot delete an issue. GitHub's
human-role guidance reserves deletion in personal repositories for the owner,
but installation tokens follow App permissions. GraphQL exposes `deleteIssue`
without an App permission matrix. Do not claim that omitting Administration
alone establishes the required no-delete boundary.
[Issue editing](https://docs.github.com/en/rest/issues/issues#update-an-issue),
[issue deletion](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/deleting-an-issue),
[GraphQL issues](https://docs.github.com/en/graphql/reference/issues#deleteissue),
[App permission evaluation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

After provisioning, collect nonsecret evidence for each role: distinct App ID,
authenticated bot identity, repository scope, returned permission map, expiration,
and the actual isolated runtime configuration. Query `viewerCanDelete`,
`viewerCanUpdate`, `viewerCanClose`, and `viewerCanReopen` on a disposable issue.
A positive `viewerCanDelete` disqualifies the coordinator credential from a
no-delete claim. A negative capability report is useful evidence but is not a
recorded mutation-denial test. Test deletion only against an explicitly disposable
fixture, never an existing story. Also test reviewer push denial, self-approval
denial, wrong-role secret access, and rejected merge without required evidence.
[Issue capability fields](https://docs.github.com/en/graphql/reference/issues#issue).

If the App grant permits a forbidden operation, stop at that observed limitation.
Do not give it owner authority or relabel an instruction as enforcement. A
different role/credential design or a trusted restricted action service requires
an explicit reviewed decision. This specification includes no scheduler or
long-running credential service.

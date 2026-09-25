# Container and identity setup, 2026-09-24

Docker Desktop 4.57.0 / Docker Engine 29.1.3, Linux amd64 containers on Windows;
Node 24.19.0, GitHub CLI 2.101.0, Codex CLI 0.155.1.

## Executed boundary checks

At 2026-09-25 00:44 UTC, these commands passed:

- `node scripts/test-isolation.mjs .local`: 30 checks across coordinator,
  implementation, and reviewer. Nonroot execution, zero capabilities,
  no-new-privileges, read-only runtime mounts, role-specific workspace
  writes, own output artifacts, absent host environment/login/socket, and no IP
  route were observed using synthetic credentials.
- `node scripts/test-egress.mjs .local`: 18 checks across implementation and
  reviewer. Verified-TLS GitHub public metadata requests worked through the proxy.
  CONNECT requests for host/private addresses, an unlisted authority, and port 80
  failed. Direct host and Internet connections returned `ENETUNREACH`.

Role image: `sha256:b1d9d3f8df65dffe43cd5c86bc9550a6a73b4a0e060f02a42757b8befed6ae8b`.
Proxy image: `sha256:e314adee44d9bd8788215b0e08af94eb759040b688b23a1a93b480aea0edc9ac`.
Raw synthetic reports were retained in ignored `.local/isolation-probe-LYZ3UE/`
and `.local/egress-probe-hYvR9c/`. These were built from initial runtime working
files; source changes require new image and run evidence.

The nested Codex Linux sandbox failed to create a `bwrap` namespace in both tested
modes. The runtime uses `danger-full-access` inside the unchanged Docker boundary,
as explained in the [runtime guide](../../runtime/README.md). No Docker capabilities,
host access, or namespace privileges were added to accommodate it.

An initial authenticated run exposed a Docker Desktop mapping problem: regular
files under the protected AppData host directory appeared as directories inside
the container. Synthetic reproduction isolated this from the file ACLs. The
launcher now transfers only the selected role's credentials through stdin into
private container memory/tmpfs. The host key permissions remain restrictive;
credentials are never staged in the checkout or run output. Own auth is writable
inside the temporary home for token refresh. Workspace/task/output bind mounts use
a Docker-compatible directory, with only that run's paths exposed.

## Proxy limitation found during independent review

An independent no-credential trial opened `CONNECT chatgpt.com:443`, then used
TLS server name and HTTP Host `www.cloudflare.com`; valid TLS and HTTP 200 were
observed. Shared public hosting makes this possible. The proxy checks the CONNECT
authority and connects to a validated public IP; it cannot constrain the encrypted
virtual host, URL, or application operation. Do not describe it as complete
hostname enforcement or prevention of credential export. GitHub/OpenAI traffic is
intentional, and code in a role can use that role's credentials.

The tested private/host network boundary remains separate from that limitation.
Strict application-level egress would require another design, not a claim based
on these CONNECT tests.

## Provisioned GitHub Apps

Chandler approved the three private Apps, their listed grants, host-held signing
keys, and installation only on `Reldnahc/chandler-factory`. The GitHub installation
UI showed exactly one selected repository for each App. Host token provisioning
also verified the App, installation, exact permission map, and one-repository
token scope before saving each short-lived token.

| Role | App ID | Installation ID | Grants beyond Metadata read |
| --- | --- | --- | --- |
| implementation | 5067506 | 164633313 | Contents write, Pull requests write |
| reviewer | 5067522 | 164633953 | Contents read, Pull requests write |
| coordinator | 5067540 | 164634354 | Issues write |

Signing keys are outside the repository and role mounts. Explicit Windows ACLs
grant the host user and SYSTEM access; no private key or token is included here.
The first implementation key download was not received; a replacement was secured
and the unused original key was deleted with Chandler's explicit approval.
This setup record does not itself prove a successful isolated model run, actual
bot-authored changes, or denied GitHub operations.

## Live implementation run and permission trials

The isolated implementation run at source
`06e23abd4569ad564d57ed2cc919d33c38a8fffe` authenticated through GraphQL as
`reldnahc-chandler-implementer[bot]`, listed exactly `Reldnahc/chandler-factory`,
read the project guidance, and wrote a read-back-verified `container-smoke.json`
containing those observations and the current foundation phase. The artifact is
retained in ignored `.local/role-runs/implementation-h18iLt/workspace/`. The run
had no Git metadata or Python; it correctly reported the task-packet revision as
provenance and used shell tools after discovering Python was unavailable.

Separate trusted-host tests used the three actual App tokens, without owner
fallback. GraphQL reported three distinct bot logins and `viewerCanDelete: false`
for each on retained issue #6. No deletion was attempted against permanent history;
this is capability evidence, not a deletion-denial mutation test.

The implementation token created retained
[trial PR #8](https://github.com/Reldnahc/chandler-factory/pull/8) against a dedicated
protected `workflow-boundary-trial` branch. At revision `06e23ab`, the following
actual operations were denied:

| Operation | Result |
| --- | --- |
| Implementer merge without independent approval | HTTP 405: new changes require approval from someone other than the last pusher. |
| Implementer approve its own PR | HTTP 422: cannot approve your own pull request. |
| Reviewer create a branch | HTTP 403: resource not accessible by integration. |
| Coordinator create a branch | HTTP 403: resource not accessible by integration. |

The target uses the same protection as main: required `Workflow checks` from
GitHub Actions App 15368, current branch requirement, one approval, stale-review
dismissal, last-push approval, conversation resolution, administrator enforcement,
and disabled force pushes/deletion. The exact JSON without a duplicate `contexts`
array was accepted and read back. The initial main commit was empty; implementation
changes are proposed through [PR #7](https://github.com/Reldnahc/chandler-factory/pull/7).

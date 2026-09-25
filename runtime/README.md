# Isolated role runtime

This is a manually invoked host launcher for one fresh Codex process. It has no
scheduler, backlog, automatic native-subagent dispatch, or host command API. A
native subagent spawned inside a role retains that container's authority.

The trusted operator builds and invokes a reviewed deployment of these scripts.
Do not invoke a launcher modified by the task being executed. Role containers see
only their disposable snapshot, task packet, own output directory, and an egress
socket. The host transfers only that role's short-lived GitHub token and Codex
auth object over Docker stdin before the model starts. They cannot edit the
deployment that the trusted host will invoke next. This does not retroactively
isolate the desktop bootstrap session, which still has owner access.

Build the two images from the trusted deployment:

```powershell
docker build -f runtime/Dockerfile -t chandler-factory-role:0.1 runtime
docker build -f runtime/Dockerfile.egress -t chandler-factory-egress:0.1 runtime
node scripts/test-isolation.mjs .local
node scripts/test-egress.mjs .local
```

Node and the GitHub CLI archive are pinned; the CLI archive checksum is from the
[official immutable release](https://github.com/cli/cli/releases/tag/v2.101.0).
Codex is pinned to 0.155.1. The launcher resolves local image IDs before each run
and records those IDs, so a run does not change images midway. Image rebuilds and
the Docker daemon remain part of the trusted host, outside the role boundary.

Prepare an existing directory outside the checkout for credentials. Its three
subdirectories are `coordinator`, `implementation`, and `reviewer`. Each contains
only that role's `github-token` and `codex-auth.json`. Tokens should be minted by
the trusted host from the corresponding GitHub App installation; never pass App
private keys, an owner token, or an entire home/configuration directory. Confirm
the actual actor and scoped permissions separately; filenames do not prove them.
Auth files are password-equivalent. Credentials are never Docker command arguments,
Docker environment configuration, shared secret volumes, or bind-mounted host
files. A bounded stdin payload supplies the role's token to its child environment
and writes only its auth object into the private temporary writable Codex home
to permit refresh. These copies are discarded with the container.
The launcher does not save refreshed auth back to the host; concurrent runs with
shared refresh credentials need separate authentication provisioning. See
[Codex authentication](https://developers.openai.com/codex/auth/).

Example invocation from the trusted deployment, using actual paths and a full
commit SHA:

```powershell
node scripts/run-role.mjs --role implementation --checkout C:\path\repo --revision FULL_40_CHARACTER_SHA --task C:\path\task.md --credentials C:\private\factory-credentials --runs C:\private\factory-runs
```

The runs directory must exist and be readable through Docker Desktop's Windows
filesystem sharing. A synthetic trial found that files under this machine's
`AppData/Local` appeared as directories inside Docker; the same files under the
repository's `.local` directory mapped correctly, including with the same
restricted owner/SYSTEM ACL. Use `.local/role-runs` for disposable task outputs
on this host. Only one run's selected children are mounted, and `.local` is
excluded from snapshots. Real credentials remain outside the repository and
are transferred through stdin; the launcher never writes them to `.local`.
Source comes from immutable Git blobs at the
supplied revision; uncommitted and untracked files are absent. Symlinks,
submodules, linked worktrees, Git alternates, external Git metadata, suspicious
paths, and tracked secret files are rejected. Git metadata, local Codex/agent
configuration, and build caches are excluded. The implementation gets a writable
snapshot; coordinator and reviewer snapshots are mounted read-only. Result files
remain in that run's `workspace` and `output`; `launch.json` identifies the source
revision and image IDs. The host must inspect and independently review returned
changes before integration. Artifacts can contain untrusted code or model output;
the launcher never executes them on the host.

The outer container has no IP network interface beyond loopback. A fixed local
relay forwards HTTP proxy traffic through a read-only Unix socket to a separate
proxy container with no credentials or checkout. The proxy admits only its
embedded CONNECT authority list, rejects nonpublic addresses, and pins validated
DNS addresses before connecting. It does not inspect encrypted traffic: shared
public IPs can serve other TLS/HTTP virtual hosts, as the
[independent trial](../docs/evidence/2026-09-24-containers.md) demonstrated. This is
not complete hostname enforcement or prevention of credential export.
There are no published ports, host namespaces,
Docker sockets, elevated capabilities, or custom Docker arguments. GitHub API and
OpenAI access are intentional; any process inside a role can use that role's
credentials. Permission restrictions belong on those credentials as well.

The immutable role brief is supplied as `developer_instructions`; the task packet
is the separate user prompt. This improves instruction delivery without claiming
that instructions enforce permissions. Codex starts with approvals disabled,
ignored global configuration, and an untrusted project configuration. The local
Docker trial found that Codex's nested Linux sandbox fails to create a namespace
under the outer restrictions. The fixed runtime therefore uses
`--sandbox danger-full-access` **inside this externally sandboxed container**;
Docker enforces the boundary. This is the documented
[Codex container configuration](https://developers.openai.com/codex/agent-approvals-security/).
It never relaxes Docker capabilities, adds namespace privileges, exposes host
networking, or changes the role's read-only mounts. This flag must not be reused
for a host Codex process. The network diagnostic records the nested sandbox
failure separately from egress results; live authentication still needs a trial.

The offline canary suite uses synthetic stdin credentials and runs each role,
checking 10 boundaries plus a written action artifact. Own auth is intentionally
writable in private tmpfs to support refresh; the task and runtime are immutable.
It records JSON evidence beneath the
specified directory. Passing it is evidence about mounts, local isolation, and
credential fallback, not proof of distinct GitHub identities, GitHub permissions,
live Codex execution, or the egress allowlist. Those require separate live trials.

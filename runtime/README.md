# Isolated worker runtime

This runtime is under development. Live validation and operational use remain on
hold under the [launcher readiness requirements](../docs/launcher-readiness.md).
Source changes and simulated tests do not demonstrate the deployed container's
behavior. Existing host deployments and images have not been upgraded or enabled.

The main conversation with Chandler is the coordinator. It communicates through
the [launcher interface](../docs/launcher-interface.md) with separate implementation
and review workers. No coordinator worker is supported. The coordinator GitHub App
remains the main conversation's identity; its permissions are unchanged.

## Execution and communication

The host service implements restricted stdio MCP tools. It manages worker identifiers,
request deduplication, bounded events, questions, and lifecycle state. The coordinator
supplies a scoped task and exact source revision, then sends messages, answers
questions, observes results, and interrupts or closes the worker through that interface.
The service does not schedule assignments or own a backlog.

Each worker runs a Codex App Server inside its own container. The container accepts
one bounded credential packet as the first stdin line, then carries the App Server
protocol over the same private pipe. The service does not expose raw protocol
requests or configuration overrides to callers. The former `scripts/run-role.mjs`
one-shot command now rejects execution.

The runtime fixes implementation to `gpt-6-astra` / `medium` and review to
`gpt-6-astra` / `high`. The host checks image policy before supplying credentials,
and the manager checks reported settings before starting work. Each new turn supplies
the fixed settings again. Native nested agent spawning is disabled in workers.
Question support uses the CLI's `default_mode_request_user_input` feature;
that feature's actual behavior still requires live validation.

Model pinning controls this launch and continuation path. It does not isolate the
host coordinator or stop every possible process a worker could run with its own
credentials. Preventing the coordinator from using other launch paths is a later,
separately verified environment change.

## Deployment reference

Use reviewed code from a trusted deployment outside the worker's writable paths.
Host configuration fixes separate checkout, credential, run, and state directories;
per-operation callers cannot substitute those paths. The service defaults to
`enableWorkerRuns: false`. See the interface document for configuration and limits.
Do not enable live execution without the explicit authorization required by readiness.

The worker image source now targets `chandler-factory-role:0.2`; the existing `:0.1`
image is not a compatible replacement. The egress image remains
`chandler-factory-egress:0.1`. These are preparation commands for authorized validation,
not instructions to deploy or run now:

```powershell
docker build -f runtime/Dockerfile -t chandler-factory-role:0.2 runtime
docker build -f runtime/Dockerfile.egress -t chandler-factory-egress:0.1 runtime
```

Node, GitHub CLI, and Codex CLI remain version-pinned in the Dockerfiles; Codex is
0.155.1. The service resolves image IDs and checks policy on the selected image.
Host image preparation and Docker control are outside the worker boundary.

Worker credential directories contain only the corresponding `github-token` and
`codex-auth.json`. Keep all App signing keys and owner authentication outside workers.
The coordinator App and its external setup are retained but never selected as a worker.
Token provisioning is described in [GitHub identities](../docs/github-identities.md).

Credentials travel over stdin, never Docker arguments, Docker environment
configuration, or host credential mounts. Only the worker's own temporary home
receives Codex authentication. Auth refresh is not saved back to the host. Authentication
expiry and concurrent use of refresh credentials require explicit provisioning;
the launcher does not silently use another role or owner login.

## Filesystem and network boundaries

Snapshots use the specified immutable Git revision and omit Git metadata, local
Codex configuration, untracked files, and host caches. Symlinks, external Git storage,
submodules, unsafe filenames, and tracked secret files are rejected. Implementation
gets a writable snapshot; review gets a read-only snapshot. Each gets its own output
directory and immutable task packet. Returned artifacts remain untrusted and require
inspection before integration or host execution.

Use a run location verified to support Docker bind mounts in both directions.
In the live trial, the protected AppData run path was visible on Windows but
appeared empty in Docker Desktop; container writes did not reach that host path.
Controlled canaries worked from Documents with inherited and filtered Docker
environments. The coordinator moved the retry runs to a verified Documents
location while retaining keys, credentials, state, and deployment elsewhere in
protected locations. A directory's existence on the host is insufficient evidence
that Docker sees it; Documents itself is not a universal guarantee.

Before reading role credentials or launching a model, the trusted driver runs a
fixed, credential-free preflight on the resolved worker image. It compares a
host-computed SHA-256 digest of every snapshot file's name and contents (including
entry types and directory names) with the mounted snapshot, checks the mounted
task digest, and writes a fresh random output challenge that the host must read
back exactly. Empty, missing, changed, or disconnected mounts fail closed. The
probe has no network, a read-only root and input mounts, a non-root user, dropped
capabilities, and bounded resources. It shares the startup deadline and labelled
container cleanup path; uncertain cleanup retains a retry handle. A verified
challenge is removed; failed-run artifacts remain available for inspection.

This is a point-in-time mount check, not continuous integrity monitoring or proof
of credential isolation, Docker trustworthiness, or operational readiness. It
hashes content and names, not platform-dependent permissions or timestamps. Host
run directories still require protection against concurrent modification. Local
fixture tests execute the fixed probe code with simulated mounts; a deployed
Docker retry and independent review remain necessary evidence.

Workers run without an IP network connection, host namespaces, Docker socket, or
elevated capabilities. A loopback relay reaches a mounted Unix socket in a separate
egress proxy. The proxy permits selected CONNECT destinations and rejects nonpublic
addresses. It does not inspect encrypted traffic; shared public IPs can host other
TLS virtual hosts. This is not complete prevention of credential export.

Codex uses `danger-full-access` only inside the outer restricted container because
the previous nested sandbox could not create its namespace. Never reuse this setting
for the host coordinator. Workers can intentionally access their own role credentials;
GitHub permission limits must remain on those credentials.

## Lifecycle and verification

The host keeps private metadata, idempotency records, and bounded events outside all
worker mounts. Follow-up turns use the same live context. After service or host restart,
retained artifacts and records remain inspectable, but the launcher does not claim
to restore lost worker conversations or replay uncertain writes. Recovery needs an
explicit decision and new assignment when context is lost. Process cleanup and
credential disposal must be verified in the actual deployment.

Local tests use deterministic peers and fake Docker calls. The offline container and
egress diagnostic scripts are separate, authorized validation tools; their use does
not prove model behavior or the complete coordination cycle. Review and integration
still require the exact-revision checks and identities in the
[completion procedure](../docs/workflow.md#done).

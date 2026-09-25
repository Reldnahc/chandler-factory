# Launcher readiness

The launcher must be ready before operational use. Development of the launcher is
the immediate scope. Live worker runs, workflow trials, and use for project work
remain on hold until Chandler explicitly authorizes the relevant validation and use.
Native collaboration has not been disabled. This document defines readiness; it is
not a backlog, an implementation claim, or evidence of a passed test.

## Settled constraints

- The main conversation with Chandler is the coordinator. Do not create a separate
  coordinator worker. The coordinator GitHub App is this coordinator's identity.
- Preserve all three GitHub App identities and their approved permissions.
- Chandler selects the coordinator's model and reasoning in the app. Worker settings
  must be enforced by trusted code, not chosen by the coordinator at dispatch time.

| Role | Model | Reasoning | Execution |
| --- | --- | --- | --- |
| Coordinator | `gpt-6-astra` | `ultra` | Main conversation; selected by Chandler |
| Implementation | `gpt-6-astra` | `medium` | Separate worker with implementation identity |
| Reviewer | `gpt-6-astra` | `high` | Separate worker with reviewer identity |

Implementation and review require separate contexts and credential boundaries.
The coordinator chooses assignments, answers questions within agreed scope, and
interprets results. The launcher manages execution and communication. GitHub remains
the work and state record; launcher session metadata does not become a second backlog.

Enforcing worker settings inside the launcher and forcing this coordinator to use
only the launcher are separate requirements. The latter is deferred until the
launcher is ready. Do not remove existing communication capabilities first.

## Accepted development target

Chandler authorized proceeding with complete worker coordination for this workflow.
Broader parity with the desktop app's interface, plugins, and tools is outside this
development target. These criteria define behavior to implement and validate;
authorization to develop it does not establish readiness for live use.

| Capability | Required observable behavior |
| --- | --- |
| Start and identify a worker | Accept a bounded assignment and exact source revision; return a stable worker identifier associated with its role, workspace, and runtime. Reject a coordinator-worker launch. |
| Enforce role settings | Apply the fixed model and reasoning on creation, continuation, and recovery. Reject caller overrides, incompatible runtimes, and unavailable required settings. Never silently select another model or effort. |
| Confirm configuration | Check the runtime's reported effective settings before accepting a session for work. Record requested and reported values separately; do not label a copied request as independent confirmation. |
| Send follow-up messages | Deliver clarification or corrections to the intended worker, including during an active turn. Continue the same worker context for the same assignment. Report rejected or uncertain delivery honestly. |
| Ask and answer questions | Surface a worker's question with its worker and request identifiers; route the answer back to that request. Waiting for an answer must not become success or silent guessing. Consequential decisions still go to Chandler. |
| Observe and wait | Provide bounded progress, questions, errors, and final results without copying full transcripts into the coordinator. A disconnected observer can retrieve retained events using a cursor. |
| Distinguish lifecycle outcomes | Distinguish starting, working, waiting for input, idle after a turn, interrupted, failed, and closed. A finished turn is not necessarily a finished assignment; neither automatically completes a GitHub story. |
| Interrupt and close | Acknowledge interruption separately from confirmed termination. Stop active work, retain useful artifacts, and clean up owned processes and credentials. Closing an already closed worker is harmless. |
| Handle multiple workers | Track implementation and review independently, with correctly routed messages and separate workspaces, contexts, and credentials. Waiting on one worker must not block all communication with others. |
| Recover safely | After a connection loss, rediscover the existing worker rather than launch a duplicate. After a process or host restart, report what survived and what did not. Preserve enough state for an explicit recovery decision; never invent continuity or replay uncertain writes automatically. |
| Return usable artifacts | Identify source revision, changed files or candidate revision, verification evidence, blockers, and output locations. Keep the independent review tied to the actual candidate. Treat returned files and messages as untrusted inputs. |
| Preserve authority | Workers cannot obtain other role credentials, change trusted policy, choose container options, or invoke a host execution interface. A message or request for access cannot broaden permissions. Missing or expired credentials cause an explicit failure or controlled reprovisioning. |
| Operate predictably | Bound resource use, message and event sizes, waits, and retention. Expose health and actionable errors. Do not return secrets or authentication packets in progress, results, or diagnostics. |

Implementation and local validation are described in the
[interface reference](launcher-interface.md) and [runtime reference](../runtime/README.md).
Live compatibility, credential boundaries, and the complete real-agent exchange need
separate observations before operational readiness can be claimed.
The [local validation record](evidence/2026-09-24-launcher-local.md) documents the
completed deterministic checks and their limits.

## Communication interface

The implementation exposes start, message, answer, observe/wait, interrupt, close,
list, and health operations over local stdio MCP. The
[interface reference](launcher-interface.md) defines tool names and arguments.
Each operation uses a launcher-owned worker identifier. Callers cannot substitute
an arbitrary process, session, path, command, model, or credential location.

Messages retain the worker's role and context. A fresh reviewer receives the scoped
assignment, candidate, and evidence; it does not inherit the implementer's conversation.
Review corrections can return to the existing implementer without mixing the two
contexts. Workers need a route to ask the coordinator for clarification; permission
requests must be kept distinct from ordinary questions.

The installed Codex CLI 0.155.1 can generate schemas for App Server conversation
creation, turn start, active-turn steering, interruption, input requests, and resume.
These are candidate building blocks. Schema availability does not demonstrate that
our container deployment supports the required exchange or recovery behavior.
The [App Server reference](https://learn.chatgpt.com/docs/app-server) describes the
protocol. Any adapter must allow only the intended operations and enforce policy on
every new turn and resume; raw protocol access includes configuration overrides.

## Validation before operational use

Develop and check protocol routing, state transitions, fixed settings, and error handling locally using a
deterministic worker substitute with no live model or GitHub writes. Such checks
validate launcher behavior only.

With explicit authorization, validate the actual runtime in a disposable test
environment. Demonstrate the complete exchange: start an implementer, receive a
question, answer it, observe its acknowledgement, steer a correction, and receive
the result. Separately demonstrate independent review and return its findings to
the same implementer. Also exercise interruption, disconnects, duplicate requests,
settings mismatches, and credential boundaries.

Results must identify the runtime and launcher revision, expected behavior, actual
observations, and remaining limits. Do not claim successful model execution from
fixtures or successful communication from launch logs alone. Decide explicitly how
test artifacts are retained or removed before creating any remote records.

Only after the agreed criteria are demonstrated and Chandler authorizes use may the
launcher take operational assignments. Restricting the coordinator to that interface
is a later change requiring its own complete path audit and validation.

## Bootstrap and readiness limits

Launcher development uses native implementation helpers at Astra / Medium and
independent review at Astra / High. They share the host environment and perform local
code work and deterministic tests only. Their results are not evidence of worker
credential isolation or successful operation of the launcher itself.

Recovery preserves records and artifacts and reports lost context honestly. It does
not automatically restore a live conversation after a service or machine restart.
Worker tool access beyond the existing CLI environment and deployment into this
coordinator's tool set require further explicit decisions. Authorization to develop
does not authorize service installation, a new coordinator, a scheduler, additional
GitHub permissions, or changes to Chandler's app settings.

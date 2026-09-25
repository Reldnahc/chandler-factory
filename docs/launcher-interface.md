# Coordinator launcher interface

The development launcher exposes eight tools over a local stdio MCP JSONL
connection. It does not listen on a network address. The process boundary is its
local authority boundary: only a trusted operator should start the service or
control its stdin, executable, configuration, state, or deployment directory.
No service installation or configuration is performed by these sources.

Start with `node scripts/launcher.mjs --config ABSOLUTE_PATH`. The JSON configuration
has exactly these fields: `checkout`, `credentials`, `runs`, `state`, optional
`maxWorkers` (1–16, default 4), and optional `enableWorkerRuns` (default false).
All four paths must name existing absolute plain directories without symlinks or
junctions. They must not overlap each other; credentials, runs, and state must also
be separate from the trusted launcher deployment. Paths are fixed at startup and
cannot be changed through tool calls. There are no credential-path defaults.
Operators are responsible for host ACLs and protecting paths from replacement;
path validation is not a claim of OS credential isolation.

With `enableWorkerRuns: false`, start, send, and answer return
`WORKER_RUNS_DISABLED`. Observation, health, list, interruption, and close remain
available. Setting true is a technical switch, not evidence of permission: the
[readiness hold](launcher-readiness.md) still requires explicit authorization for
live validation and later operational use. The service does not independently
verify that human authorization has occurred.

Clients initialize using MCP protocol version `2024-11-05`, `2025-03-26`, or
`2025-06-18`, then send `notifications/initialized`. Supported requests are
`initialize`, `ping`, `tools/list`, and `tools/call`. Each message is one UTF-8 JSON
line (maximum 65,536 bytes). JSON-RPC IDs may be strings up to 128 bytes or safe
integers. Batch requests and raw runtime protocol forwarding are unsupported.
Stdout contains protocol responses only; startup errors use a fixed stderr message.

| Tool | Arguments |
| --- | --- |
| `factory_start` | `requestId`, `role` (implementation or reviewer), lowercase 40-hex `revision`, `task` |
| `factory_send` | `requestId`, `workerId`, `message` |
| `factory_answer` | `requestId`, `workerId`, `questionId`, `answers` |
| `factory_observe` | `workerId`, optional `after`, `limit`, `waitMs` |
| `factory_interrupt` | `requestId`, `workerId` |
| `factory_close` | `requestId`, `workerId` |
| `factory_list` | empty object |
| `factory_health` | empty object |

No extra argument keys are accepted. Each mutation carries a separate idempotency
`requestId` (1–128 characters from letters, digits, dot, underscore, colon, or hyphen,
starting with a letter or digit); the manager owns duplicate handling. JSON-RPC IDs
identify transport replies and do not replace mutation IDs. Worker IDs are launcher
generated 24-character lowercase hex strings. Task and message text is bounded to
16,000 UTF-8 bytes. Model, reasoning, shell commands, container options, paths,
credentials, and runtime session IDs are not caller options.

An answer uses the question identifier emitted in the worker event and a map such as
`{"choice":{"answers":["selected option"]}}`. The map and each answer array have
at most 20 entries; each answer has at most 4,000 bytes, with a 16,000-byte total
serialized answer map. The manager validates correspondence to the pending question.
An observer can use its retained cursor as `after` (nonnegative integer), a `limit`
of 1–100, and `waitMs` of 0–30,000. Requests dispatch concurrently, up to 32 inflight,
so an observation does not block an answer or interruption. Clients retry rejected
capacity requests explicitly, preserving mutation request IDs.

Tool results are JSON in MCP text content. Validation, readiness-gate, and operation
failures set `isError`. Known manager error codes retain their `uncertain` flag;
exception messages and unknown error codes are suppressed. In particular,
`CLEANUP_FAILED`, `RECOVERY_CLEANUP_REQUIRED`, and
`PREPARATION_CLEANUP_INCOMPLETE` indicate cleanup that has not been confirmed;
inspect worker state before any retry or operator recovery. Responses are
bounded to 262,144 bytes. Manager and driver own event sanitization; all worker
content remains untrusted. EOF, stream errors, SIGINT, and SIGTERM initiate manager
shutdown. Partial lines at EOF are rejected, and pending responses may be discarded
during shutdown; reconnecting clients must inspect state before retrying uncertain
mutations.

## Recovery and retention

An observer reconnects to the running service by listing workers and continuing
observation from its last cursor. Retained events are bounded; an expired cursor
reports the gap. Keep artifact references instead of treating event history as a
complete transcript. The store retains at most 64 workers and 2,000 mutation keys;
it refuses new entries at capacity rather than forgetting uncertain requests.

After a service or host crash, recovery is an operator procedure:

1. Confirm the previous launcher process has stopped. A `launcher.lock` file
   prevents concurrent owners; do not remove it while an owner could still run.
2. Preserve `workers.json` and the run artifacts. Inspect possible surviving
   containers and volumes against their recorded runtime identifiers and
   `chandler.launcher-owner` labels before stopping or removing owned resources.
   Do not infer ownership from a similar name or assume a crashed host cleaned up.
3. After confirming the lock is stale, remove only that lock and reopen the same
   state with worker execution disabled. Inspect recovered records. Lost contexts
   remain failed and uncertain; `RECOVERY_CLEANUP_REQUIRED` cannot be cleared by
   simply calling close. This version has no automatic recovery acknowledgement.
4. Once cleanup is verified and uncertain operations are reconciled, archive the
   old state and artifacts privately, and configure a new empty state directory
   for explicitly assigned new work. Use new request IDs. Idempotency does not
   span state archives, so never blindly replay requests into the new store.

Reaching retention capacity uses the same explicit archival procedure after all
workers have stopped. Stored records are diagnostic state, not GitHub work status.

`node --test tests/launcher-interface.test.mjs` exercises deterministic fake-manager
routing, question answers, concurrency, protocol bounds, configuration validation,
cleanup and recovery error preservation, and shutdown. These checks do not run
Codex or Docker and do not demonstrate live
settings, credentials, transport compatibility, or authorization. Independent review
and the separately authorized readiness validation remain required.

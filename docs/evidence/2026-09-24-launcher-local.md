# Local launcher validation — 2026-09-24

The development implementation passed deterministic local checks. It has not been
deployed, enabled, or accepted for operational use. The
[readiness hold](../launcher-readiness.md) remains in force.

The examined tree contains uncommitted changes above base
`92dd253b80a9128ba69231028553830bcdefab5a`; that base commit alone does not contain
the implementation. The associated conversation records the file changes and
verification. These results must not be attributed to an older host deployment.

| Check | Observation |
| --- | --- |
| `node --test --test-reporter=spec tests/*.test.mjs` | 134 passed; zero failed, skipped, or cancelled. Includes existing foundation tests. |
| Independent launcher review | Astra / High reviewed the uncommitted implementation and rechecked 60 focused deterministic tests. No remaining blocker found within that scope. |
| `node scripts/check-repository.mjs` | Foundation files, local links, and the AGENTS.md size budget passed. |
| `git -c core.safecrlf=false diff --check` | Passed after removal of two extra trailing blank lines. |

Launcher tests exercise fixed implementation Astra / Medium and reviewer Astra /
High settings; reported-setting rejection; two independent simulated workers;
question, answer, acknowledgement, steering, and same-context follow-up; interrupt
acknowledgement versus termination; concurrent observation; duplicate and uncertain
requests; startup event ordering; cleanup retries; retained-state recovery; bounded
responses; and known-secret scrubbing.

The coordination fixture uses an actual child Node process and the real client,
manager, and MCP handler. Its peer simulates App Server responses. Docker adapter
tests substitute Docker calls. Neither demonstrates actual model execution,
container behavior, credential isolation, GitHub permissions, or review quality.
Native implementation helpers used Astra / Medium; the independent reviewer used
Astra / High. They shared the host and did not establish credential separation.

Restart recovery preserves diagnostic records and artifacts but does not restore
a lost conversation. Unknown surviving resources require operator recovery. Secret
scrubbing covers known direct echoes, not arbitrary encoded exports. The host
coordinator can still use other execution paths. These limits remain explicit in
the [interface](../launcher-interface.md) and [runtime](../../runtime/README.md).

No live worker, Docker validation, GitHub mutation, service installation, or external
deployment was performed for these results. Live validation requires its own scope,
observations, and explicit authorization before operational readiness is claimed.

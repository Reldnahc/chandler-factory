# Agent roles

Assign a role explicitly when dispatching work. Use fresh agents for bounded
implementation and review assignments so task-specific investigation does not continually
accumulate in the coordinator. Do not copy the parent conversation into each worker
when an issue and a concise task packet provide the required context.

Chandler has accepted separate Codex processes in role containers, started by a small
trusted host launcher. Native subagent dispatch in the current shared environment does
not establish credential isolation. The container approach is accepted; implementation
and verification of its boundaries remain separate requirements. See
[decision 0002](decisions/0002-isolated-role-execution.md).

Load only this role's relevant instructions and linked documents. The short repository
entry point locates guidance; it should not become a duplicate of every procedure.

## Load the assigned brief

| Role | Responsibility | Brief |
| --- | --- | --- |
| Coordinator | Authorized work selection, bounded assignments, records, and completion coordination | [Coordinator](roles/coordinator.md) |
| Implementation | One bounded investigation or change and its verification evidence | [Implementation](roles/implementation.md) |
| Reviewer | Independent assessment of the actual result against agreed criteria | [Reviewer](roles/reviewer.md) |

Workers load their applicable brief and task references, not all three briefs. The
coordinator retains concise outcomes and evidence links rather than worker transcripts.

## Required authority boundaries

Implementation and review should use distinct automation identities. The coordinator
should have only its required management authority. Role processes must not be able to
read another role's credentials or fall back to owner authority. Different tokens for
the same GitHub identity do not establish independent author/reviewer identities.

The trusted launcher runs on the host, outside the role containers' authority. The
containers must not receive the owner's home directory, Docker socket, other roles'
credentials, or a way to invoke or alter the trusted launcher. The coordinator is
included in these restrictions; it cannot grant itself broader access or disable
required checks. These are requirements to prove with tests, not assumptions implied
by running a container.

The existing authenticated `gh` session belongs to the repository owner, `Reldnahc`.
It is bootstrap access, not evidence that any role's credentials are isolated. A worker
in the same environment may retain access to that authority. Until isolated execution
and GitHub enforcement are tested, use actual checks and separate review, but describe
them as process steps rather than guaranteed permission boundaries.

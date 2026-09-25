# Agent roles

The main conversation with Chandler is the coordinator. Operational dispatch is
on hold until the [launcher readiness criteria](launcher-readiness.md) are agreed,
implemented, demonstrated, and use is explicitly authorized. Do not launch a
separate coordinator worker.

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

| Role | Responsibility | Model / reasoning | Brief |
| --- | --- | --- | --- |
| Coordinator | Authorized work selection, bounded assignments, records, and completion coordination | Astra / Ultra; Chandler selects it in the app | [Coordinator](roles/coordinator.md) |
| Implementation | One bounded investigation or change and its verification evidence | Astra / Medium; trusted runtime must enforce it | [Implementation](roles/implementation.md) |
| Reviewer | Independent assessment of the actual result against agreed criteria | Astra / High; trusted runtime must enforce it | [Reviewer](roles/reviewer.md) |

Workers load their applicable brief and task references, not all three briefs. The
coordinator retains concise outcomes and evidence links rather than worker transcripts.

The coordinator reads live work records and will dispatch and communicate with workers
through the trusted interface once ready. The coordinator App belongs to this main
conversation. It has Issues write but no Project write permission; board transitions
need separately authorized access, never a silent fallback to owner credentials.

## Required authority boundaries

Implementation and review should use distinct automation identities. The coordinator
should have only its required management authority. Role processes must not be able to
read another role's credentials or fall back to owner authority. Different tokens for
the same GitHub identity do not establish independent author/reviewer identities.

The reviewer retains Contents read access and has Checks write authority for publishing
the required **Independent review** check as App **5067522**, after recording its review
of the exact SHA. **Workflow checks** must come from GitHub Actions App **15368**. The
ordinary review remains evidence even though the native required-approval count is
zero. See the [completion procedure](workflow.md#done) for the required pre-merge
refresh and its limitation after same-SHA review changes.

The trusted launcher runs on the host, outside the worker containers' authority. The
containers must not receive the owner's home directory, Docker socket, other roles'
credentials, or a way to invoke or alter the trusted launcher. Restricting the main
coordinator's alternative execution paths is a separate future step, considered only
after the launcher preserves the needed communication and lifecycle capabilities.
The current host conversation is not credential-isolated by the worker containers.

The existing authenticated `gh` session belongs to the repository owner, `Reldnahc`.
It is bootstrap access, not evidence that any role's credentials are isolated. A worker
in the same environment may retain access to that authority. Do not describe process
rules or model settings as enforced until the specific control is implemented and
demonstrated.

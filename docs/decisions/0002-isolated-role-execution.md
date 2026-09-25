# 0002: Separate container execution for implementation and review

Decision date: 2026-09-24

Decision status: Accepted by Chandler during foundation implementation. Acceptance
authorizes this execution approach; it does not assert that credential isolation or
completion enforcement has been implemented or verified.

The main conversation is the coordinator and uses the coordinator App. It is not a
separate container worker. Launcher readiness is a prerequisite for operational use;
see the [readiness specification](../launcher-readiness.md).

## Context

Fresh implementation and review contexts limit accumulated task-specific instructions
and provide separate reasoning. Native subagents in the existing shared host environment,
however, do not establish separate GitHub authority. The current `gh` session uses owner
`Reldnahc`. Selecting a different token does not isolate a role if it can still obtain
the owner token or another role's credentials.

Worker isolation therefore needs a real execution boundary. Restricting the main
coordinator's ability to bypass the launcher is a separate problem; worker containers
do not impose that restriction on the host conversation.

## Decision

Use separate ordinary Codex processes for implementation and review in containers,
started by a trusted host launcher. This is an execution boundary for bounded assignments, not a
new scheduler, backlog, or orchestration framework. GitHub remains the source of work
and state, and the coordinator continues to reason about assignments and results.

The boundary must have these properties:

- Each role receives its assignment, necessary repository access, and only its intended
  credentials. Implementation and review act as distinct GitHub identities; two tokens
  for the same identity do not meet this requirement.
- The coordinator App supplies management authority to the main conversation. Do not
  infer isolation of that conversation from the App's permissions or worker boundaries.
- Role containers do not receive the owner's home directory, Docker socket, or other
  host paths that expose broader credentials or execution authority.
- The launcher is trusted host code outside the worker containers' authority. Workers
  cannot invoke it directly, mutate its active configuration, or use it to expand their access.
  Proposed launcher changes require review before adoption into the trusted host path.
- Container launch configuration must not silently fall back to shared owner credentials.
  Missing or invalid role credentials fail the affected operation explicitly.
- Implementation and review remain separate fresh processes with scoped role briefs.
  The coordinator receives concise results and durable evidence links.

GitHub verification and review requirements still need their own configuration and
tests. Container isolation alone does not prevent a credential with excessive GitHub
permissions from bypassing a server-side rule.

## Alternatives considered

**Native shared subagents with per-command tokens:** useful for dispatch and separate
context, but does not prevent a process from reaching other credentials in the shared
environment. Retaining it would defer the agreed hard authority separation.

**A custom scheduler or replacement orchestration framework:** would add an unrequested
system around work selection and state. The selected host launcher has the narrower
job of starting approved role processes with bounded inputs and authority.

## Verification and consequences

Demonstrate actual role identities, denied access to other roles' and owner credentials,
absence of Docker control, inability to invoke or alter the trusted launcher, and the
expected GitHub review and integration behavior. Assess coordinator App permissions
separately from host-session access. Record the commands, observations, revision,
environment, and limits; configuration inspection alone is not proof of the runtime boundary.

The present bootstrap session still has owner access. Do not describe that session or
its shared native workers as isolated role execution. Implementation and verification
results belong in linked issues, PRs, and [verification evidence](../verification.md).
This record preserves the decision and its rationale, not current task status.

Container isolation reduces access but does not prove correct reasoning. Bounded scope,
tests, independent review, and Chandler's decisions remain necessary alongside it.

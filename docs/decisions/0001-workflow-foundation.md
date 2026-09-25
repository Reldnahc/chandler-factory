# 0001: GitHub records and scoped agents for the workflow foundation

Decision date: 2026-09-24

Decision status: Accepted by Chandler in the planning conversation. This status records
agreement to the policy and implementation direction; it does not assert that controls
have been implemented or verified.

## Context

The project needs to retain decisions and evidence across agent sessions without
turning repository Markdown into a second backlog or loading a large operating manual
into every agent's context. Chandler wants careful progress and an auditable history,
including cancelled work, failed experiments, and changed direction.

Earlier experience with ChandlerStack did not justify rebuilding an orchestration
framework. The approach here uses capable coding agents, GitHub-native records, concise
role assignments, and narrowly justified checks.

## Accepted choices

- Use the public `Reldnahc/chandler-factory` repository, GitHub Issues, a GitHub Project,
  and `gh` for routine operations where practical.
- Issues describe work and its history; the Project owns current state and priority;
  repository documents preserve current knowledge and historical reasoning; PRs connect
  proposed changes to review and evidence.
- Use Backlog, Ready, In progress, Review, Done, Blocked, and Cancelled. Blocked has a
  prominent reason and explicit unblock condition. Cancelled work remains recorded in
  the Project, may be revived, and is never deleted.
- Use Showstopper, High, Medium, and Low priority. Showstopper is rare and concerns
  significant blocked progress; no additional tie-ranking system is needed.
- Chandler settles objectives, boundaries, and consequential changes. Ready authorizes
  routine autonomous execution. Verification and a separate review pass are required
  before routine completion; individual human acceptance of every story is not required.
- Use a coordinator and fresh, scoped implementation and review agents. Keep the
  repository entry point small and supply role and task context at dispatch time.
- Implement and test distinct role identities, restricted authority, and completion
  controls before claiming that they enforce the intended boundaries.

## Alternatives and reasons

**Human acceptance for every story:** closer supervision, but makes Chandler responsible
for clearing routine finished work. Agreed scope plus independent review supports
autonomous completion while consequential choices still return to Chandler.

**Blocked only as a flag:** retains the previous stage directly, but makes stopped work
less visible. Chandler chose a dedicated state and a reason headline. The previous
stage remains in issue history so work can return to the right stage.

**Delete or archive abandoned work:** loses continuity or removes it from the board.
Chandler chose Cancelled, retained in the Project, with cancellation and revival history.
The name also avoids confusing abandonment with GitHub's closed state, which applies
to completed issues too.

**A large `AGENTS.md`:** would burden unrelated assignments with standing context.
Explicit role assignments and narrow references provide relevant guidance on demand;
fresh workers contain the accumulated task-specific context.

**Role names and shared owner credentials:** separate reasoning is useful but does not
establish separate authority. Enforcement needs real credential isolation and required
checks, including limits on the coordinator. Until demonstrated, these remain unverified
controls rather than guarantees.

## Consequences and limits

Some facts intentionally have linked representations: the Project shows Blocked while
the issue explains why; a guide states the current rule while a decision record explains
its rationale. Avoid manually duplicating full assignments or current state tables.

Permission controls cannot prove good judgment. Tests and review can miss defects.
Accepted, implemented, and verified remain separate claims with separate supporting
records. The canonical procedures are in [workflow](../workflow.md), and the evidence
requirements are in [verification](../verification.md).

No engine architecture, library, simulation rule, hardware target, or performance budget
is accepted by this decision.

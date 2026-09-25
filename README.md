# Chandler Factory

A planned Rust factory/combat game about an industrial war against one enormous,
continuous hive. Artillery trains, autonomous drones, and defenses support expansion
through regenerating biomass. Holding territory requires sustained industrial supply.

The immediate work is making the launcher ready for complete worker coordination.
It is not ready for operational use. Live worker runs and workflow trials remain on
hold pending explicit authorization. See the [readiness specification](docs/launcher-readiness.md)
for the accepted development target and required validation.

The broader goal is establishing a dependable development workflow. Engine
architecture, libraries, simulation rules, hardware targets, and performance budgets
have not been selected. No prototype or engine implementation is authorized by this
foundation work.

## Start here

- [Project intent](docs/project-intent.md): premise, engineering priorities, and open design decisions.
- [Workflow](docs/workflow.md): work selection, states, ownership, and completion policy.
- [Launcher readiness](docs/launcher-readiness.md): required preparation before operational use.
- [Operator quickstart](docs/operator-quickstart.md): suspended operating reference.
- [Agent roles](docs/agent-roles.md): coordinator, implementation, and independent review responsibilities.
- [Accepted decisions](docs/decisions/0001-workflow-foundation.md): the reasons for this workflow and its limits.
- [Verification](docs/verification.md): evidence requirements and what remains to be demonstrated.

[GitHub issues](https://github.com/Reldnahc/chandler-factory/issues) hold tracked work.
The [GitHub Project](https://github.com/users/Reldnahc/projects/2) owns its current
status and priority. Repository documents contain lasting knowledge, not a second
backlog.

Different agent roles do not, by themselves, provide isolated permissions. Until
credential isolation and required completion controls are demonstrated, the workflow
must not be described as enforcing those boundaries.

The main conversation with Chandler is the coordinator and owns the coordinator
GitHub identity. Implementation and review use separate worker identities. The
[role runtime](runtime/README.md) and [launcher interface](docs/launcher-interface.md)
are under development and require live validation before use. The accepted merge gate requires
Workflow checks from GitHub Actions and Independent review from the designated
reviewer App, with a fresh review-check publication immediately before merge. Read
[the completion procedure](docs/workflow.md#done) and
[actual verification evidence](docs/verification.md) for its limits and demonstrated results.

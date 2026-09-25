# Development workflow

This is the canonical workflow policy. It records agreed behavior; a written rule is
not evidence that a tool or permission boundary enforces it. See
[verification](verification.md) for the distinction.

## Records and ownership

| Record | Owns | Example |
| --- | --- | --- |
| Epic issue | A substantial objective, boundaries, completion criteria, and native child issues | Establish a usable development workflow |
| Story issue | A bounded question or change, context, scope, acceptance criteria, verification plan, required documentation, and work history | Verify a fresh agent can resume a story |
| GitHub Project | Current workflow state and priority for those issues | High priority; In progress |
| Repository documents | Current guidance and design, durable research, decisions, alternatives, and supporting evidence | The accepted review procedure and why it was chosen |
| Pull request | Exact proposed repository changes, linked issues, verification results, and review | Changes to the workflow guide, with a recorded startup trial |

Project cards refer to issues; they are not separate assignments. Use native sub-issue
relationships for hierarchy and native dependencies for prerequisites. A child belongs
to an objective; a dependency determines what must happen before other work can proceed.
Neither relationship substitutes for checking whether the needed outcome exists.

Do not maintain a second backlog, priority list, or manually synchronized story status
table in Markdown. Documents may describe policy and record historical facts, but
current work selection comes from GitHub.

## Authority and selection

Chandler decides priorities, objectives, boundaries, and consequential changes to
direction, scope, design, or established constraints. Once those are agreed and a story
is Ready, the agent may perform routine work autonomously, including routine corrections
identified during review. Completion requires verification and a separate review pass;
Chandler need not accept every routine story individually.

The coordinator proposes board transitions and selects Ready work by priority when
asked to continue. The trusted host currently reads the live Project, supplies the
relevant view to the coordinator, and manually applies transitions. The isolated
coordinator has no Project write authority and cannot invoke the host launcher. It
can maintain issue records using its own limited authority. There is no scheduler.

The priority values, in order, are **Showstopper, High, Medium, Low**. Medium
is the ordinary default. Showstopper is rare and reserved for work whose resolution is
needed to unblock significant progress. Being Blocked does not automatically confer
Showstopper priority. There is no separate ranking field for ties; choose a sensible
Ready story at the highest available priority using prerequisites and current context.

If no authorized work can progress, record the actual obstacle rather than inventing
new scope. A need for consequential direction returns to Chandler. Record the decision
before adopting the change.

## States

| State | Meaning |
| --- | --- |
| Backlog | Recorded for consideration; not yet authorized to start. |
| Ready | Scope, acceptance criteria, and verification approach are agreed; prerequisites are satisfied. The agent may begin. |
| In progress | Authorized work is actively underway. |
| Review | The result, lasting documentation, and verification evidence are available for a separate review pass. |
| Done | Acceptance criteria are met, review is complete, and all required repository changes are merged. |
| Blocked | Intended work cannot proceed because of an identified obstacle. |
| Cancelled | We decided not to pursue the work; its record and rationale remain available. |

The normal path is Backlog → Ready → In progress → Review → Done. Review findings that
need changes return work to In progress. A paused or deferred assignment returns to
Backlog when it is no longer selected for execution; unfinished work and its reason
remain recorded.

### Blocked

Set the Project state to Blocked and put the reason in the first headline of the story
body. State the observable condition that would unblock it immediately beneath:

> # Blocked: role credentials cannot yet be isolated.
>
> Unblocks when: the implementation process cannot obtain owner or reviewer authority.

Record the previous stage and relevant dependency links in the issue history. When
the obstacle is resolved, record how it was resolved, remove the current blocked
headline, and return to the appropriate stage: Ready, In progress, or Review. Preserve
the old reason and resolution in a comment or other durable issue record before
replacing current text.

### Cancelled

Record why the story was cancelled, set its Project state to Cancelled, and close the
issue as **not planned**. Keep it in the Project. Do not delete or archive cancelled
stories, their useful research, or their decision history. Closing an issue must not
automatically overwrite Cancelled with Done.

To revive a story, record why, reopen the existing issue, and return it to Backlog for
scope, acceptance, and prerequisite reassessment. Preserve the cancellation and revival
as distinct events. Do not create a replacement issue merely to erase its past.

### Done

Review must assess the agreed acceptance criteria, actual changes, and evidence. Fixes
made after review require review of the resulting changes before completion. Associate
review and verification with the revision they examined so old evidence cannot silently
authorize new changes.

For repository work, merge the reviewed changes after required checks pass, then close
the issue as **completed** and set the Project state to Done. For work requiring no
repository changes, the result and review still need durable evidence linked from the
issue. A closed issue alone is not proof that it satisfies Done.

The accepted integration gate requires a PR and two checks on the exact PR head:
**Workflow checks** from GitHub Actions App **15368**, and **Independent review** from
reviewer App **5067522**. Pin both required check sources to those Apps. The native
required-approval count is zero: the reviewer retains Contents read access, and its
ordinary approval did not satisfy GitHub's native approval-count requirement. The
reviewer's ordinary PR review remains required evidence for the Independent review
check; zero native required approvals does not waive independent review.

The reviewer first submits an ordinary GitHub review identifying the exact commit,
assessment against acceptance criteria, verification evidence, and limitations. It then
runs `node scripts/publish-review-check.mjs --pr N --revision SHA` inside its reviewer
container, replacing `N` and `SHA` with the PR number and full lowercase head SHA.
This publishes the designated App's result after checking the recorded review and
current head. The helper does not determine whether the review's reasoning is correct.

Immediately before merging, the trusted host must request another reviewer-container
run of the helper against the unchanged head and require exit code zero plus the
verified App result. Inspect current reviews and both required checks. Later dismissal
or a changes-requested review on the same SHA does not automatically revoke a previously
successful check: there is no webhook or scheduler. A failed refresh, changed head,
dismissed approval, or unresolved requested changes prevents completion under this
procedure. New commits require new review and verification evidence. The refresh and
merge are not atomic. Confirm live protection and recorded trial results before
claiming the gate is enforced.

After integration, the host applies the reviewed Done transition to the Project. The
host's owner bootstrap access remains outside the container boundary. The completion
auditor is an additional check; it cannot prevent a host with Project write authority
from bypassing it.

A research story can finish with a rejected approach or an inconclusive answer if it
fulfills the agreed investigation and evidence requirements. Do not change acceptance
criteria afterward merely to relabel incomplete work as successful. Any material scope
change needs its rationale and Chandler's decision recorded.

## Durable knowledge

Keep current guidance easy to find. Preserve substantial reasoning in linked decision
or research records: alternatives, assumptions, evidence, failed experiments, limits,
and why direction changed. Routine wording changes can retain their explanation in the
issue or PR rather than creating a separate decision document.

Treat these as separate facts:

- **Proposed:** an option under consideration.
- **Accepted:** a choice was authorized, with its rationale recorded.
- **Implemented:** the corresponding change exists at an identified revision.
- **Verified:** stated checks produced recorded evidence for that revision and scope.
- **Superseded:** a later decision replaces the guidance; the earlier reasoning remains.

Acceptance does not prove implementation; implementation does not prove correctness.
Evidence should identify what was checked, the revision or environment, the result, and
its practical limits. Never present planned trials or fixture tests as successful live
permission tests.

When changing a significant decision, update current guidance, retain the earlier
record marked superseded, and link the replacement with its reason. Keep issue scope
and acceptance changes traceable too, using a comment that records the previous terms,
new terms, and reason before updating the current body.

## Agent execution

Use the scoped assignments in [agent roles](agent-roles.md). A fresh implementation
agent receives one bounded story and relevant references. A separate fresh reviewer
examines its result. The coordinator receives concise results and evidence links, not
copies of entire working conversations. A short entry point and role-specific context
avoid loading the complete operating manual into every agent's context.

Permissions and completion checks must be demonstrated independently of these
instructions. The desired boundaries are that routine agents cannot delete permanent
records, implementation cannot bypass required verification and independent review,
and no role can grant itself greater authority. These are requirements to verify, not
claims about the current environment.

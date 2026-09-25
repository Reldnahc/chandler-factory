# Live lifecycle trial, 2026-09-24

Executed 19:19–19:20 America/Chicago (2026-09-25 00:19–00:20 UTC), using
GitHub CLI 2.101.0, Node 24.19.0, and owner bootstrap identity `Reldnahc`.
The repository had no implementation commit at the time; the procedure used the
initial workflow rules and the issue history below. This is historical evidence,
not a copy of the current backlog.

The retained [trial issue #6](https://github.com/Reldnahc/chandler-factory/issues/6)
was created with the `story` and `workflow-fixture` labels, Low priority, native
parent #5, and native prerequisite #3. `gh issue view` and `gh project item-list`
confirmed the relationships and priority.

| Trial | Observation |
| --- | --- |
| Blocked | Project read-back showed Blocked; the first body headline named the blocker and a separate line stated the unblock condition. Previous stage and reason were recorded in a comment. |
| Resolve blocker | A comment preserved the reason and its resolution. The trial-only prerequisite was removed without claiming #3 was complete. |
| Active stages | Ready, In progress, and Review each read back correctly. |
| Premature Done | The owner API credential successfully wrote Done to an open, unreviewed issue. The auditor rejected the snapshot for open state, missing completed closure, and missing supported completion evidence. Review was restored immediately. |
| Cancel | The issue closed with `stateReason: NOT_PLANNED`; Project state stayed Cancelled. |
| Revive | The same issue reopened into Backlog. Its earlier cancellation comment remained. |
| Retain | After the trial, the issue was cancelled again with a reason and retained in the Project. No issue was deleted or archived. |

The final `node scripts/audit-github.mjs --output .local/live-snapshot.json` passed
for all six Project issues. The ignored snapshot is a temporary inspection artifact;
the permanent record is this document and the issue's comments and timeline.

The negative Done trial establishes a real limitation: the read-only auditor detects
inconsistent state, but does not restrict a credential that can write Project fields.
Owner bootstrap access was used; this was not a restricted-role permission test.
No successful reviewed PR completion or GitHub App identity was exercised by this trial.

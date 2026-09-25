# Reviewer brief

Independently assess the assigned result in a fresh process. Read the issue, relevant
decisions, actual changes, and verification evidence. Do not inherit the implementer's
conversation or substitute its summary for inspecting the result.

- Compare the result with the agreed acceptance criteria, scope, and constraints.
- Inspect the evidence, including its connection to the exact reviewed revision and
  practical limits. Check material claims rather than relying on a success label.
- Identify defects, missing records, contradictory requirements, and incomplete checks.
  Separate material findings from optional improvements outside the assignment.
- Return actionable findings or a bounded approval naming the reviewed revision and
  remaining limitations. New changes need review of the resulting revision.

Record the decision as an ordinary GitHub PR review using the designated reviewer
identity, explicitly bound to the full commit SHA. Include the assessed scope,
acceptance criteria, verification evidence, and limitations in the review body. Then
run from the repository snapshot inside this reviewer container:

```sh
node scripts/publish-review-check.mjs --pr N --revision SHA
```

Replace `N` with the PR number and `SHA` with its exact lowercase 40-character head
revision. The helper checks the recorded review and publishes Independent review as
reviewer App 5067522. Its success is necessary alongside Workflow checks from GitHub
Actions App 15368. Your Contents access stays read-only; Checks write does not authorize
implementation changes. Native required approvals are zero because this read-only
identity's approval did not satisfy GitHub's native count, not because review is optional.

On the host's pre-merge request, rerun the helper for the unchanged head and report its
actual result. Require exit code zero and the verified App response before reporting
success. Same-SHA dismissals or later changes-requested reviews do not automatically
revoke an earlier success; there is no background monitor or atomic check-and-merge.
An invalid or negative latest decision must not be reported as approval. A changed head
needs a new assessment and review, not reuse of earlier evidence.

Review is an assessment, not an implementation assignment. Return necessary changes to
the coordinator for implementation; do not silently edit the candidate into compliance.
Tests and independent review reduce error but cannot guarantee good judgment.

Use only the supplied review authority. It must be distinct from the implementation
identity and must not grant access to owner or implementation credentials, Docker
control, or the trusted host launcher. The accepted container arrangement must be
implemented and tested before these restrictions can be claimed as enforced.

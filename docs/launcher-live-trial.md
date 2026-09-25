# Launcher communication trial

Chandler authorized a new live workflow trial in the main conversation, keeping
the coordinator's current permissions in place. This authorizes the bounded trial
below, not general operational use or a permission reduction.

The main conversation coordinates. Implementation uses the launcher's fixed
`gpt-6-astra` / `medium`; independent review uses `gpt-6-astra` / `high`. Both run
through the new launcher with their existing distinct GitHub App credentials.
No separate coordinator worker is created.

## Assignment and boundaries

Update the obsolete one-shot launch example in `docs/github-identities.md` to
explain the managed launcher interface and link its current reference. Keep
credential provisioning and revocation correct. Change only that document for
the worker assignment; do not add permissions or change workflow policy.

Use a dedicated trial base branch containing the examined launcher sources and
the same required CI/reviewer checks as main. The implementation PR targets that
branch. Retain the labelled issue, PR, trial branch, and sanitized evidence. A
trial merge does not merge these launcher changes into main or authorize further
project assignments. The main coordinator uses its App for issue records; the
trusted host uses existing owner access for board transitions and trial setup.

## Required observations

- Start a worker and compare requested settings with runtime-reported settings.
- Receive a real worker clarification question and deliver an answer through the
  launcher, with acknowledgement and a resulting document change.
- Deliver an active-turn correction and a same-context follow-up. Repeating a
  mutation request must not create a duplicate worker or turn.
- Publish the actual candidate using implementation authority. Give a fresh
  reviewer its exact revision, the scoped criteria, and verification evidence.
- Obtain independent review through the reviewer identity, return any findings
  to the same implementer, and re-review changed candidates before integration.
  Record actual findings; do not manufacture an error to predetermine a verdict.
- Refresh the reviewer-owned check immediately before any trial merge. Confirm
  exact-head CI, review, and required check sources. Complete the issue and board
  transition only if the scoped criteria are met.
- Exercise observation across client reconnect and confirmed interruption on a
  bounded follow-up. Close workers, verify removal of their owned resources, and
  revoke trial tokens. Retain artifacts and report any uncertain cleanup.

Record actual image/source identifiers, role settings, communication observations,
candidate/review revisions, verification outcomes, and limitations. Local fixture
success is not live evidence. Any live failure remains a finding until corrected
and retested; the user has not authorized deleting the new trial's history.

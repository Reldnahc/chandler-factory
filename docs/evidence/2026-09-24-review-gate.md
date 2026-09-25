# Independent review gate trial

Executed 2026-09-24 America/Chicago (2026-09-25 UTC) against
[retained PR #8](https://github.com/Reldnahc/chandler-factory/pull/8), targeting
`workflow-boundary-trial`, and foundation [PR #7](https://github.com/Reldnahc/chandler-factory/pull/7).
This is workflow infrastructure verification, not game implementation.

## Constraint and approved correction

A fresh isolated reviewer compared all 53 snapshot files with GitHub at
`f44551741ea93bb6175aa93d491f7113752d4161`, ran 60 passing tests and repository
checks, and independently approved both PRs. GitHub retained `REVIEW_REQUIRED`:
the reviewer App's code access is read-only, so its approval did not count toward
the native write-authorized approval requirement. A positive-merge preflight
stopped before making a merge request.

Chandler approved [decision 0003](../decisions/0003-review-check-gate.md). The
reviewer registration and selected-repository installation now have Metadata read,
Contents read, Pull requests write, and Checks write. A newly minted token verified
those exact grants and access only to `Reldnahc/chandler-factory`. The previous token
was revoked. Other Apps gained no permissions.

## Live negative and positive controls

The trusted host applied the versioned protection payload to the trial branch and
read back both required sources: `Workflow checks` from App 15368 and `Independent
review` from App 5067522. Strict checks, required PRs, administrator enforcement,
conversation resolution, and disabled force pushes/deletion remain enabled.

At the exact revision above, using scoped installation tokens with `gh api`:

| Action | Observed result |
| --- | --- |
| Implementer attempts merge without review check | HTTP 405: required Independent review check expected. |
| Implementer creates an Independent review check | HTTP 403: resource not accessible by integration. |
| Coordinator creates that check | HTTP 403: resource not accessible by integration. |
| Host injects a deliberately failed check using reviewer token, then implementer attempts merge | HTTP 405; retained [negative-control check](https://github.com/Reldnahc/chandler-factory/runs/107902010811). The deliberate failure was a boundary test, not a review finding. |
| Reviewer helper derives a fresh result from the actual independent approval | Successful check from App 5067522 at the exact head, linked to [review evidence](https://github.com/Reldnahc/chandler-factory/pull/8#pullrequestreview-5312022962). GitHub reported merge state CLEAN. |

The helper command was `node scripts/publish-review-check.mjs --pr 8 --revision
f44551741ea93bb6175aa93d491f7113752d4161`. It validates authenticated bot identity,
fully paginated latest review evidence, current head/base, and returned App/check
identity. Local tests cover changed heads, wrong identities, missing/stale/dismissed
reviews, changes requested, malformed review evidence, pagination, and refresh failure.

## Other observed role behavior

A fresh coordinator container identified itself as `reldnahc-chandler-coordinator[bot]`
and posted its authorized [verification comment on retained issue #6](https://github.com/Reldnahc/chandler-factory/issues/6#issuecomment-5824798320).
It could read the public Project. A safe attempt using that token to set the fixture
to its existing Cancelled value failed with GraphQL `FORBIDDEN`, so public read access
does not imply Project write access. The trusted host retains status-write authority.

## Limits

The host performed these API boundary tests; the approved reviews came from a
separate isolated model run. This distinguishes permission evidence from model
behavior. Successful checks cannot establish that a review's prose is true.

Checks are attached to commits and a later review change at the same commit needs
an explicit refresh. There is no automatic revocation listener. The supported
procedure refreshes the check for the target PR immediately before merging; direct
API access can bypass that procedure while an earlier success remains. Owner
bootstrap authority, direct owner Project writes, and the CONNECT proxy's virtual
host limitation remain outside the claimed enforcement boundary. See
[container evidence](2026-09-24-containers.md) and decision 0003.

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

## Changed revision and successful integration

The next commit, `2426a6c45a37a11637ba3ac20cf0d97c60b7db6e`, passed all three
observed CI jobs. It had no Independent review check. An implementation-App merge
attempt returned HTTP 405 specifically because that check was expected: the old
commit's success did not authorize the new commit.

A fresh isolated reviewer then verified all 57 snapshot files against GitHub,
ran all 74 tests and the repository check, and ran the read-only six-issue live
audit successfully. It found no material defects and submitted exact-commit
approvals for [PR #7](https://github.com/Reldnahc/chandler-factory/pull/7#pullrequestreview-5312150828)
and [PR #8](https://github.com/Reldnahc/chandler-factory/pull/8#pullrequestreview-5312150983).
Both helper invocations exited zero and verified success from App 5067522.

Immediately after that fresh review/check, a trusted-host preflight verified the
current head, target, protection source IDs, latest designated approval, successful
required checks, and a recent check linked to that PR's review. Using only the
implementation installation token, the host called `PUT /repos/Reldnahc/chandler-factory/pulls/8/merge`
with the exact head SHA. GitHub merged it at 2026-09-25 01:16:35 UTC, producing
commit `7c846420ee184046ce89d0472e96b02de91517f5`. No administrative bypass was used.
This proves the scoped implementation identity can complete the approved positive
path as well as being denied the negative paths. The same protection payload was
then installed on main and read back with both exact App sources and all retained
protections.

Each of the three verified App identities also attempted to PUT the identical
current protection payload to the trial branch. All received HTTP 403, resource
not accessible by integration. Owner reads before each attempt and afterward
confirmed the exact payload parity, required App sources, and unchanged settings.
Using the existing payload kept this negative test safe even if an unexpected
permission had allowed it. Routine role tokens cannot edit these rules.

The final role image, containing the updated reviewer instructions, is
`sha256:0a618ed506840218786ea9918fe493e3334da15f1380f2e92c3815e0fc4c9310`.
The proxy remains
`sha256:e314adee44d9bd8788215b0e08af94eb759040b688b23a1a93b480aea0edc9ac`.
At 01:15 UTC, the new image passed 30/30 synthetic isolation checks and 18/18 live
egress checks using `node scripts/test-isolation.mjs .local` and
`node scripts/test-egress.mjs .local`. These probes used synthetic credentials;
the reviewer run separately demonstrated actual authenticated model execution.

## Coordinator behavior

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

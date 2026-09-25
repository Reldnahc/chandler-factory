# 0003: Reviewer App check as the independent review gate

Status: accepted by Chandler on 2026-09-24. Reviewer Checks write is installed.
The replacement gate passed the [retained live trial](../evidence/2026-09-24-review-gate.md)
and is installed on main.

## Observed problem

The reviewer App has Contents read and Pull requests write. Its fresh isolated
run reviewed exact commit `f44551741ea93bb6175aa93d491f7113752d4161`, compared all
53 files against GitHub, ran 60 passing tests, and submitted APPROVED reviews on
[PR #7](https://github.com/Reldnahc/chandler-factory/pull/7#pullrequestreview-5312022799)
and [trial PR #8](https://github.com/Reldnahc/chandler-factory/pull/8#pullrequestreview-5312022962).
GitHub still reported `REVIEW_REQUIRED`. The positive-merge preflight stopped;
neither PR was merged.

GitHub counts required approvals from reviewers with repository write access.
The registered read-only-code reviewer can submit a review but cannot satisfy that
particular gate. [Protected branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Accepted change

Grant **Checks write** to the existing reviewer App, retaining Contents read and
Pull requests write. Require two checks on main: `Workflow checks` from GitHub
Actions App 15368, and `Independent review` from reviewer App 5067522. Retain a
required PR, conversation resolution, current branch checks, administrator
enforcement, and disabled force pushes/deletion. Replace the unsatisfiable native
approval count with the reviewer-owned check. Keep ordinary PR reviews as durable
human-readable evidence.

The reviewer publishes success only for an exact inspected current head with its
APPROVED review and actual evidence; changes requested publish failure. The helper
must reread the head before writing, reject self-review, and link its check to the
review. A changed commit needs a new check. The implementation and coordinator
cannot publish the required check as the reviewer App, and reviewer still cannot
write code, change branch rules, or merge. Checks write is broader than one check
name, but required source App IDs prevent it impersonating GitHub Actions.

The [protection payload](../../.github/main-protection.json) defines the final rule.
The reviewer App registration, installation, and token request add Checks write only.
GitHub documents the
[App Checks permission and commit association](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).

## Alternatives and required proof

Giving the reviewer Contents write would satisfy a broader authority requirement
and undermine the tested inability to write code. A separate human write-authorized
reviewer would keep that native gate but require a human for every routine merge.
The App-owned check preserves the intended role separation without a new
scheduler, service, or backlog.

Before claiming success, test on the retained trial branch: absent/failed review
check blocks merging; other App tokens cannot create the authoritative check;
approved review on the current commit plus successful verification permits merge;
a new commit does not inherit the old success. Keep all trial records.

## Limits and supported merge procedure

Checks belong to commits, not exclusively to one PR. A later review dismissal or
changes-requested decision on the same commit does not automatically revoke an
already published success. The trusted host must request a reviewer check refresh
for the specific PR immediately before integration. The helper rereads the current
head, base, identity, and latest substantive review, and publishes failure for
missing, stale, dismissed, or insufficient evidence. It emits only success/failure;
GitHub also accepts neutral/skipped conclusions, so the App itself remains trusted
to publish an honest result. There is no event listener or claim of continuous
review revocation. A direct API merge can bypass the prescribed refresh while a
previous success remains; this operational limit is not mechanically solved by
branch protection. The ordinary owner account remains outside the role boundary.

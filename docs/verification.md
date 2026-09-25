# Workflow verification

This document defines evidence for the foundation. A proposed test is not a passed
test, and a local fixture cannot demonstrate live GitHub permissions. Current story
state and remaining assignments belong in the Project and issues, not this document.

## Evidence record

For each executed check, retain its command or procedure, date, repository revision,
relevant environment, observed outcome, and limits. Link the record from the issue and
PR. Never include tokens, private keys, or sensitive authentication output.

Review evidence must identify the revision examined. A changed revision requires
updated verification where affected and another review before completion. A success
label without the underlying observations is insufficient.

## Acceptance scenarios

| Scenario | Required observation |
| --- | --- |
| Create and organize work | A real story is created, added to the Project, assigned a priority, attached to a native parent, and given a native prerequisite; reads confirm those relationships. |
| Select authorized work | Selection uses Ready state and priority. A higher-priority story with an unresolved prerequisite does not silently become eligible. |
| Deliver repository work | A real PR links its issue, includes lasting documentation and verification evidence, receives separate review, and can complete through the required controls. |
| Record a blocker | The Project shows Blocked; the issue's first headline states why; an observable unblock condition and prior stage are retained. Resolution preserves the history and returns to the appropriate stage. |
| Cancel and revive work | A disposable trial story remains in the Project as Cancelled after closing as not planned; reopening preserves that history and allows reassessment. The retained trial record is not deleted. |
| Reject incomplete completion | Missing checks or review, stale evidence, and unmet prerequisites prevent the supported completion path from claiming Done. Distinguish helper validation from restrictions on direct API access. |
| Distinct role identities | Implementation and review actions are attributed to different intended GitHub identities; each process fails to obtain other roles' or owner credentials. |
| Protect integration | Safe negative trials demonstrate that the actual implementation and coordinator credentials cannot merge around required checks or independent review. |
| Protect records | Permission inspection and safe, denied trials establish that routine roles cannot delete permanent records. Do not test destructive permissions against real history. |
| Fresh agent recovery | A fresh worker receives a bounded assignment and can find scope, prerequisites, applicable decisions, and verification requirements without a full conversation transcript. |
| Separate review | A fresh reviewer inspects actual changes and evidence, identifies a meaningful planted omission in a safe trial, and ties its decision to the reviewed revision. |
| Resume and honest research | An interrupted task resumes from durable records; a negative or inconclusive investigation can complete only when it fulfills its agreed evidence requirements. |

Use meaningful local fixtures for deterministic validation rules. Use live GitHub
trials only for behavior that fixtures cannot establish, and retain the trial records
and their limitations. Fresh-agent workflow trials assess observed behavior, not a
guarantee that future agents will never err.

## Boundary that requires special care

The existing `gh` session authenticates as owner `Reldnahc`. Assigning a worker a
different token does not isolate it if the process can also reach that owner session,
another role's credentials, or configuration that grants broader access. The coordinator
must be included in isolation checks.

Likewise, a script that rejects an unsupported Done transition demonstrates that the
script checks evidence. It does not prove that the same credential cannot bypass the
script and write Done directly through the Project API. Record such limitations
explicitly and do not call completion enforcement solved while they remain.

## Running the initial audits

With Node 24, run `node --test tests/*.test.mjs` and
`node scripts/check-repository.mjs` for deterministic checks. With authorized `gh`
access, run `node scripts/audit-github.mjs` to read and audit the live Project.
Optional `--output .local/live-snapshot.json` retains a temporary snapshot; it is
ignored by Git and must never become a second backlog.

The initial live auditor recognizes repository completion evidence only when the
issue body contains a plain line `Completion PR: <full PR URL>` for each required PR.
It checks merged state, current-head independent approval, completed prerequisites,
and success of every observed check. It does not discover the required-check policy,
prove acceptance criteria were fulfilled, or establish that the reviewer is a trusted
role. Work with durable issue-only results is allowed by policy but is unsupported by
this first auditor; it reports "cannot verify" rather than assuming success. Direct
Project writes are outside its control. These limits require separate verification.

## Results

- [Live lifecycle trial](evidence/2026-09-24-lifecycle.md): native relationships,
  blocker history, active stages, cancellation, revival, and an invalid Done write
  that the owner API allowed and the auditor rejected.
- [Container and App setup evidence](evidence/2026-09-24-containers.md): actual
  synthetic boundary and live egress tests, the proxy's demonstrated limitation,
  and verified App/token scope provisioning.

Add further evidence only after execution, distinguishing local validation, live
GitHub behavior, agent behavior, and permission enforcement.

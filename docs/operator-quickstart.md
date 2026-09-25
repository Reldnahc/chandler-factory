# Operator quickstart

**Suspended operating reference.** Do not execute this cycle while the launcher is
being prepared. The [readiness specification](launcher-readiness.md) governs that
preparation. Live validation and operational use require explicit authorization.

One manually dispatched implementation → independent review → integration cycle.
This is operating guidance, not evidence that a run passed. Follow the canonical
[workflow](workflow.md), [role briefs](agent-roles.md), and
[verification requirements](verification.md); this guide changes no policy or grants.

1. **Select authorized work.** The main conversation is the coordinator. It reads the
   live [Project](https://github.com/users/Reldnahc/projects/2).
   Select Ready work by priority with satisfied
   prerequisites and agreed scope, acceptance criteria, and verification. An
   explicitly authorized continuation can remain within an In progress issue.
   The coordinator prepares assignments and dispatches workers through the trusted
   interface once ready. Project writes require separately authorized access; the
   coordinator App has no Project write permission. There is no scheduler or
   separate backlog.

2. **Prepare the trusted deployment and packet.** Use the reviewed host launcher
   deployment and image preparation in the [runtime guide](../runtime/README.md),
   never a launcher modified by the task. Put the issue, bounded scope, acceptance
   criteria, verification, relevant links, and exact full source SHA in a short
   task packet. Use a committed checkout at that SHA; uncommitted files and Git
   metadata do not enter the snapshot. Keep owner bootstrap authority outside
   the role boundary and any claims about isolated-role permissions.

3. **Provision and launch a fresh implementer.** On the trusted host, follow
   [role token provisioning](github-identities.md#mint-one-short-lived-role-token-on-the-trusted-host).
   Supply only the implementation App's short-lived token and necessary Codex
   auth; each role uses its own separate App identity and credentials. Never
   supply owner credentials, App private keys, or another role's auth to a worker.
   Verify the actual GraphQL `viewer.login`, not just a credential filename.
   Once the interface is enabled for authorized use, call `factory_start` with a
   stable request identifier, implementation role, exact source revision, and bounded
   task packet. These are example tool arguments; replace the revision placeholder:

   ```json
   {"requestId":"story-implementation-1","role":"implementation","revision":"FULL_40_CHARACTER_SHA","task":"Scoped assignment and required references"}
   ```

   Protected service configuration supplies paths and credentials. The runtime fixes
   implementation to Astra / Medium. Keep the returned worker identifier for
   `factory_observe`, `factory_answer`, and `factory_send`. Observe questions and
   blockers and return clarification to that same worker. The worker implements
   and verifies only its bounded assignment. See the [tool reference](launcher-interface.md).

4. **Inspect and publish the result.** The host inspects the returned workspace,
   output, and retained source/image identifiers. Treat artifacts as untrusted;
   inspect changes and actual verification evidence before integration. Prepare
   the proposed commit and PR using authorized implementation authority, link the
   issue, and record commands, outcomes, and limits. Read the exact current PR head:

   ```sh
   gh api repos/Reldnahc/chandler-factory/pulls/N --jq .head.sha
   ```

   Record that full lowercase 40-character SHA. The host applies Review only when
   the result, lasting documentation, and evidence are available.

5. **Dispatch independent review.** The host makes that committed PR head available
   in its checkout and calls `factory_start` for a separate fresh reviewer, with
   `role: reviewer`, the exact head as `revision`, and a reviewer packet naming
   the PR, scope, acceptance criteria, and evidence. The runtime fixes review to
   Astra / High. Supply only reviewer
   App auth and necessary Codex auth. The reviewer inspects actual changes and
   evidence and records an ordinary GitHub review explicitly tied to that SHA,
   with assessed criteria, verification, findings, and limitations. It then runs
   **inside the reviewer container**:

   ```sh
   node scripts/publish-review-check.mjs --pr N --revision SHA
   ```

   Replace `N` and `SHA` with the PR number and exact head. Findings requiring edits
   return work to In progress; a new head requires new review and verification.
   Use `factory_send` to return actionable findings to the implementer. Keep review
   and implementation contexts separate, and close their sessions when finished.

6. **Refresh and integrate.** Immediately premerge, the host requests another
   reviewer-container run of that helper for the unchanged head. Require exit zero
   and its verified successful App result; inspect current reviews and live branch
   protection and require both successful, App-pinned checks on that exact head:
   **Workflow checks / 15368** and **Independent review / 5067522**. Native required
   approvals are zero, but ordinary independent review remains required. Stop on
   failed refresh, changed head, dismissed approval, or unresolved requested changes.
   Same-SHA review changes do not automatically revoke an earlier check; refresh
   and merge are not atomic. Follow the [completion procedure](workflow.md#done).
   The host performs permitted integration without bypassing the gate. Only after
   acceptance, review, evidence, and required merged PRs are complete does the host
   close the issue as completed and apply Project Done. Retain completion PR links
   for the [auditor and its limits](verification.md#running-the-initial-audits),
   then revoke each role token using the provisioning procedure.

Existing observations: [lifecycle trial](evidence/2026-09-24-lifecycle.md),
[container and identity evidence](evidence/2026-09-24-containers.md), and
[review-gate trial](evidence/2026-09-24-review-gate.md). These records describe their
own runs and limits, not completion of this quickstart's operating trial. Record
new results only after execution; instructions and local checks do not establish
credential isolation, review quality, or restrictions on direct owner Project writes.

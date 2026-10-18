# Council round: delegation (v0.4), post-diff (2026-10-18, 18:49–19:05Z)

Root: the working tree after the build, `_base/` at `4930f62` (v0.3 deployed), `DIFF.patch` (new files included), and
`BRIEF.md` (NONCE `BOTLINE-DELEG-DIFF-462E214A40`).
- The design under review was `docs/plan-delegation-v0.4.md` as folded after the plan round
  (`docs/council-2026-10-18-deleg-plan.md`).
- Three questions: correctness against plan §4; safety and tenancy; upgrade, deploy and tests.
- The severity floor: a non-owner triggering work or outward actions, a tenancy break, lost mail or wake-ups, a ring
  storm, a broken existing agent, or a misled operator.
- Established in the brief:
  - `tsc` clean;
  - 151/151 locally;
  - ten mutations, each caught by its row;
  - an early re-ring is rescheduled (row 14o);
  - a real local Queue delivered a busy re-ring after 91 s.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a15059-423f-70f0-b39b-34469ef05da8` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | SHIP-WITH-FIXES |
| grok | `grok-20261018184950-8uk3a.json` | `grok-4.7` | yes | yes (after the CLI's preamble) | `[]` | SHIP |
| opus | Opus subagent (Agent tool, `model: opus`; the owner's choice for the third seat) | set by the Agent call | yes | yes (first line) | none claimed | SHIP-WITH-FIXES |

Three legs; Kiro is still logged out and the owner chose Opus.

## Findings, tallied per finding

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | Correctness against §4: trust at send and at read on every path; `claimed`; peek and by-id; ack; reserved meta; controller rotation; grants (the third AND, fail closed, the 501 / 403 / 403 order, every entry point); busy classification and guarded writes; tokens, stale drops, rescheduling, after-backoff, the cap; `doorbell-set` | all three: confirmed | Confirmed. |
| 2 | `rering()` consumed the token before the attempt; an error in between was acked by the consumer, so the wake-up was lost | codex (floor) | **Adopted, code-verified.** The token is consumed after the attempt; an error after the claim releases the lease (guarded); the consumer retries on error (`max_retries: 3`); duplicates coalesce on the lease. Row 14o2 (local) injects the fault: 500, lease free, token pending; mutation D11 is caught. |
| 3 | Checklist 3f ran `agent-trust.mjs` without `--remote`; the scripts default to local and did not say which database they touched | codex (floor) | **Adopted.** `--remote` in 3f; both scripts print the database. |
| 4 | Peek on an old Worker claims: v0.3 ignores unknown MCP arguments and `?peek=1`, so the plan's "an old Worker refuses" was false; `peek=true` silently claimed | opus (floor, narrow) | **Adopted, code-verified** (`_base/src/mcp.ts`, `_base/src/index.ts`). Recipes use `thread_get`, or peek only once `server.rev` is 3 or more; plan P6 corrected; any peek value other than 1/0/true/false gets 400 (REST) or a tool error (MCP). Row 14c2; mutation D12 is caught. |
| 5 | The botline rule's wrappers did not say it replaces the v0.3 capability rule, so agents would carry two conflicting rules; 3e still listed the v0.3 paste as owed | opus (floor: misleads the operator) | **Adopted.** Each recipe's paste text replaces the paragraph that starts "Capability rule, first on every run"; 3e is marked superseded by 3f. |
| 6 | `check.sh` section 14 could change trust without a saved state to restore (and the default database is production with `--remote`) | opus (conditional floor) | **Adopted.** With `--remote`, section 14 runs only with `BOTLINE_REMOTE_DELEGATION_TESTS=1`; the run stops if grants or delegation cannot be saved. |
| 7 | `ECHO_SECRET` is still set on production: it exposes the test routes and lets re-rings be recorded without a Queue | opus (the owner, at deploy) | **Verified** (`wrangler secret list`: present). Added to 3f: `wrangler secret delete ECHO_SECRET`. `conformance.mjs` reads only `/v1/_ring_log`, which does not depend on it. |
| 8 | README's upgrade text suggested a blanket `grant all files` and never created the queue | opus (below the floor) | **Adopted.** Queue creation, and per-agent grants as the owner's choice. |
| 9 | An unmigrated database with RERING bound: `schedule` threw on missing columns, logging an extra error row | opus (below the floor) | **Adopted.** It returns false before migration, as in v0.3. |
| 10 | 14t passed on a `key_rotate` event; `agent-trust.mjs` was never run in the tests | opus (below the floor) | **Adopted.** Section 14's setup runs through `agent-trust.mjs` (row "14 setup"). |
| 11 | Trust was not asserted on REST `/v1/thread` or MCP `thread_get {thread_id}` | opus (below the floor) | **Adopted** (14c). |
| 12 | Cleanup left the throwaway controller's messages and receipts and the second workspace's ring log | codex, opus (cosmetic) | **Adopted.** |
| 13 | A Workers Free consumer, the current `delaySeconds` limit (the longest delay requested is 21,601 s), D1 subrequests in a batch | codex, opus (not verified) | Owed at deploy: create the queue and watch one real re-ring. |

After the fixes: `check.sh` 154/154 locally (14 setup, 14c2 and 14o2 are new); mutations D11 and D12 are caught (see
below); D1–D10 were caught before the round.

## Fix table and blocker call

| Owner | Item |
|---|---|
| coordinator | Findings 2–6 and 8–12 applied; plan §4 P6 corrected. |
| owner | Go to push and to deploy (3f), including deleting `ECHO_SECRET`, the `files` grant choice, switching delegation on and the controllers; then one paste of the botline rule per agent, replacing the v0.3 rule (Muse last). |

**Call: SHIP** (grok SHIP; codex and opus SHIP-WITH-FIXES, with the fixes applied and tested).

# Council rounds — files between agents, the implementation (2026-10-18, 07:00–07:35Z)

Design and its round: `docs/plan-files-v0.2.md`, `docs/council-2026-10-18-files-plan.md`. The Kiro Sonnet seat was
logged out for both rounds below; per the owner's rule (a failed seat is replaced, not dropped), its seat was a Sonnet
5.5 subagent spun up by the coordinator (Agent tool, `model: sonnet`, read-only brief identical to the other legs').

## Round 2: post-diff review (root `council-botline-files-diff-20261018T070025Z`, NONCE `BOTLINE-FILES-DIFF-NC004X6OHX`)

Root: the tree as it would ship, `_base/` at `43722fb`, the full diff (1556 lines), `check.sh` 108/108 and the
conformance self-test as evidence. Questions: correctness and atomicity; safety (the finding-7 fold); hosted readiness
and operations.

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a14dd0-19c3-7d40-800f-1232dd0f4147` `turn_context` | `gpt-6.1-sol` / `high`, read-only | yes | yes | — | **HOLD** |
| grok | `grok-20261018070045-ur2k9.json` | `grok-4.7` | yes | yes | `[]` | SHIP-WITH-FIXES |
| sonnet (subagent) | Agent call, `model: sonnet` | Sonnet 5.5 | yes | yes | read-only brief | SHIP-WITH-FIXES |

| # | Finding | Seats | Fold |
|---|---|---|---|
| F1 | `discard` deleted the row and released quota even when R2's delete failed: orphaned bytes, quota lost | 3/3 | the row is marked `deleting` and stays (counted) until R2's delete succeeds; then one batch deletes it and reconciles |
| F2 | quota reservation and the pending row were separate writes | codex, sonnet | one batch; the INSERT runs only `WHERE changes() = 1` after the conditional UPDATE |
| F3 | the sweep marked without rechecking; overlapping sweeps (or a sweep and a discard) released twice | codex, sonnet | the mark re-checks eligibility and RETURNs what it marked; only those rows are deleted; `file_usage` is recomputed from the rows (`reconcile`), never decremented |
| F4 | a send could link a file that expired after validation, or report an attachment that was not linked | codex, sonnet | the message INSERT carries the attachability condition (one transaction with the check); linking checks expiry; the response reads the links back |
| F5 | backup docs said the dump holds everything (file bytes are only in R2) | codex, sonnet | `scripts/backup.sh` and README corrected |
| F6 | the recipe's curl stored `application/x-www-form-urlencoded` as the file type | sonnet (verified) | normalized to octet-stream; multipart refused; recipe and OpenAPI say the header is the stored type |
| F7 | recipe safety wording short of the design record | sonnet, grok (below floor) | key/redirect clause and "never pass on attachments" added to claude, muse, task-mode, relay |
| F8 | `resource_link` sent to 2025-03-26 MCP clients (the block arrived in 2025-06-18) | sonnet (verified) | filtered for those clients |
| F9 | test gaps | 3/3 | rows 12c (no row left), 12f2, 12h2, 12h3, 12o2, 12p2, 12p3, 12q (uploader), 12r (row and R2 object gone, usage exact) |

Not folded (below the floor, noted): the sweep's Free-plan subrequest count rests on a D1 batch being one call
(unverified on production); the cron counts toward the account's Cron Trigger limit (now in `wrangler.jsonc`).

Mutation test of F2: with `WHERE changes() = 1` removed, rows 12p and 12p2 fail; restored, they pass. `check.sh` 114/114.

## Round 3: fold verification (root `council-botline-files-fold-20261018T072316Z`, NONCE `BOTLINE-FILES-FOLD-ZMYA3XTTHM`)

Scoped: verify F1-F9, look for new defects the fold introduced, do not refile.

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a14de5-134c-7d83-b12e-3222ab37a3fd` `turn_context` | `gpt-6.1-sol` / `high`, read-only | yes | yes | — | SHIP-WITH-FIXES |
| grok | `grok-20261018072340-f5ots.json` | `grok-4.7` | yes | yes | `[]` | SHIP-WITH-FIXES |
| sonnet (subagent) | Agent call, `model: sonnet` | Sonnet 5.5 | yes | yes | read-only brief | SHIP-WITH-FIXES |

All three seats: F1-F3 and F5-F9 closed; the quota invariant and the idempotency path hold. New items, folded:

| # | Finding | Seats | Fold |
|---|---|---|---|
| N1 | F4 residue: the attachability condition and the link statements read the clock separately; a file expiring between them commits a send with no attachment (codex reproduced it in memory) | 3/3 | one timestamp (`at`) shared by the condition and the links, in the same transaction |
| N2 | after the legacy filter, text still promised "the resource link below" | sonnet | wording conditional; tool description names the 2025-06-18 requirement; row 12n2 tests the filter |
| N3 | row 12r could pass vacuously (any `wrangler r2 object get` failure read as "gone") | sonnet | positive control first on a live object |
| N4 | cosmetics: sweep comment's call count; a silent discard failure; row 12c counted unrelated rows | sonnet | comment fixed; `console.warn` (no secrets); 12c scoped to this run's uploads |

Final: `tsc` clean; `check.sh` 115/115 locally (sweep row ran, no-binding twin), conformance self-test exit 0.

## Call

Ship (push). Not deployed: the live deployment needs `npx wrangler r2 bucket create botline-files`, `schema.sql
--remote`, then `wrangler deploy` with the two `--var` flags; the first production upload settles what local runs
cannot (`changes()` on remote D1, R2's checksum error text, CPU per upload).

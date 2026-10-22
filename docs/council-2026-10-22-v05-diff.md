# Council round: v0.5, post-diff (2026-10-22, 19:04–19:15Z)

- **Root:** the built tree (uncommitted, over `455fda2`), `_base/` from `git archive 455fda2`, `v05.diff` (1,286
  lines, new files included), `check-run.md` (164/164 locally) and `BRIEF.md` (NONCE `BOTLINE-V05-DIFF-E7718A09B3`).
- **Questions:**
  1. The watch URL and its route.
  2. The doorbell predicate against `trustFor`, line by line through the binds.
  3. Scripts, migrations, `me`/`agents_list`, and check.sh section 15 with its cleanup.
- **Severity floor:** the plan round's, plus vacuous test rows and cleanup that does not restore.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a164ff-ab4d-7da1-8cd9-2ab65a96a547` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | SHIP-WITH-FIXES |
| sonnet | Kiro `council-sonnet-seat`, `kiro-sol-ratify.py` PASS (8 requests, 10.31 credits) | `claude-sonnet-5.5` | yes | yes | n/a | SHIP |
| grok | `grok-20261022190415-01gdd.json` | `grok-4.7` | yes | yes | `[]` | SHIP |

Three legs, no residue in the root, one grok job.

## Findings, tallied per finding

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | 15a2 compared grokbot's grants after one type change with the grants after a second, so a type change that wiped grants would still pass | codex (HIGH) | **Adopted.** Code-verified. The row now grants `files` first, captures the grants BEFORE any change, and compares both later states with that baseline. |
| 2 | 15e counted every `signal_*` event muse ever had, so old events satisfy it with no new logging | codex (HIGH), sonnet (MEDIUM, same defect) | **Adopted.** It now counts events after an id boundary taken before 15c's mint: exactly 2 mints and 1 revoke. |
| 3 | No row tests trustFor's `from <> recipient` in the ring predicate | sonnet (note) | **Adopted.** New row 15f2: an agent listed as its own controller (raw edit) sends itself a hop-9 message. The watch URL does not count it, the doorbell logs `hop_ceiling`, and it reads `peer`. |
| 4 | Cleanup restores watch-URL rows by SQL without an event, so `activity.mjs` can show a revoke for a URL that is live again | sonnet (note, MEDIUM) | **Not adopted.** Test bookkeeping on a test database; no production path. |
| 5 | `doorbell.ts` now imports values from `store.ts` (an import cycle) | sonnet (did-not-verify note) | **No change.** Both are function declarations used only at call time, never at module top level. The bundled Worker ran 165 rows. |

**Q1 and Q2:** no leg filed a defect. All three traced the binds (`?1`-`?5` on the re-ring and the signal, `?1`-`?3` on the
send ring, which never names `trust_at_send`) and found them consistent.

## After the fixes

- `check.sh` ran **165/165** locally, on a copy of the v0.4 local database upgraded with `schema.sql` then
  `migrate.mjs`. The same database had passed 164/164 twice before, so cleanup restores state.
- **Mutations**, each on a scratch copy with its own port and database, full suite:
  - The Opus execution verifier ran the baseline (164/164, 0 failed) and stalled. The main loop ran the rest with the
    same recipe.
  - Every mutation is caught. One was not caught at first: **M5 exposed a vacuous 15i.** All of default muse's unread
    mail at that point was past hop 8, so a signal query with no workspace filter still counted 0 for the other
    workspace. 15i now sends default muse a hop-0 message first, and M5 is caught.

| Mutation | What it breaks | Fails (165 rows) |
|---|---|---|
| M1 | `ringOne` never treats past-ceiling mail as a controller task | 15g |
| M2b | `RINGABLE_SQL` drops the "sender still a controller" test (bind kept) | 15f |
| M3 | a re-ring lists every unread message | 15h (alone; a parallel-load run also flaked the 14p race row) |
| M4 | a send's ring uses the statement that names `trust_at_send` | 15k |
| M5 | the watch URL loses its workspace filter on receipts | 15i (after the fix above; 0 failures before it) |
| M6 | the watch URL counts all unread mail | 15f, 15f2, 15k |
| M7 | `agents_list` drops `type` | 15a |
| M8 | `signal.mjs revoke` stops logging | 15e |
| M9 | `agent-type.mjs` also clears the agent's grants | 15a2 |

(M2 as first written, which deleted the clause, left `?5` unbound and failed 12 rows; M2b is the precise variant.)
Final run after every fix: **165/165**.

## Blocker call

The three findings that matter (1-3) are test-only and applied, and so is the 15i gap the mutations found. Nothing in
the server code was found wrong. SHIP.

# Council round: v0.6 work plan, plan round (2026-11-04, 06:30–06:38Z)

- **Root:** `git archive c27a93b`, the draft `docs/plan-v0.6.md`, the outside roadmap as text, `EVIDENCE.md` and `BRIEF.md` (NONCE `BOTLINE-V06-PLAN-DFC6167833`).
- **Questions:** the reconciler; status and retention; owner surface, CI and upgrade.
- **Severity floor:** lost mail or wake-ups; ring storms; exposed metadata or bodies; an agent key reaching an owner surface; deleted data that should survive; a broken agent, older database or deploy order; a test that cannot catch what it claims.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a1aa67-0c7e-7812-ae47-c012c0837601` `turn_context` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | PROCEED-WITH-CHANGES |
| sonnet seat | Kiro refused at once ("monthly usage limit has been reached"): no leg, no cost. Replaced under the failed-seat rule by a Sonnet 5.5 subagent on the same root and brief | Agent tool `model: sonnet` | yes | yes | none | PROCEED-WITH-CHANGES |
| grok | `grok-20261105063053-f34yq.json` | `grok-4.7` | yes | yes | `[]` | PROCEED-WITH-CHANGES |

Three legs, no residue in the root. Codex's second rollout is its own sub-thread, one companion process.

## Findings, tallied per finding, each checked against the code

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | Deleting a message frees its idempotency key: a retry 37 days later sends and rings again (`store.ts:276-281`, `schema.sql:39`) | codex, grok (sonnet: "acceptable, document it") | **Adopted, with a different fix.** See 2. |
| 2 | Deleting a message removes the sender's thread membership: a live thread answers 403 `not_in_thread` (`store.ts:307-313`, no expiry filter) | codex | **Adopted.** Retention scrubs `subject`, `body` and `meta` and keeps the row and its receipts. Dedupe, membership and hop rules do not change, there is no tombstone table, and no reader is affected: an expired message is unreadable, and only the dedupe path returns one. D7 becomes (b). |
| 3 | The 24 h cutoff strands recoverable mail | codex; grok on D3 (sonnet voted to keep it) | **Adopted.** Also true for the common case: mail waiting behind a dead doorbell would never ring after `doorbell-set`. Production has 0 unread, so the deploy-day worry behind the cutoff does not apply. D3 becomes (b). |
| 4 | A throw after a 2xx bypasses both bounds: the batch that writes `ok` fails, `attempt()` releases the lease, the next tick rings again (`doorbell.ts:190-197, 307-319`) | grok | **Adopted, corrected.** Grok asked for a write-ahead row. Smaller: once a ring has gone out, `attempt()` never releases the lease. A throw before the fetch still releases (row 14o2 keeps passing). Worst case during a persistent D1 write failure is one ring per lease, a rate bound and not a count bound. The same lease closes the Queue overlap, so the 120 s token rule stays. |
| 5 | A peeked, unacked task reads as unread, so a live agent gets up to three duplicate runs, and a refused ring may count as a failure (`store.ts:370-373`, `doorbell.ts:153-157`) | sonnet alone | **Adopted.** Verified: nothing records a peek, a `me`, a `thread_get` or an empty poll. New `agents.last_seen_at`, stamped at most every 15 s on any keyed call, off the request path. Mail a doorbell already accepted is re-rung only if the agent has been silent since that ring. The dashboard's "last seen" reads the same column, and an agent polling an empty inbox stops looking dead. |
| 6 | One later message marks every open request `replied` | all three | **Adopted.** D4 becomes (b): `replied` needs `reply_to`. See below. |
| 7 | Cheap fixes: `allows()` is JS, so filter before the 5-ring limit; pin the cap boundary; `await` the reconcile (`waitUntil` is cut at 30 s, an awaited Cron handler gets 15 min: Cloudflare docs); `--check` and the migration test must cover indexes and compare columns by name; empty cron means the daily job; `OWNER_KEY` under 32 characters counts as unset; `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`; fixture from git history; `reply_to` on an unmigrated database answers a clear error | sonnet | **All adopted.** |

## Votes (plan §3)

| Decision | codex | sonnet | grok | Result |
|---|---|---|---|---|
| D1 reconcile every minute | a | a | a | **(a)**, unanimous |
| D2 cap derived from `ring_log` | a | a | a | **(a)**, unanimous |
| D3 24 h age limit | b | a | b | **(b)**, none: mail is ringable until it expires |
| D4 infer replies from the thread | b | a* | b | **(b)**, `replied` needs `reply_to` |
| D5 thresholds as Worker vars, 60 min | a | a | a | **(a)**, unanimous |
| D6 `OWNER_KEY` bearer | a | a | a | **(a)**, unanimous |
| D7 purge timing | b | a | b | **(b)**, same timing; scrub, keep the row |
| D8 dead-letter mail only | a | a | a | **(a)**, unanimous |

*Sonnet's (a) was conditional on one-for-one matching, so all three rejected the plan's D4 as written.

**D4, what stays beside the vote.** Today's agents do not send `reply_to`, and asking Pat to paste a rule into each agent is the friction botline exists to remove. So the state stays literal (`awaiting_reply`) and a new fact sits beside it: `later_post_at`, the recipient's newest message to the sender in the thread after this one. A later post clears `overdue`, because the question "does anyone need to look?" has an answer, while `state` claims nothing. This is not an override of the majority: no message is ever marked `replied` by inference.

## Blocker call

Nothing blocks the build. Every finding above went into the plan before any code exists, and the diff round reviews how they were built. Pat is told the Kiro seat is out of credits for the month.

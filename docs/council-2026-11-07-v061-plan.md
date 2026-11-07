# Council round: v0.6.1 plan, plan round (2026-11-07, 12:07–12:26 local)

- **Root:** `git archive 3243c78`, the draft `docs/plan-v0.6.1.md`, `_mainloop/FACTS.md` (production aggregates, CI
  times, the Vitest package location), and `BRIEF.md` (NONCE `botline-v061-plan-5e42e4a28ff0`).
- **Questions:** Q1 the T1 reorder and the delivery contract; Q2 the T2 SQL mirror and the cap; Q3 everything else,
  including the section 1 verdicts.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a1b79f-724c-7d83-9e06-421c4a33bb0f` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high` | yes | yes | n/a | ADOPT-WITH-FIXES |
| sonnet seat | Kiro not logged in (`kiro-cli whoami`): no leg. Replaced under the failed-seat rule by a Sonnet 5.5 subagent on the same root and brief | Agent tool `model: sonnet` | yes | yes | none | ADOPT-WITH-FIXES |
| grok | `grok-20261107200724-0zmrb.json` | `grok-4.7` | yes | yes | `[]` | ADOPT-WITH-FIXES |

Three legs, no residue in the root. Codex's second rollout (`…01a1b7a0`) is its own sub-thread (`thread_spawn`), one
companion job.

## Findings, tallied per finding, each checked against the code

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | "Only JavaScript after the claim" is not exception-safe: `toMessage` parses stored JSON (`store.ts:197-198`), `wrap` runs after | all three | **Adopted.** Every response object is built before the claim. Afterwards only filtering and the `claimed` flag. |
| 2 | Spell out the order: the lease clear stays first; `json_each`, not `IN ()`; mail past the hop ceiling or to `none` doesn't ring | grok; codex, sonnet agree on the order | **Adopted.** T1 steps 1-5. |
| 3 | Race behaviour is asserted but untested: send, poll and ack between select and claim; `unread=0`; peek | all three | **Adopted.** T1 race tests via `faultyDb`'s `after`. |
| 4 | A poll that loses a race can return 0 while more than 100 are unread (new with read-then-claim) | sonnet | **Adopted.** Verified: today's single `UPDATE … IN (SELECT … LIMIT 100)` serializes into disjoint batches. Repeat once on a short claim. |
| 5 | The contract says recovery re-rings peeked mail. False once a doorbell accepted: a peek is a keyed call, `touch` stamps `last_seen_at` (`index.ts:104`), and `silent()` (`doorbell.ts:178`) then holds the re-ring | grok, codex (sonnet called the contract accurate) | **Adopted, 2-1.** Verified in code. Sonnet's suggested wording ("mail still unread is re-rung") is wrong for that case and is not used. |
| 6 | "Still listed by `unread=0`" holds only within the newest 100; a lost `needs: none` claim shows as `received`, not unanswered; a commit whose reply is lost is the same case | grok, codex | **Adopted.** Contract rewritten. |
| 7 | A global 2000 cap with a `truncated` flag is not "exact": one agent's rows evict another's, and the page renders null as "nothing" (`owner-page.ts:78`) | all three (sonnet: sound but must be shown) | **Adopted, with a different fix.** No cap: one `GROUP BY agent` aggregate. Partial summaries are not offered. |
| 8 | The SQL mirror of `replyFacts` must be spelled out: thread, `id <>`, author, `json_each` on the sender, explicit reply without a time rule, later post only without `reply_to`, no expiry filter; the drift test must run both ways | all three | **Adopted.** T2 lists every condition; the drift test compares the SQL aggregates with a full JS derivation. |
| 9 | Pruning closed reply rows changes another row's context: posts load only for reply threads (`store.ts:465`), so an `ack` row lost its `later_post_at` and turned "waiting" (codex reproduced it with the status functions) | codex | **Adopted.** Verified: `owner.ts:64` applies `later_post_at` to every `needs`, and posts exist only when a reply-requesting row is on the same page. A later post now closes only `reply` rows, as `overdueSince` already says. Listed in T2 as the one semantic change. |
| 10 | The 501 test gives `unread: 1` only if the newest 500 are read; "answered" does not set `read_at` | grok | **Adopted.** The fixture says read and answered, and spans two agents. |
| 11 | T3: blank at expiry, not at scrub; `NULL` never expires; `<=` at the boundary; `expired` at the top level, so update both callers; force `attachments: []`; the MCP `message_send` text | all three, in parts | **All adopted.** |
| 12 | T4: README:69 as a bare `npm run deploy` refuses every deployment with no file | all three | **Adopted.** The upgrade line names both forms. |
| 13 | T4: the host check reads only the private file (`deploy.sh:31`), so `--no-vars` with an edited `wrangler.jsonc` is wrongly refused | codex | **Adopted.** Verified. The effective allowlist (file line, else `wrangler.jsonc`) in both modes. |
| 14 | T0: schema loading (D1 `exec` splits on newlines), the bindings in `wrangler.jsonc`, a pre-migrate fixture, `faultyDb` must wrap `bind()`, `tsconfig` include, `npm test` above the quick exit (`ci.sh:60`) | sonnet, grok | **All adopted.** Verified `ci.sh:60` and `tsconfig.json`. |
| 15 | Row 4: the cost includes the `ring_log` join, so thread length alone is the wrong trigger; hop is not a strict length bound | codex, grok | **Adopted.** Rationale and trigger corrected; the deferral stands (all three agree). |
| 16 | The contract also goes in the openapi inbox description; skip the claim with no candidates | sonnet | **Adopted.** |

Section 1 verdicts: all three legs agree on every row. #1 High, #2 Medium, #3 downgraded to Low, #4 and #5 deferred,
`pendingRings` is one row per agent, #6 and #7 adopted.

## Blocker call

Nothing blocks the plan. Every finding is folded. The next review is the diff round after T0 to T4.

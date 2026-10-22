# Council round: v0.5 design, plan round (2026-10-22, 18:42–19:07Z)

- **Root:** `git archive HEAD` (`455fda2`), the draft `docs/plan-v0.5.md` and `BRIEF.md` (NONCE
  `BOTLINE-V05-PLAN-CF7B62EA5D`).
- **Questions:**
  1. The watch URL: exposure, writes, tenancy, what it counts.
  2. Controller tasks past hop 8: the predicate and the loop bound.
  3. Agent type and the rollout order.
- **Severity floor:** a non-owner minting or widening; content leaking through the signal; lost mail or wake-ups; ring
  storms or loops; tenancy; a broken existing agent; a broken deploy order or older database.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a164eb-b5b8-75d3-95f0-a368c464bce7` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | PROCEED-WITH-CHANGES |
| sonnet | Kiro `council-sonnet-seat`, `kiro-sol-ratify.py` PASS (2 requests, 4.86 credits) | `claude-sonnet-5.5` | yes | yes | n/a | PROCEED-WITH-CHANGES |
| grok | `grok-20261022184222-z7fb5.json` | `grok-4.7` | yes | yes | `[]` | PROCEED |

Three legs, no residue in the root, one grok job.

## Findings, tallied per finding

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | The plan says only re-rings name `trust_at_send`, but `afterClaim` runs for every ring, and SQLite resolves columns at prepare time. A shared SQL predicate breaks every doorbell on a database before the v0.4 migrate. | codex, sonnet (grok: no finding; it read the re-ring statement only) | **Adopted.** Code-verified (`src/doorbell.ts:171-193`). The send ring keeps a statement without the column; only the re-ring branch names it. New row 15k renames the column away: a hop-0 send still rings, hop 9 is `hop_ceiling`, the watch URL is 404. |
| 2 | The predicate must carry trustFor's `from <> recipient`. An agent listed as its own controller (raw database edit) would ring past hop 8 while it reads `peer`. | sonnet (as part of 1) | **Adopted.** Code-verified (`src/store.ts:225-227`; `agent-trust.mjs` refuses it, but a raw edit can write it). In `RINGABLE_SQL` and `controllerTask`. |
| 3 | The second ceiling does not bound a loop that starts a new thread each time | codex, sonnet (as a note) | **Not this change.** True at hop 8 since v0.1 (every new thread starts at 0). No plan change. |

## Votes (plan §5)

| Decision | codex | sonnet | grok | Result |
|---|---|---|---|---|
| D1 token in the query string | a | a | a | **(a)**, unanimous |
| D2 count ringable mail only | a | a | a | **(a)**, unanimous |
| D3 second ceiling at 32 | a | a | a | **(a)**, unanimous |
| D4 scripts validate types, no CHECK | a | a | a | **(a)**, unanimous |
| D5 the owner-minted token is the only gate | a | a | a | **(a)**, unanimous |

## Main-loop facts gathered during the round

Muse answered the open question over botline (`thr_01m5jefse0kwrk0jzhsmn3yj6v`, 18:44Z): a token in a detector "would
break" its rule, and outbound HTTPS from a detector is unverified (plan §7). That is the owner's call in Muse's own
chat. No leg's vote rested on it, and the brief excluded it.

## Blocker call

Nothing blocks the build. Findings 1 and 2 went into the build before any code was council-reviewed, and the diff round
checks them.

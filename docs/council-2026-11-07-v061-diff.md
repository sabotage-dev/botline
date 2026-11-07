# Council rounds: v0.6.1 diff (2026-11-07)

Branch `v0.6.1-pre`. Round 1 reviewed `3243c78..7b414ba` (T0–T4). Round 2 reviewed only the round-1 fold, `7b414ba..04cce87`.
The round-2 fold is `ce48d9b`.

## Ratification (from the records)

| Round | Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | codex | rollout `…01a1b7d3-92de-7751-9446-e668e601665c`, `task_complete` | `gpt-6.1-sol` / `high` | yes | yes | n/a | BLOCK |
| 1 | sonnet seat | Kiro not logged in: replaced under the failed-seat rule by a Sonnet 5.5 subagent, same root and brief | Agent `model: sonnet` | yes | yes | none | SHIP-WITH-FIXES |
| 1 | grok | `grok-20261107210420-t5mkw.json` | `grok-4.7` | yes | yes | `[]` | SHIP-WITH-FIXES |
| 2 | codex | rollout `…01a1b7e7-31e6-75c0-85fd-09dc7a3afb8a`, `task_complete` | `gpt-6.1-sol` / `high` | yes | yes | n/a | SHIP-WITH-FIXES |
| 2 | sonnet seat | as round 1 | Agent `model: sonnet` | yes | yes | none | SHIP-WITH-FIXES |
| 2 | grok | `grok-20261107212546-pgmi0.json` | `grok-4.7` | yes | yes | `[]` | SHIP-WITH-FIXES |

Three legs in both rounds. Neither root has residue. Each codex run has a second rollout, its own `thread_spawn` sub-thread.

## Round 1 findings, tallied per finding, each checked against the code

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | The unread path's repeat round runs fallible reads after the first claim commits. A throw there is a 500 that leaves the first round's mail read and unseen (codex reproduced it: 101 messages, one taken, a bad `meta` in the 101st) | all three (HIGH, HIGH, MEDIUM) | **Folded.** The refill cannot fail the poll and returns what the first round won. Four tests: the refill's candidate read, attachment read or claim fails, or a row won't parse. Making the `catch` rethrow fails all four. |
| 2 | `migrate --check` ignored `BOTLINE_WRANGLER_CONFIG`, so the schema check read another database than the one deployed | codex (MEDIUM), sonnet (LOW) | **Folded.** `scripts/_d1.mjs` passes `--config`. m18 points at a config with another, empty database. Without the pass-through, m18 fails. |
| 3 | The owner SQL accepted a valid-JSON non-array `to_agents`; the drift fixture didn't assert each closure on its own (requiring explicit replies to be later still passed) | codex, sonnet (LOW) | **Folded.** `json_type = 'array'`. A test with one recipient per case covers 14 closing rules. Both mutations fail it. |
| 4 | m13–m16 overwrote the variable m9 greps, so m9's host assertion passed vacuously | codex (LOW), grok (MEDIUM) | **Folded.** Separate variables. |
| 5 | A claiming poll took one more D1 round trip than before T1 | sonnet (NIT; latency is the owner's priority) | **Folded.** Each candidate is read with its message in one statement (`r.*, m.*`). A claiming poll is three statements, as before T1. |
| 6 | The refill sort used `localeCompare` | sonnet (LOW; grok checked that it matched) | Replaced with binary order in the rewrite. Nothing was owed. |
| 7 | The JSONC trailing-comma regex runs over string contents | sonnet (NIT) | **Not folded.** The values are hostnames. |

## Round 2 (the fold only)

R1-2 to R1-5: closed (3/3). R1-1: closed (grok); half-closed (codex, sonnet), because of the one new item:

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 8 | The refill's `catch` also swallowed a failure when the first round won nothing. That turned a 500 into an empty 200, which a polling agent reads as an empty inbox | all three (MEDIUM, MEDIUM, LOW) | **Folded in `ce48d9b`,** with the line all three proposed, `if (!first.won.length) throw e`. Test: another poll takes all 100 candidates and the refill's read fails, so the poll errors and message 101 stays unread. Removing the line fails it. |
| 9 | m18 matched any `migrate --check` failure | sonnet (NIT) | **Folded.** It also asserts `missing: table agents`. |
| 10 | A refill claim that commits while its reply is lost leaves that round read and unseen | sonnet (LOW) | **No change.** It is the lost-response case the Delivery contract already states. |

No third round. Round 2's only above-nit finding was unanimous, and its fix is the line all three legs proposed, pinned by a test that fails without it.

## Execution

- `npm test`: 42 tests pass. Red first: each regression test failed on the code it fixes, before the fix.
- Full `scripts/ci.sh` (9 steps: `check.sh`, conformance self-test, migration test, unchanged checkout) passed at `72fe016` (T1) and at
  `04cce87` (round-1 fold), and at the final head `ce48d9b`: all 9 steps passed (`check.sh` 588 s).

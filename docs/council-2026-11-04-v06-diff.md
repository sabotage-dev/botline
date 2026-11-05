# Council round: v0.6 applied diff, round 1 (2026-11-04, 07:38–07:58Z)

- **Root:** `git archive 1551836`, `_base/` at `c27a93b`, `DIFF.patch`, `BRIEF.md` (NONCE `BOTLINE-V06-DIFF-93813630C2`).
- **Questions:** the reconciler as built, with one deliberate trade-off to judge; status and retention; owner surface and tooling.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a1aaa4-d1a8-7bc3-ab62-929682d8248e` `turn_context` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | NEEDS-WORK |
| sonnet seat | Kiro out of credits this month: a Sonnet 5.5 subagent on the same root and brief | Agent tool `model: sonnet` | yes | yes | none | SHIP |
| grok | `grok-20261105073809-f9son.json` | `grok-4.7` | yes | yes | `[]` | SHIP |

No residue in the root.

## Findings, each reproduced on the main loop

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | `deploy.sh` forwards four named vars, so a `RETENTION_DAYS=off` line in the deploy file is silently dropped | codex | **Adopted.** Every line is now passed on, and a secret in the file is refused. Production's only non-default vars today are the three the checklist names (read from the deployed version), so nothing was at risk yet. |
| 2 | The 15 s `touch` throttle hides the first call after a ring, so a live agent can be woken twice | codex | **Adopted.** Reproduced by codex. I had called the window negligible; the throttle was unmeasured optimisation. Removed: every keyed call stamps. New row 16n2. |
| 3 | Older stuck mail consumes new mail's recovery budget: the anchor falls back to it after the new mail's first accepted ring, and `n` jumps from 0 to 5 | codex (sonnet: noted, unverified) | **Adopted.** Reproduced in SQLite. The budget now runs from the newest unread mail, which also removes the fallback. Row 16m now covers the second ring onward. |

Two SHIP verdicts sat over three real defects. The dissenting leg was right on all three, again.

## The trade-off (Q1)

A ring accepted mid-run and then swallowed leaves mail unread; the agent's last call came after the ring, so the silence gate never re-rings it. Codex and grok: keep the gate, because the alternative risks running a held task twice. Sonnet: replace it with "seen in the last N minutes", because the loss is silent and any keyed call defeats the gate. **Kept (2-1).** The mail stays unread and shows as outstanding on `/owner`, and the next send rings it.

## Round 2 (2026-11-05, 07:58–08:10Z): the fold only

Root: `git archive 29283cf`, `FOLD.diff` from `1551836`, NONCE `BOTLINE-V06-FOLD-D8697D668E`. Ratified from the records as above: codex `gpt-6.1-sol` / `high` read-only (`…01a1aab7-ce23-7622-a634-b225eb80731b`), `grok-20261105075854-e8r0t.json` `grok-4.7` with `touched: []`, the Sonnet 5.5 subagent. All three: findings 1–3 CLOSED. Grok and sonnet APPROVE; codex CHANGES-REQUIRED.

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 4 | A malformed deploy-file line such as `OWNER_KEY:value` has no `=`, so the error printed the whole line, secret included | codex (sonnet: noted as a rough edge) | **Adopted.** The error names the line number. Row m11. |
| 5 | m10 runs `--dry-run` and reads names, so removing the forwarding from the deploy command would still pass | codex | **Adopted.** Row m12 runs the real path against a stand-in `npx` and compares what `wrangler deploy` receives, values and colons included. |

Noted, not owed: two unconditional `touch` writes can land out of order, and the gate reads a ring's completion time, so an agent that peeks while a slow fetch is open can look silent. Each needs a peek-and-hold agent plus a race inside one ring; neither has been seen, and neither was raised as a defect of the delta.

## Round 3 (2026-11-05, 08:16–08:22Z): the last fold only

Root: `git archive 950256b`, `FOLD.diff` from `29283cf`, NONCE `BOTLINE-V06-FOLD3-A5587C9273`. Ratified from the records: codex `gpt-6.1-sol` / `high` read-only (`…01a1aac7-aaf2-7f31-b5dd-0e16423f12c3`), `grok-20261105081614-2nvdw.json` `grok-4.7` with `touched: []`, the Sonnet 5.5 subagent. No residue. Findings 4 and 5 CLOSED by all three; no new serious finding.

**Verdict: APPROVE, unanimous, at `950256b`.**

Non-blocking, none owed: the stand-in `npx` in m12 matches only `npx wrangler deploy` and passes other calls through; m12 joins arguments with commas, which is exact for its fixtures; the generated shim embeds paths in shell source, so a `TMPDIR` holding a quote or `$` would break it.

## Mutation passes (scratch copies, a fresh Worker and database per mutation)

- **39 on `1551836`:** every mutation caught on the row aimed at. The runner first reported M15 (a reply to someone else counts) as surviving; row 17f in fact fails under it. That row prints multi-line JSON, which hid `FAIL` from the runner's regex. Reproduced by hand: `steps: 11 failed: 1`.
- **13 on `950256b`, what the folds changed:** all caught on the row aimed at, including the budget anchored on the oldest mail again (16m), `touch` throttled again (16n2), `deploy.sh` dropping the vars or their values (m12), a malformed line printed again (m11) and `--check` ignoring indexes (m1).

Row `m6` does not run in a scratch copy, which has no release tag. It ran in the full suite.

## Blocker call

Nothing is owed. Findings 1–5 are fixed and reviewed. Deploy stays with the owner.

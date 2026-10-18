# Council round: agents learn new capabilities at deploy time, design (2026-10-18, 07:56–08:08Z)

Root: `git archive HEAD` (`32b11a3`) plus the draft `docs/plan-capabilities-v0.3.md` and `BRIEF.md` (NONCE
`BOTLINE-CAPS-PLAN-0CB3DA2DB7`).
- The owner asked for a way for agents to learn new botline capabilities at deploy time. The owner, not the author,
  wanted the council to make decisions D1 to D6. The draft's P1 to P8 were proposals.
- Three questions: the mechanism (D1, D2, D6); trust and safety (D2, D3, D4); hosted readiness and tests (D5).
- The severity floor: a wrong outcome; a broken safety model or tenancy boundary; an agent left permanently unaware of
  a change; or a forced rewrite when the hosted product comes.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a14e03-a322-7363-894d-417b1ca4dc72` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high`, read-only sandbox | yes | yes | n/a | D1 b · D3 no · PROCEED-WITH-CHANGES |
| grok | `grok-20261018075705-uwvvf.json` | `grok-4.7` | yes | yes (after the CLI's one-line preamble) | `[]` | D1 other · D3 no · PROCEED-WITH-CHANGES |
| sonnet | Sonnet 5.5 subagent (Agent tool, `model: sonnet`), read-only brief | set by the Agent call | yes | yes (first line) | none claimed; root sweep clean | D1 other · D3 no · PROCEED-WITH-CHANGES |

- **Three legs.** The Kiro Sonnet seat was unavailable because kiro-cli was not logged in. Per the owner's standing
  instruction, a failed seat is replaced, not dropped, so the coordinator's own Sonnet 5.5 subagent sat as the full
  third leg from the start.
- **Root sweep.** The root has exactly HEAD's files plus `BRIEF.md` and the draft, and nothing is newer than the
  brief.

## Findings, tallied per finding

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | P1 and P6 hid the how-to after an ack. With no memory between runs, the next run has empty `changes` and nothing to call new endpoints with. | all three | **Adopted.** A computed `capabilities` reference is on every response and is never hidden by acknowledgement. |
| 2 | "Exactly once" cannot hold. | codex, sonnet | **Adopted.** At least once, with idempotent handling. |
| 3 | An implicit mark-on-read loses a change when the run fails after the fetch (the inbox already claims at fetch, `src/store.ts:281-287`). | all three | **Adopted.** The ack is explicit, and only the nudge depends on it. |
| 4 | `0.2.0-pre` cannot be ordered as a string. | all three | **Adopted.** An integer changelog `rev`; `version` is for display only. |
| 5 | One cursor per agent hides a capability that is enabled after other entries were acknowledged. | grok, codex (sonnet's design had the defect) | **Adopted, 2 of 3.** Acknowledgement is per entry (`capability_seen`). Codex's alternative, a config revision that bumps on enable, also fixes it; per entry is the concrete fix filed. |
| 6 | The ack is scoped to the authenticated workspace and agent, never regresses, and records what was shown, not the newest deploy. | all three | **Adopted.** |
| 7 | Every recipe stops on an empty inbox (`claude.md:22`, `grokbot.md:22`, `muse.md:29`), so the block must be read first and must be present when `count` is 0. | all three | **Adopted** in the block and the standing rule. |
| 8 | MCP: carry the block in the `me` and `inbox_list` results, because tool results are `no-store` and only `tools/list` is cached. | all three | **Adopted.** |
| 9 | MCP ack carrier: an optional argument on existing tools, not a new `server_seen` tool. The pinned poller cannot call a new tool, and a new connector tool defaults to Needs approval. | grok, sonnet (codex: keep the tool, add it to the pinned allowlist) | **Adopted, 2 of 3.** Coordinator refinement awaiting the owner's OK: the argument goes on `me` only, because every inbox call claims unread mail (`src/store.ts:281-296`) and Muse must not fetch twice (`muse.md:23-26`). |
| 10 | Compute the block before the inbox claim, from the loaded agent row, and tolerate an unmigrated database. | sonnet (before the claim); grok, sonnet (unmigrated) | **Adopted.** Code-verified: the claim runs before the message reads (`src/store.ts:280-303`). |
| 11 | `owner_grant` is not a control: the server it guards also sets it, and it is default-allow. | all three | **Adopted.** `kind` is a label only; authority is the owner's closed default-deny rule. |
| 12 | P6 is mis-scoped: it invites self-modification and is default-allow. | all three | **Adopted.** Replaced with plan §6, merged from the sonnet and codex texts with grok's frozen-call scope. |
| 13 | The rule must live in the persistent routine or task prompt, not only a chat. | codex | **Adopted** (no dissent). |
| 14 | Docs references are same-host relative paths: no redirects, no credentials elsewhere. | all three | **Adopted.** |
| 15 | Files need an owner grant, since every recipe makes the owner paste a file safety rule. "Last manual step" is true only for entries that need no new permission. | sonnet (codex and grok treat files the same way) | **Adopted.** The first release after v0.3 still needs one line of owner yes per agent for files. |
| 16 | D3, a system sender: no. | all three | **Adopted** (P5). |
| 17 | D5: nothing in this channel stops a hostile operator, so state the limit. The block is a pure function of code and rows, with no runtime or admin text. | all three | **Adopted** (plan §1, §5). |
| 18 | Phase 1 needs workspace capability rows, a per-workspace notices switch, and a `hasCapability` gate enforced in handlers. | codex, grok (sonnet: functions now, a column later) | **Adopted, 2 of 3.** Tables `workspaces`, `workspace_capabilities`, `capability_seen`. |
| 19 | `tools/list` stays identical for every caller and gates at call time, or `cacheScope: "public"` breaks tenancy. | all three | **Adopted.** |
| 20 | New tables and columns go in both `schema.sql` and `migrate.mjs`. | codex, grok | **Adopted.** |
| 21 | MCP agents get tool names, not REST routes, because the connector hides the key. | codex | **Adopted** (no dissent). |
| 22 | Seed existing agents at the v0.1 baseline and new agents at the current rev. | sonnet | **Adopted** (no dissent). |
| 23 | The draft P8 tests prove plumbing only; add the fresh run after an ack, repeat without an ack, tenancy, late enable, ack edges, unmigrated, before-claim, forged block, lint, pinned tools, and a live agent check. | all three (items split across seats) | **Adopted** as plan §7. Section 13 becomes the new rows; the results table moves to 14 (grok). |
| 24 | Filter `TOOLS` by capability on the no-files twin. | sonnet | **Not adopted.** Single leg and below the floor: the call already errors (row 12s). Recorded in plan §8. |
| 25 | Server-enforced per-agent grants from the owner's CLI. | sonnet (optional) | **Not adopted for v0.3.** Recorded as the Phase 2 shape in plan §8. |

## Fix table and blocker call

| Owner | Item |
|---|---|
| coordinator | All adopted findings are folded into `docs/plan-capabilities-v0.3.md` (design only, no code). |
| owner | ~~OK or reject the ack-carrier refinement in finding 9 (`me` only).~~ **OK 2026-10-18:** "We don't break muse so build it the way you propose not what grok and sonnet proposed". |
| owner | After build and deploy: paste plan §6 once into each agent's routine or task prompt; answer each agent's "files" report with one line; set the claude.ai connector's file tools to Always allow if the routine should use them (`docs/recipes/claude.md:86-87`). |
| owner | `kiro-cli login`, so the next round has its normal Sonnet seat. |

**Call: no blocker.** Proceed to build the folded design on the owner's go. The post-diff round re-checks it.

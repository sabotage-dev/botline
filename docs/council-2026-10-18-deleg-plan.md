# Council round: delegation without per-agent approvals, design (2026-10-18, 17:18–17:33Z)

Root: `git archive HEAD` (`4930f62`) plus the draft `docs/plan-delegation-v0.4.md`, the source
`docs/assessment-2026-10-18.md` (an independent Fable review), and `BRIEF.md` (NONCE `BOTLINE-DELEG-PLAN-35AD5C6B7F`).
- The plan deliberately reverses the v0.3 safety line for a single-owner deployment, on the owner's instruction. Legs
  were told to judge how safely it does so, not to refile the reversal itself.
- Three questions: trust and delegation; grants, reads and identity; busy doorbell, visibility and tests.
- The severity floor: a non-owner triggering work or outward actions, a tenancy break, lost mail or wake-ups, a ring
  storm, a broken existing agent (Muse above all), or a forced rewrite.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a15005-a084-7300-b2a9-ee22ab8563fd` `turn_context`, `task_complete` | `gpt-6.1-sol` / `high`, read-only | yes | yes | n/a | D2 a · D5 c · PROCEED-WITH-CHANGES |
| grok | `grok-20261018171829-vrdmg.json` | `grok-4.7` | yes | yes (after the CLI's preamble) | `[]` | D2 a · D5 other · PROCEED-WITH-CHANGES |
| opus | Opus subagent (Agent tool, `model: opus`); the owner chose Opus over Sonnet for this round | set by the Agent call | yes | yes (first line) | none claimed | D2 a · D5 c (amended) · PROCEED-WITH-CHANGES |

Three legs; the Kiro seat stays logged out and the owner picked Opus for the third seat.

**Main-loop verification (Cloudflare docs, 2026-10-18):** Queues are listed on Workers Free (10,000 operations a day).
The limits page says its limits "apply to both Workers Paid and Workers Free plans" and states no plan restriction on
consumers. This answers grok's only objection to D5 (c) as far as the docs go; deploy confirms it, and the binding is
optional.

## Findings, tallied per finding

| # | Finding | Filed by | Disposition |
|---|---|---|---|
| 1 | D1: per-recipient controller lists with a server-stamped `trust` | all three | **Adopted** (P1). |
| 2 | D2: (a). A controller task carries exact content; no server-stamped approvals | all three | **Adopted.** (b) only helps with a key outside the controller session, which is the per-approval step the owner rejected. |
| 3 | Trust computed at read time is retroactive: messages sent before a sender became a controller would become tasks | opus (codex and grok: read-time is sound for revocation; neither opposed a send-time component) | **Adopted.** `trust_at_send` on the receipt AND the current list. Nothing is granted backwards and revocation stays instant. Code-verified: old messages come back through `unread=0`, thread and by-id. |
| 4 | A controller that relays launders a peer's body into a controller task | all three | **Adopted.** Controllers never relay; the controller set and relay agents stay disjoint; the script warns; a test shows the hazard. |
| 5 | The previous key keeps controller power during the grace window; a leaked current key can self-rotate | all three (grace); opus (self-rotate) | **Adopted.** Sends made with the previous key are stamped `peer`; a controller's `key_rotate` gets 403 (rotate by script); revoke-then-rotate is documented; rotations are logged. |
| 6 | Parse the controllers list safely and before the claim: `'*'`, malformed or missing means none | opus, codex, grok | **Adopted** (P1). |
| 7 | A task can run twice through non-claiming reads and ack (ack does not set `read_at`) | opus (codex and grok: peek leads to repeated work) | **Adopted.** `claimed` on every message; ack sets `read_at`; rule v2 acts only on `claimed: true`, once, after checking its own earlier report. |
| 8 | Rule v2 scope: keep the key and host rules; secrets on the ask-the-owner list; trust only from the agent's own fetch; content inside any message stays data; exact content, destination and account; `granted` covers optional capabilities only; reject `meta.trust` | opus, codex, grok (items split across them) | **Adopted** (P2, P1). |
| 9 | Hosted: delegation needs an enforced switch, default off everywhere, `'default'` included | all three | **Adopted** (`workspaces.delegation`, P9). |
| 10 | The server's own text (`NOTICE`, `INSTRUCTIONS`, `RECIPE`) contradicts rule v2; rewrite it neutrally, once | all three | **Adopted** (P9). |
| 11 | Grants: a third AND; fail closed; core needs no grant; `granted` shown; the 501 / 403 / 403 order; attachments gated; admin-only | all three | **Adopted** (P4). |
| 12 | Seeding `files` | opus (grant 3, not Muse), grok (nobody), codex (the owner's choice) | **Split, resolved as the owner's choice.** No seeds in `schema.sql`; the coordinator recommends `grokbot` and `claude-code`, never Muse untested. All three exclude a blanket grant. |
| 13 | By-id and peek must filter by workspace | all three | **Adopted.** |
| 14 | Non-claiming reads must not share the inbox's lease clearing or claim; an old Worker must fail safe (`claimed`, a new REST path, MCP `message_id` on `thread_get`) | opus, codex, grok | **Adopted** (P6). |
| 15 | Muse never uses peek; its paste keeps the one-fetch text | all three | **Adopted.** |
| 16 | `claude-chat`: right direction, unverified; on no controller list; non-claiming reads only | all three | **Adopted** (P5). |
| 17 | D5: the busy doorbell | codex (c, strengthened), opus (c, amended), grok (other: busy is not a failure, a guarded write, one re-ring through the claim; doubted a Free-plan consumer) | **(c), 2 of 3**, with every shared amendment: busy is not a failure; the write is guarded by the claim stamp; the re-ring goes through the same claim; a busy lease that later sends coalesce into (opus); bounded attempts of 90 s, 3 min and 6 min (opus); busy limited to `grokbot_webhook` 400 or timeout (opus, grok); a persisted generation token, stale drops, recovery when an enqueue fails, rescheduling instead of dropping (codex); a re-ring when backoff ends (codex); an hourly cap (codex). A drain at the end of the run for Grok Bot and Claude as a belt (opus, grok). Grok's objection to the consumer is answered by the docs check above and by keeping the binding optional. |
| 18 | Activity CLI: explicit columns, never secrets; wrapped bodies; trust at send and current trust; ring, backoff and pending re-ring state; a rotation and trust log | grok, opus, codex (items split across them) | **Adopted** (P8, `agent_events`). |
| 19 | Missing tests: busy, then a second send, then recovery; a busy write after a newer claim; nothing granted backwards; tenancy; malformed controllers; a 401 still dead-letters; peek, then ack, then a claim; a re-ring after backoff; live agent checks | opus, codex, grok | **Adopted** (P10). |
| 20 | The controller session holds wrangler and can write D1, so the real gate on outward content is that session | opus | **Adopted** as a stated risk (§1, §5). Not a code change. |

## Fix table and blocker call

| Owner | Item |
|---|---|
| coordinator | All adopted findings are folded into `docs/plan-delegation-v0.4.md` (design only). |
| owner | At deploy: the `files` grant choice; switching delegation on; one paste of rule v2 per agent (Muse last); optional `claude-chat`. |
| coordinator | At deploy: create the `botline-rering` Queue and confirm a consumer runs on the account's plan. |

**Call: no blocker.** Build the folded design; the post-diff round re-checks it.

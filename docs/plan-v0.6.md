# v0.6 work plan (2026-11-04, council-folded)

Source: GPT 6.1 sol's engineering roadmap, validated against this checkout and production on 2026-11-04. Owner's ask
(Pat, verbatim): "Read the feedback, validate it. Then come up with a plan (not design docs) to address it. Council the
plan, then gooooo".

**Council:** one plan round and a diff round, every finding folded below (`docs/council-2026-11-04-v06-plan.md`, `docs/council-2026-11-04-v06-diff.md`).

**State this is written against:** `c27a93b` on `main`, v0.5.0-pre; production Worker `bc2ec0fd`. Nothing below exists yet
unless the validation table says so.

**Boundary:** local work on branch `v0.6-pre`, one commit per task. No push, no remote migration, no deploy, no secret
set until Pat says go (T8). The roadmap's "one PR at a time" was for its own coding agent; Pat's "gooooo" covers the
sequence, so each task stays one reviewable commit.

## 1. Validation: what the roadmap got right

Production read 2026-11-04, read-only: 287 messages, 290 receipts, 290 ring_log rows, 1.09 MB. Five agents: `claude`,
`grokbot`, `sabotage` (doorbells); `claude-code`, `muse` (no doorbell; Muse has a hook on its watch URL).

| Roadmap claim | Verdict | Evidence |
|---|---|---|
| A lost initial ring leaves mail unrung (`store.ts:350`, `ctx.waitUntil`) | **Confirmed in code; never observed.** Not an emergency | 99 sends to doorbell agents since 10-18: 99 read, 0 without a ring_log row. Accepted-to-read max 91 s over 129 rings |
| Queue re-rings do not close the initial gap | **Confirmed, and wider than stated** | See "Gaps it missed" below |
| "Initial, re-ring and Cron should converge on one attempt function" | **Stale.** Send and re-ring already share `attempt()` (`doorbell.ts:101, 117`) | Only Cron is missing |
| Cron "every 5 minutes" | **Rejected.** Owner's rule: fastest possible, backstops included | Every minute, the Cron minimum |
| Status: read then silence is invisible to the sender | **Confirmed.** Receipts show it; nothing interprets it | 4 of 114 `needs: reply` requests got no reply in their thread; 3 of the 4 were acked. Ack is not answer, in the data |
| No reply correlation | **Confirmed** | No `reply_to` anywhere; replies are thread-only |
| Status lookup must not claim | **Already true** of `thread_get` / by-id (`store.ts:426-444`) | Build on that path |
| Repeated ACKs must not corrupt state | **Already true** (`COALESCE`, `store.ts:418`) | Keep a row |
| No owner surface; only a CLI (`activity.mjs`) | **Confirmed** | Every server route is keyed by agent |
| No CI, no `npm run check` | **Confirmed** | No `.github/`; `package.json` has neither |
| Migrations untested on an old snapshot | **Confirmed** | Only rename-a-table rows in check.sh |
| Expiry is not purge | **Confirmed** | No `DELETE FROM messages`, `receipts`, `ring_log` in `src/` |
| Retention is P0 | **Overstated.** 1.09 MB; first expiry 2026-11-12 | Truthfulness, not capacity: P2 |
| Wake-up recovery is P0 | **Overstated by evidence**, right to do first | Silent stall is the worst failure mode and the fix is small |
| Five outside testers (WS5) | **Right, and Pat's** | Nothing here recruits anyone. No post has gone out |

**Gaps it missed (all code-verified; the reconciler closes each):**
- `nothing_unread` race: a ring claims, sees nothing, releases, while a send that coalesced against it is unrung (`doorbell.ts:222-230`).
- A ring that throws is logged and never retried (`doorbell.ts:80-83`).
- `blocked_destination`, `rering_capped` and `rering_failed` drop the obligation; a Queue message past `max_retries` leaves a dead token (no DLQ, `wrangler.jsonc`).
- `peek` and `ack` do not release the ring lease (`store.ts:370-373, 414-422`), so later mail coalesces for up to 10 minutes and nothing rings it afterwards.
- A 2xx whose run dies leaves mail unrung until the next send. Never observed; still a silent stall.
- Deploy footgun: three `--var` flags must be retyped on every deploy, or `sabotage`'s doorbell turns off (`blocked_destination`) and the waitlist disappears.

## 2. Tasks, in order

Order differs from the roadmap: recovery before status, because it is the only task that touches the core promise, and
CI first because every other task is judged by it.

### T1. `npm run check`: isolated runner and CI
- `scripts/ci.sh [--quick]`, `npm run check`, `npm run check:quick`.
- Quick: typecheck, schema + migrate on a temp database.
- Full: adds the isolated Worker (and its two twins so the skipped rows run), `check.sh`, `conformance-selftest.sh`, the migration test (T6).
- Isolation: everything under `mktemp -d`; generated secrets; `XDG_CONFIG_HOME` points into the temp dir and `CLOUDFLARE_*` are unset, so wrangler has no credentials; its API base is a dead local port; a step attempts a `--remote` read and fails the run if it succeeds; `BOTLINE_D1_MODE=--local` forced; bases are `127.0.0.1` only; keys never printed. (`HOME` is not swapped: it breaks pyenv shims. `WRANGLER_HOME` does nothing: measured.)
- `.github/workflows/ci.yml`: push to `main` and pull requests, `permissions: contents: read`, no secrets, actions pinned by SHA.
- Done when: a fresh clone runs `npm ci && npm run check` to a reliable exit code, and `git status` is clean afterwards.

### T2. Reconciler: lost wake-ups (P0 by consequence)
- `wrangler.jsonc` adds cron `* * * * *` beside `23 4 * * *`; `scheduled()` runs the reconcile for that exact string and the daily job otherwise. Both are awaited: `waitUntil` is cut at 30 s, an awaited Cron handler gets 15 minutes.
- `reconcile(env)` in `src/doorbell.ts`. One SQL statement over `agents`, `rings`, `receipts`, `messages`, `workspaces`, so idle agents cost nothing and the `receipts_unread` index is used per agent. Eligible when all hold:
  - a doorbell (`doorbell_kind <> 'none'`, URL set, known adapter, `adapter.allows()` true);
  - not dead-lettered, no live lease (the same fields `attempt()` claims on);
  - no re-ring pending: `rering_at` is NULL or more than 120 s past due;
  - unread, unexpired, `RINGABLE_SQL` mail (no age limit: D3).
- **Bounded by what the log already says.** Count the `ok` rows in `ring_log` for this agent since the newest unread mail. Ring while that count is `<= RECOVER_MAX` (3), so each new message gets at most 4 accepted rings: its own and 3 recoveries, whatever older mail is stuck (diff round finding 3). No new column; add index `ring_log (workspace_id, agent, at)`.
- **Silence gate (council finding 5).** Mail a doorbell already accepted is re-rung only if the agent has been silent since the last `ok` ring: `agents.last_seen_at` is older than that ring. A live agent that peeked and is working is never re-rung. Never-accepted mail does not need the gate: nothing has woken anyone for it.
- **The lease is the cooldown.** A 2xx holds the lease 10 minutes, so recovery rings land at about 10, 20 and 30 minutes, then stop until newer mail arrives. Never-accepted mail rings on the next tick.
- `agents.last_seen_at`: stamped in `ctx.waitUntil` on every keyed REST or MCP call. No throttle: the gate compares it with a ring's time, so a throttle would hide the first call after a ring (diff round finding 2). A database without the column skips it.
- **A ring that has gone out keeps its lease (council finding 4).** `attempt()` releases on a throw only before the fetch. After the fetch the lease stays, so a failing `ok` batch cannot ring every tick, on any path.
- Uses `attempt()` / `rering()`, so one lease, one ring path, one backoff. A token more than 120 s overdue goes through `rering()`, which consumes it. `adapter.allows()` runs in JS before the limit of 5 rings per tick, oldest mail first, in parallel, so a blocked agent neither logs nor starves another. Failures of one agent do not stop the others.
- `ring_log.detail = 'reconcile'` on the rows it causes. Only unread mail rings; mail already claimed is never re-rung, so nothing resubmits an instruction.
- Rows: every line of the roadmap's failure matrix (section 16), plus an agent with no `rings` row, old mail behind a repaired dead doorbell, past hop ceiling, expired, blocked destination (no log spam, rings once fixed), stale token, peeked mail with a live agent (no ring), post-fetch throw (one ring, lease kept), both sides of the cap, unmigrated database. Mutations on the cap, the silence gate, the lease filter, the dead filter and the kept lease.

### T3. Message status and `reply_to` (P1)
- `src/status.ts`, a pure `deriveStatus()`. Each item in `receipts[]` from `thread_get` and `GET /v1/message/{id}` gains `state`, `overdue`, `overdue_since`, `reply`. Existing fields unchanged; REST and MCP identical; nothing claims or rings.
- States: `waiting`, `notified`, `received`, `awaiting_ack`, `acknowledged`, `awaiting_reply`, `replied`. An ack does not satisfy `needs: reply`. Overdue is a reversible flag; there is no `failed` state.
- `reply_to` on send (REST, MCP, OpenAPI), new nullable column `messages.reply_to`, named in the INSERT only when given. The parent must be a message the caller may read, else 404 `unknown_message`. It sets `thread_id` when omitted; a different `thread_id` is 400.
- `replied` needs an explicit `reply_to` from R, addressed to A's sender (D4). A reply is never surfaced to someone it was not sent to.
- `later_post_at`: R's newest message to A's sender in the thread after A, without `reply_to`. A fact, not a state: it never makes anything `replied`, and it clears `overdue`, so today's agents do not light up the dashboard. No owner paste is needed.
- Changelog rev 6 tells agents about `reply_to` through the `server` block; no owner paste.
- Rows: the roadmap's seven acceptance tests, plus mismatched thread, unknown parent, a parent the caller cannot read, one recipient's ack not touching another's state.

### T4. Retention (P2)
- `src/retention.ts`, called from the daily cron after `files.sweep`, bounded (5 passes of 500) and idempotent.
- 7 days after `expires_at`, a bounded `UPDATE` sets `subject = ''`, `body = ''`, `meta = NULL`. The row and its receipts stay, so idempotency, thread membership and the hop rule are untouched (council findings 1 and 2). Partial index on `messages (expires_at) WHERE body <> ''`, so scrubbed rows are not rescanned.
- File rows and bytes stay with `files.sweep`: access already requires an unexpired message (`files.ts:236-247`), so a scrub changes no reader.
- `ring_log` older than 30 days; `echo_hits` older than 1 day; `agent_events` never (audit); waitlist unchanged. `RETENTION_DAYS=off` disables the scrub.
- Docs say what remains after a scrub: who sent what to whom and when, no content. A dedupe hit on a scrubbed message returns empty `subject` and `body`.
- Rows: rerun is a no-op; a replay after the scrub is still `duplicate: true` with no ring; a sender keeps thread membership; `file_usage` unchanged; expired-but-inside-grace kept.

### T5. Owner dashboard, read-only (P1)
- Secret `OWNER_KEY`. Unset or under 32 characters: `/owner` and `/v1/owner/*` answer 404. Bearer checked by comparing sha256 digests, matched before agent auth. Agent keys never pass.
- `GET /owner`: one static page, no data in the HTML, strict CSP, `frame-ancestors 'none'`, all values set with `textContent`. The key stays in `sessionStorage`; no cookie, so no CSRF surface.
- `GET /v1/owner/overview`: per agent: type, doorbell state, `last seen` (`agents.last_seen_at`, never a 2xx), unread, overdue, oldest outstanding, next re-ring, "stuck" (recovery cap reached).
- `GET /v1/owner/messages?cursor=&agent=`: keyset pagination, metadata and per-recipient status from `deriveStatus()`. No subject or body.
- `GET /v1/owner/messages/{id}`: subject and wrapped body on an explicit click.
- `GET /v1/owner/rings?cursor=&agent=`: ring log.
- GET only. No write touches `receipts` or `rings`. Workspace is `default`, as everywhere in Phase 1. Never returns `key_hash`, `doorbell_url`, `doorbell_secret`.
- Rows: 401 for no key and for each agent key, 404 unset, no leak of the second workspace, no read/lease change after a full page load, cursor stability, page is inert on a hostile subject.

### T6. Upgrade and operations (P1)
- `scripts/migration-test.sh`: the real v0.1 `schema.sql` from git (`04d1ca5`) as a frozen fixture plus seeded rows, then `schema.sql` + `migrate.mjs` twice; row counts and a content hash unchanged; the upgraded schema matches a fresh install by column name, and index by index; `doorbell-reencrypt.mjs` twice leaves one layer of encryption and the ring works.
- `migrate.mjs --check`: read-only, exit 1 naming missing columns, tables and indexes.
- `scripts/deploy.sh`: `--check` against remote, then deploy with vars from a private local file; refuses if an agent has a `generic_webhook` doorbell while `WEBHOOK_ALLOWED_HOSTS` is empty.
- Structured `console.log` JSON for `reconcile`, `dead_letter`, `retention`, with ids only. One mail to `OWNER_ALERT_TO` through the existing Resend key on the transition to dead-letter (exactly when `fail_count` reaches `DEAD_AT`).

### T7. Docs and version
README (Configuration, Admin scripts, Security model, Upgrading, the stale backoff line), OpenAPI and `/docs`, recipes (`reply_to` in the reply step for new setups), `0.6.0-pre` everywhere it is written.

### T8. Owner gate: nothing runs without Pat's go
Push; backup; `schema.sql`, `migrate.mjs`, `wrangler secret put OWNER_KEY`, `deploy.sh`; one recovery proof on production; site update; `v0.6.0-pre` release. The account has 1 cron today, so this is 2 of the 5 a free account allows.

## 3. Decisions, as the council settled them

| # | Decision | Result |
|---|---|---|
| D1 | Reconcile cadence | Every minute (3-0) |
| D2 | Recovery cap | Derived from `ring_log` (3-0) |
| D3 | Recovery age limit | None: mail is ringable until it expires (2-1) |
| D4 | Reply from a client without `reply_to` | Stays `awaiting_reply`; `later_post_at` beside it (2-1, all three rejected the draft) |
| D5 | Overdue thresholds | Worker vars, both 60 min: no measured reply or ack would have tripped it (3-0) |
| D6 | Owner auth | `OWNER_KEY` bearer (3-0) |
| D7 | Purge | 7 days after expiry, by scrubbing content; `ring_log` 30 days; `agent_events` kept (2-1) |
| D8 | Alerts | Dead-letter mail only; everything else on the dashboard (3-0) |

## 4. Not doing

Outbox table, task engine, execution leases, task heartbeats, automatic task retry, per-workspace timeout config,
Cloudflare Access, owner mutations, recruiting testers. The stop condition in the roadmap stands: no generalized task
engine because a dashboard would be easier that way.

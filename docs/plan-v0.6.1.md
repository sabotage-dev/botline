# v0.6.1 work plan (2026-11-07, council-folded)

Source: a Codex review of botline (7.5/10; three correctness gaps, four architecture points). Pat's ask: "Treat it
skeptically. Verify, and where it provides good advice/feedback, put a plan together to address."

**Council:** one plan round, every finding folded below (`docs/council-2026-11-07-v061-plan.md`). Two diff rounds on the
implementation, every above-nit finding folded (`docs/council-2026-11-07-v061-diff.md`).

**State this is written against:** `3243c78` on `main`, `VERSION` 0.6.0-pre; production Worker `82e5af1d` (v0.6).

**Boundary:** local work on a branch, one commit per task. No push and no deploy until Pat says go. No schema change, so
no migration.

## 1. Validation

Production read 2026-11-07, read-only aggregates: 358 live messages (oldest 2026-10-13, so nothing has expired yet), 156
receipts in the overview's candidate set (144 of them `needs: reply`), longest thread 12 messages, highest hop 11. CI on
`main`: 17 to 26 minutes a run, and 3 of the last 5 runs failed (`3243c78` records one failure as still unexplained).

| # | Codex claim | Codex | Verdict | Ours | Evidence |
|---|---|---|---|---|---|
| 1 | A failed inbox response strands mail | High | **Confirmed** | High | `store.ts:420` claims (`UPDATE … RETURNING`), then `:439` reads the message rows, `:442` the attachments, and `toMessage` parses stored JSON (`:197-198`). Any throw there gives a 500 while the receipts are already `read_at`. Recovery skips them (`doorbell.ts:145`, `:290`: `read_at IS NULL`), and so do unread polls and peek (`store.ts:408`). The `unread=0` path (`:428-442`) has the same gap. This breaks the rule the code states at `:398`. Never observed, and it can't be seen in the data: a stranded message looks read. |
| 1b | A lost HTTP response needs a delivery contract | — | **Confirmed, docs only** | — | Lost responses can't be prevented server-side. The written contract is missing, and its guarantees are narrower than they look (T1). Server-side redelivery is **rejected**: only `claimed: true` makes a controller message a task (`store.ts:59-60`), so tasks are at-most-once by design, and README:178 promises a claimed message is never rung again. |
| 2 | Owner overview can report zero unread | Medium | **Confirmed** | Medium | `owner.ts:48` admits every `needs: reply` receipt, answered or not, and `:49` keeps the newest 500 across all agents. Answered requests fill the page and push older open work out. `unread`, `overdue` and `oldest_outstanding` (`:64-70`) all come from that page, and the page shows "nothing" for a null oldest (`owner-page.ts:78`). Production has 156 candidates today, so today's counts are exact. |
| 3 | An idempotent retry bypasses expiry | Medium | **Confirmed** | **Low** | `findPrior` (`store.ts:297`) has no expiry filter. Only the sender itself can reach it (same `from_agent`, same key), so it returns the caller's own words, from expiry until the scrub (or forever with `RETENTION_DAYS=off`). Nothing in production has expired yet. Fixed anyway: it is small, and every other read path enforces expiry. |
| 4 | Bound history queries | — | **Partly. Deferred** | — | `thread()` (`store.ts:508`) and `threadPosts` (`:464`) read whole threads: true. The longest production thread is 12 messages. Hop count is no bound on thread length: concurrent sends can share a hop. **Rejected for `doorbell.ts:182`:** `pendingRings` returns one row per agent (`GROUP BY` at `:155`, `:159`). Its cost is the unread-receipt scan plus a `ring_log` join (`:157-158`), not message volume. Revisit when a thread passes 100 messages, or when the minute tick's query time grows in Workers logs. |
| 5 | Dependency cycles around `store.ts` | — | **Confirmed. Deferred** | — | store→capabilities→store, store→doorbell→store and store→files→store exist. They are harmless today: every cross-module use is inside a function, and every full CI run boots the Worker. Extract a leaf module only when a test needs one. |
| 6 | Fast focused tests | — | **Confirmed. Adopted** | — | Every test goes through a live Worker and `check.sh` (1501 lines). The CI numbers are above. Row 1 can't be regression-tested there without a fault hook in production code. |
| 7 | `npm run deploy` skips the guards | — | **Confirmed. Adopted** | — | `package.json:14` runs a bare `wrangler deploy`. That restores the empty vars in `wrangler.jsonc:40-50`, which stops every `generic_webhook` doorbell and turns the waitlist off, and it skips `migrate.mjs --check`. README:40 and :69 tell people to run a bare deploy too. |

## 2. Tasks

Order: T0, then T1 to T3 (each needs T0's harness), then T4 (independent, so it can go first). One commit per task.

### T0. Fast test tier

- Cloudflare's Vitest integration for Workers (now `packages/vitest-plugin` in workers-sdk). Confirm the npm name and an
  exact version at least two weeks old through Context7 or npm **before** writing any test: T0 blocks on it. Tests run
  inside workerd with local bindings only. Confirm the pool accepts `wrangler.jsonc` as it is (R2, a Queue producer and
  consumer, two crons), or give it a stripped config.
- Schema: load `schema.sql` with wrangler's SQL splitter (the one `readD1Migrations` uses; D1 `exec` splits on
  newlines, and comments hold `;`), then apply it in a setup file with `batch`. For pre-migrate fallbacks, build a
  database from `scripts/fixtures/schema-v0.1.sql` the same way.
- `faultyDb(db, re, {after?})` wraps `prepare()` and the statement `bind()` returns. A statement whose SQL matches `re`
  throws on `first`, `all` or `run`, or inside `batch`. With `after`, a callback runs just before that statement
  instead, for race tests. Tests call store functions with `{...env, DB: faultyDb(...)}`. Production code gets no hook.
- `npm test` runs it. In `scripts/ci.sh` it is a step **before** the quick exit (`ci.sh:60`), so both `--quick` and the
  full run have it. Add the test directory and the Vitest types to `tsconfig.json` (`include` is `src/**/*.ts` today),
  so the typecheck step covers it.
- First suite: the `status.ts` rules (pure functions), to show the tier works. The T1 to T3 regressions go in their own
  commits. `check.sh` is unchanged and stays the full gate.
- Acceptance: `npm test` under 30 s locally, and `ci.sh --quick` green.

### T1. Inbox: read first, claim last

- The order in `inbox()`, both claiming paths (unread, `unread=0`):
  1. Clear the in-flight lease (`store.ts:415`), **first, as today**. Mail that coalesced against the old lease is
     already inserted and becomes a candidate. Mail inserted after the clear rings through the normal guards. (Mail past
     the hop ceiling, and mail to a `doorbell_kind: none` agent, never rings; the next poll has it.)
  2. Select the candidates with today's `mine` predicate and each path's `ORDER BY`/`LIMIT`.
  3. Read the message rows and the attachments, and build every response object: `toMessage`, `trustFor`, `view`.
  4. Claim: `UPDATE receipts SET read_at = ?3 WHERE … AND read_at IS NULL AND message_id IN (SELECT value FROM
     json_each(?)) RETURNING *`, with the candidate ids. With no candidates, skip the statement.
  5. After the claim, nothing that can throw: unread path, keep only the objects whose ids this claim returned and set
     `claimed: true`; `unread=0`, return the whole snapshot and set `claimed: true` only on the returned ids (never the
     pre-image `read_at IS NULL`, or two polls would both say `claimed: true`).
- Unread path, a lost race: if the claim won fewer rows than it selected, repeat steps 2 to 5 once and append the
  winners. Otherwise, a poll that loses to a concurrent poll returns 0 while more than 100 are unread. That is new with
  read-then-claim, since today's single `UPDATE … IN (SELECT … LIMIT 100)` gives two polls disjoint batches.
- The guarantee is "`claimed: true` once per recipient". Peek, `unread=0`, `thread_get` and by-id still show a body
  again, as today.
- Response shape unchanged.
- **Delivery contract**, written in the README inbox row, the MCP `inbox_list` description (`mcp.ts:78`), the openapi
  inbox description and `/docs`, with a `changelog.json` entry:
  - A claiming read gives each message `claimed: true` once.
  - If the response is lost, or the claim commits and its reply is lost, the mail is read but unseen. A claiming poll
    and peek no longer return it, and botline never rings for it again. It is still readable by id (`thread_get`, by-id)
    and listed by `unread=0` while it is among the newest 100.
  - Peer mail you must not miss: peek, store it, then ack each message (an ack marks it read). Peek again on your own
    schedule. A peek counts as activity, so recovery won't ring for mail a doorbell already accepted.
  - A controller task is at-most-once by design: a lost response loses the task rather than risk running it twice.
    The owner sees such a message as `received` (`needs: none`), or as `awaiting_ack` / `awaiting_reply`, turning
    overdue after the timer.
- Tests (T0 tier):
  - A fault on the message read, the attachment read, or the response building (a malformed stored `meta`) gives an
    error and leaves every receipt `read_at IS NULL`.
  - A fault on the claim, injected before it runs, claims nothing.
  - Race tests, using `after`:
    - A send between select and claim: not returned, still unread.
    - A concurrent poll, or an ack, wins a candidate between select and claim: that candidate is dropped, never
      returned twice as `claimed: true`, and the repeat step picks up the rest.
    - `unread=0` against a concurrent unread poll: the full snapshot is returned, with `claimed` only on this call's
      winners.
  - Peek still leaves the lease alone.
  - On the happy path, both modes match today's responses.
- Mutation: move the claim back in front of the reads. The fault tests must fail. Restore `IN (SELECT … LIMIT 100)`.
  The send-between test must fail.

### T2. Owner overview: exact per-agent summaries

- Replace the capped candidate page with one aggregate query, `GROUP BY r.agent`, over every unexpired receipt. No
  limit and no truncation. It returns:
  - `unread`: `read_at IS NULL`.
  - `oldest_outstanding`: `MIN(m.created_at)` over open rows.
  - `overdue`: open rows past the timer. The timer is `COALESCE(r.read_at, m.created_at) <= <cutoff>`, where the cutoff
    is the ISO time `now − STATUS_ACK_OVERDUE_MIN` for `ack` and `now − STATUS_REPLY_OVERDUE_MIN` for `reply`, as in
    `overdueSince`.
- Open, per `needs`, mirroring `stateOf` and `overdueSince` (`status.ts:26-41`):
  - `none`: `read_at IS NULL AND acked_at IS NULL`. Never overdue.
  - `ack`: `acked_at IS NULL`.
  - `reply`: no closing post exists. A closing post is a row `p` in `messages` with:
    - the same `workspace_id` and `thread_id`, and `p.id <> m.id`
    - `p.from_agent = r.agent`
    - `json_valid(p.to_agents)` and `m.from_agent IN (SELECT value FROM json_each(p.to_agents))`
    - and either `p.reply_to = m.id` (no time condition), or `(p.reply_to IS NULL OR p.reply_to = '') AND p.created_at
      > m.created_at`
    - no `expires_at` filter on `p`, since `threadPosts` loads expired posts.

    It uses `messages_thread`. Before the v0.6 migrate there is no `reply_to`: retry on `no such column: reply_to` with
    the later-post rule only, as `threadPosts` does.
- **One semantic change, on purpose:** today `owner.ts:64` also lets a later post close an `ack` row. But posts are
  loaded only for threads where some candidate asked for a reply (`store.ts:465`). So an `ack` row's "waiting" depends
  on which other rows happen to be on the page, which codex reproduced. From now on a later post closes only a `reply`
  row, as `overdueSince` already says. `status.ts` stays the definition: per-message views (`/v1/owner/messages`,
  `thread_get`) still derive in JS.
- Tests (T0 tier):
  - **Drift, both directions.** A fixture covering every `needs` × state, with these cases:
    - a reply to another message
    - a reply addressed to a third party
    - a reply from another agent
    - another thread
    - a multi-recipient message
    - an earlier post
    - a later post that names another message in `reply_to`
    - expired posts
    - both overdue sides of the boundary

    For each agent, the SQL's `unread`, `overdue` and `oldest_outstanding` must equal a JS derivation through `status.ts`
    over all of that agent's rows. The JS derivation applies the new `ack` rule.
  - **Cap regression.** Agent A gets 600 `needs: reply` messages, all read and answered with `reply_to`. One older
    message to A is unread. Agent B has one open message older still. Expect: A `unread: 1`, with `oldest_outstanding`
    = A's unread message. B is exact.
  - **Pre-migrate.** The fallback on the v0.1 fixture database.
- Mutation: drop the `NOT EXISTS`. The cap and drift tests must fail. Swap `reply_to IS NULL` for nothing. The drift
  test must fail.

### T3. Idempotent retry after expiry

- A prior row is expired when `expires_at IS NOT NULL AND expires_at <= now` (`NULL` never expires; the live test
  elsewhere is `expires_at > now`).
- Both duplicate paths (`store.ts:302`, `:377`) build `{duplicate: true, expired: true, message}` for an expired prior,
  with `expired` at the top level beside `duplicate`. The message is a full `Message` (`store.ts:41-47`): `v`,
  `workspace_id`, ids, thread, from, to, needs, hop, timestamps, `reply_to`. Its content is blanked at expiry, not at
  scrub: `subject: ""`, `body: ""`, `meta: {}`, and `attachments: []` even when a file row is still live. Non-expired
  duplicates are unchanged, with no `expired` field. The status stays 200: an error would make a client retry with a
  new key and send twice.
- Documented in `openapi.ts:219`, the MCP `message_send` description (`mcp.ts:63`), the README retention line and
  `changelog.json`.
- Tests: send with a key, set `expires_at` to now and to the past, then send again. Check `duplicate`, `expired`, an
  empty subject and body, `meta {}`, `attachments []` with a live file, and every identifier kept. The race path
  (`:377`): use `after` to insert the same key between `findPrior` and the batch. A row with `expires_at` 1 ms in the
  future is not expired.
- Mutation: drop the check. The tests must fail.

### T4. One deploy path

- `package.json`: `"deploy": "scripts/deploy.sh"`.
- `deploy.sh --no-vars`: no private file needed, no `--var` passed, so `wrangler.jsonc`'s values apply. It still runs
  `migrate.mjs --check` and the webhook-host check. `--no-vars` refuses when the private file exists (the same
  `BOTLINE_DEPLOY_ENV` default the loader uses), so Pat's deployment can't drop its vars by accident. Without the flag,
  a missing file still refuses, as today.
- Webhook-host check, both modes: check against the **effective** allowlist. That is the private file's
  `WEBHOOK_ALLOWED_HOSTS` when it has that line, else the value in `wrangler.jsonc` (read with comments stripped).
  Today the check reads only the file (`deploy.sh:31`), so a self-hoster who edited `wrangler.jsonc` would be refused
  wrongly.
- README:40 (fresh install) becomes `npm run deploy -- --no-vars`. README:69 (upgrade) becomes `npm run deploy` with a
  private file, else `npm run deploy -- --no-vars`. Update the usage line (`deploy.sh:18`) and README:156.
- Say plainly that this is convention: a hand-typed `npx wrangler deploy` still bypasses the guards.
- `migration-test.sh` rows, on the stand-in `npx` that m12 uses:
  - `--no-vars` with no file deploys and passes no `--var`.
  - `--no-vars` with a file present refuses.
  - `--no-vars` against a database behind the code refuses.
  - `--no-vars` with a `generic_webhook` host refuses when `wrangler.jsonc` doesn't list it, and passes when it does.
  - `npm run deploy` reaches `deploy.sh`.

### Not in this round

Rows 4 and 5, with their revisit triggers. No server-side redelivery (row 1b).

## 3. Ship

Full `npm run check` green on the branch. Council the diff. Then, on Pat's go: push, `scripts/deploy.sh` (no migration),
check `/owner` and one inbox round-trip on production, bump `VERSION` to 0.6.1-pre.

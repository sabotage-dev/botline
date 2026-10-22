# Agent types, watch URLs and controller tasks past hop 8: design for v0.5 (council-folded, 2026-10-22)

Owner asks (Pat, 2026-10-22, verbatim):
- On the signal: "why cant we add on some sort of token to the query string?"
- On robustness: "i think we need to maket his more robust too honestly. what if someone had two instances of muse they
  wanted to talk to? the agents name might be "blah" but the "type" is muse. same could go for grok or claude code"
- Earlier the same day, on a relay through ntfy.sh: "we're not building that into our solution." Everything here lives
  in botline itself.

Plan round: all three legs voted (a) on every decision; codex and sonnet's F1 is folded into P3
(`docs/council-2026-10-22-v05-plan.md`). Built as v0.5.0-pre.

## 1. Why

- **Muse's wait.** Muse cannot be pushed, so it polls every 5 minutes. A Muse **hook** runs a small detector script
  with no model turn and wakes a run only when something changed. Muse's docs say hooks have **no connector
  credentials** ("Do not add secrets to a detector"), so a detector cannot call `GET /v1/inbox` with Muse's key.
  Measured 2026-10-22 15:27Z:
  - Muse took 7 min 13 s send-to-reply: 2 min 54 s waiting for the poll, then 4 min 18 s in its own run.
  - Grok Bot, which is pushed, took 26 s.
- **Two of a kind.** An agent id is already only an address. Nothing in `src/` names `muse`, `grokbot` or `claude`.
  But botline cannot say what runtime an agent is. `doorbell_kind` says only how botline wakes it, and Muse and
  Claude Code on a Mac both show `none`. The recipes assume the ids `muse`, `grokbot` and `claude`.
- **Owed from v0.4.** A controller task sent into a thread past hop 8 is delivered but never rung (`HOP_CEILING`,
  `src/doorbell.ts:21, 75-76`). Proven live on 2026-10-18 (`docs/launch-checklist.md` 3f).

## 2. Facts (verified 2026-10-22 against the code)

- **Auth.** Every `/v1/*` route except the waitlist is behind `store.authenticate` (`src/index.ts:90-91`). Keys are
  looked up by sha256 (`src/store.ts:104-124`).
- **Agents.** The `agents` table has no type column (`schema.sql:5-21`). `me` returns fields of the authenticated row,
  read with `SELECT *` (`src/store.ts:233-247`). `agentsList` selects `id, name, doorbell_kind` (`src/store.ts:249-253`).
- **Migrations.** `migrate.mjs` adds missing columns (`scripts/migrate.mjs:9-19`). Re-running `schema.sql` adds new
  tables. The v0.4 deploy order was backup, `schema.sql`, `migrate.mjs`, then deploy (`docs/launch-checklist.md` 3f).
- **The doorbell.**
  - The hop ceiling is checked only on a send's ring (`src/doorbell.ts:75-76`).
  - A re-ring lists only unread mail at or under the ceiling (`src/doorbell.ts:186-192`).
  - `trust_at_send = 'controller'` is stamped on the receipt at send: delegation must be on, the sender must be on the
    recipient's list, and the sender must use its current key (`src/store.ts:298-301, 322-332`).
  - Read-time trust also needs the sender still on the list (`trustFor`, `src/store.ts:225-227`).
- **Production (read 2026-10-22).** Four agents in `default`:

  | id | doorbell | controllers |
  |---|---|---|
  | `claude` | `claude_fire` | `["claude-code"]` |
  | `claude-code` | `none` | none |
  | `grokbot` | `grokbot_webhook` | `["claude-code"]` |
  | `muse` | `none` | `["claude-code"]` |

  Delegation is on. Muse's connector targets `botline.botline.workers.dev`.
- **Observability.** It is on (`wrangler.jsonc` `observability.enabled`), so Cloudflare's request logs, visible only to
  the account, record full URLs, query strings included.
- **Muse's docs** (relayed by Muse over botline, 2026-10-22):
  - "Hooks run lightweight polling scripts and wake an agent on a relevant condition. Use them when the detector can
    check local or public data without an agent turn each time."
  - "Hooks have no connector credentials. Do not add secrets to a detector."
  - A hook wakes a new run with a fixed prompt. It cannot start a saved task itself; the woken run can, with `cron.run`.
  - A question on whether Muse will accept the watch URL below is out (§7).

## 3. Design

### P1. Agent type: a label, separate from id and name

- **Storage.** `agents.type TEXT NOT NULL DEFAULT 'custom'`, added by `migrate.mjs` and included in `schema.sql`'s fresh
  definition. No CHECK constraint, so a new type never needs a table rebuild (SQLite cannot alter a CHECK).
- **The known types.** They live in one file, `src/agent-types.json`. Each entry has an id, a label, a suggested
  doorbell kind and a recipe path:

  | Type | Runtime | Suggested doorbell |
  |---|---|---|
  | `claude-routine` | Claude Code routine | `claude_fire` |
  | `claude-code` | Claude Code on a machine | `none` |
  | `claude-chat` | claude.ai chat | `none` |
  | `grokbot` | Grok Bot | `grokbot_webhook` |
  | `muse` | Meta Muse | `none`, plus a watch URL (P2) |
  | `custom` | anything else | |

  The scripts accept only these ids. The `/docs` page lists them.
- **Who writes it.** The owner only:
  - `agent-add.mjs <id> --type <t>` (default `custom`). It prints the recipe and suggested doorbell to stderr.
  - A new `scripts/agent-type.mjs show | <agent> <type>`, which logs an `agent_events` row (kind `type`).
  - No API sets a type.
- **Who reads it.**
  - `me` returns `type`, read from the row with a fallback of `custom` before migrate.
  - `agents_list` (REST and MCP) returns `id, name, type, doorbell_kind`. It reads `SELECT *` and maps only those four
    fields, so a database without the column still answers.
- **It is a label and nothing more.** No server decision reads `type`: not trust, controllers, grants, doorbells or
  the signal. Two Muses are two ids with two keys, two connectors, two poll tasks and two watch URLs. Each can be
  either one's controller, or neither's.
- **Changelog.** Rev 4 is `messages`, kind `field`: "Agent type (v0.5): me and agents_list carry each agent's type, the
  runtime it runs on, separate from its id and name."

### P2. The watch URL: a key-free unread signal, per agent, behind its own token

- **Route.** `GET /v1/signal?token=sig_<32 alphanumerics>`, served BEFORE the auth gate with no Authorization. Only
  `GET`. The token alone picks the agent, so the URL carries no agent id and two Muses get two URLs.
- **Storage.** A new table, so there is no ordering problem with `migrate.mjs`:

  ```sql
  agent_signals (workspace_id, agent_id, token_hash TEXT NOT NULL UNIQUE, created_at,
                 PRIMARY KEY (workspace_id, agent_id))
  ```

  Only the token's sha256 is stored. Each agent has at most one live token.
- **Minting and revoking.** The owner runs `scripts/signal.mjs show | mint <agent> | revoke <agent>`:
  - `mint` prints the token once on stdout, like `agent-add.mjs` prints a key. It replaces any earlier token at once.
  - `revoke` deletes the row.
  - Both log `agent_events` (`signal_mint`, `signal_revoke`) with no token material.
  - No API and no agent can mint.
- **Response.**
  - 200 `{"unread": <n>, "latest": "<ISO created_at of the newest counted message>" | null}`.
  - Headers: `cache-control: no-store`, `referrer-policy: no-referrer`.
  - Nothing else: no ids, subjects, senders, workspace or agent id.
- **It writes nothing.** No claim, no lease change, no ring.
- **What it counts.** Unread (`read_at IS NULL`) and unexpired mail of the token's (workspace, agent) that a doorbell
  would ring: the P3 predicate. The signal is the doorbell of an agent that cannot be pushed, so it follows the same
  ring policy. A peer loop past hop 8 then does not wake a hooked Muse at hook speed; its backstop poll still delivers.
- **Failures are all the same 404.** A missing, malformed, unknown or revoked token, an agent that no longer exists,
  and a database without the table or columns all answer 404 `{"error":"not_found"}`. Unknown and revoked are
  deliberately indistinguishable.
- **Exposure, stated plainly.**
  - Whoever holds the URL learns whether the agent has ringable unread mail and when the newest arrived. It reveals
    nothing else and allows nothing else.
  - The token is not a botline key and not a connector credential.
  - It appears in Cloudflare's request logs (account-only), and in the detector script and its host.
  - The owner rotates it with `mint` and kills it with `revoke`.
- **Cost.** One D1 read per call: an indexed token lookup, then a count over the agent's unread receipts. A detector
  every 15 s is 5,760 requests a day, inside Workers Free (100,000 a day). No rate limit is added. A leaked URL can be
  hammered, but any botline URL can be hammered today (a 401 also counts as a request).
- **Changelog.** Rev 5 is `messages`, kind `endpoint`: "Watch URL (v0.5): an owner-minted GET /v1/signal?token=…
  reports an agent's unread count and newest time without a key; it marks nothing read."
- **The detector contract** (Muse recipe, P4):
  1. Poll every 15-60 s.
  2. Wake a run only when `unread > 0` AND `latest` differs from the value saved in hook state, then save `latest`.
  3. The wake prompt is fixed text: run the saved poll task (or do exactly what it does) once.
  4. Keep the scheduled poll as a backstop at a longer interval. It catches a woken run that died before its fetch:
     that mail keeps the same `latest`, so it never re-wakes.
  5. Two runs fetching at once are safe: the claim is atomic (`src/store.ts:381-389`).

### P3. Controller tasks ring past hop 8, up to a second ceiling

- **The ringable predicate**, one definition used by the send ring, the re-ring and the signal. A message is ringable
  for a recipient when either holds:
  - `hop_count <= HOP_CEILING` (8), or
  - all of these: `hop_count <= CONTROLLER_HOP_CEILING` (new, 32); the receipt's `trust_at_send = 'controller'`;
    delegation is on for the workspace now; and the sender is on the recipient's controllers now. These are the same
    conditions as `trustFor`, so a removed controller or delegation switched off stops it at once.
- **The send ring** (`ringOne`). Past `HOP_CEILING`, it reads the receipt's `trust_at_send` with `SELECT *` (column
  tolerance), `delegationOn` and `controllersOf(agent)`. Ringable mail goes on to `attempt` as usual; otherwise the
  ring logs `hop_ceiling` as today.
- **The re-ring** (`afterClaim`, `isRering`). The SQL filter becomes the predicate, with the delegation flag and the
  recipient's controllers bound as parameters.
- **Council fold (codex and sonnet, F1).** `afterClaim` runs for EVERY ring, and SQLite resolves column names when it
  prepares a statement. So only the re-ring branch may name `r.trust_at_send`; a send's ring keeps a statement without
  it, so a database before the v0.4 migrate still rings. A re-ring token exists only on a migrated database: `schedule`
  returns early without the `rering_` columns, which came with the same migrate as `trust_at_send`. The predicate also
  carries trustFor's `from <> recipient` (sonnet). check.sh 15k renames the column away and checks that a send still
  rings.
- **Why a second ceiling, not the per-hour cap** the checklist note suggested:
  - It is stateless and one predicate, the same in TypeScript and SQL.
  - It bounds a mutual-controller loop (A controls B and B controls A, an owner misconfiguration) at 32 hops in total.
    A per-hour cap would allow 6 rings an hour forever.
  - The live case was a task into a 9-hop thread. 32 leaves 24 more hops before "start a new thread" applies again.
  - Lease coalescing and the existing re-ring cap still apply.

### P4. Recipes for any id

- **`muse.md`.**
  - The setup takes `<id>` (default `muse`): `agent-add.mjs <id> --type muse`, and "verify `GET /v1/me` returns id
    `<id>`".
  - A new section, "Hook (v0.5): watch URL". It covers minting (`signal.mjs mint <id>`), the detector contract (P2),
    keeping the poll as a backstop, and revoking.
  - The "owed unread-count" sentence is replaced.
- **`grokbot.md`, `claude.md`.** `agent-add.mjs <id> --type …`, and a sentence that any id works.
- **README.**
  - A short "Agents: id, name, type" paragraph: two of a kind are two ids.
  - The watch URL in the security notes.
  - The hop-ceiling line updated: controller tasks ring up to hop 32.
- **`/docs`.**
  - The `type` field.
  - `GET /v1/signal` in the endpoint table and in OpenAPI, with `security: []`.
  - Anchors `#types` and `#signal`, so the changelog `docs` paths resolve (check.sh 13j).
- **Versions.** `VERSION` becomes `0.5.0-pre`. The headers of `schema.sql` and `wrangler.jsonc` say v0.5-pre.

### P5. Tests: check.sh section 15

Section 15 runs inside section 14's delegation gate and reuses its saved state and helpers. It saves and restores the
three agents' types, and deletes every signal row and the extra workspace it adds. The old "15. Table" becomes 16.

| Row | What it checks |
|---|---|
| 15a | **Types.** `agent-add --type muse` and `me.type`. `agents_list` carries `type` for every agent, default `custom`. `agent-type.mjs` sets a type; an unknown type is refused and nothing changes. A type change leaves trust and grants as they were. |
| 15b | **Signal 404s.** No token, a malformed token and an unknown well-formed token: all 404 with one identical body. |
| 15c | **Minted.** 200 `{unread:0, latest:null}`, exactly those keys, `no-store`. |
| 15d | **Counting.** Two sends: `unread` 2, `latest` = the second's `created_at`. Reading the signal claims nothing (peek still shows 2) and leaves an in-flight lease alone. After a claim: 0 and null. |
| 15e | **Rotation.** A re-mint kills the old token. Revoke gives 404. `agent_events` has the mint and revoke and no token text. |
| 15f | **Signal and the ceiling.** Peer at hop 9: not counted (still delivered). Controller at hop 9: counted. Controller at hop 33: not counted. Controller at hop 9 with delegation off: not counted. |
| 15g | **Doorbell and the ceiling.** Controller task at hop 9: rung (`ok`, echo +1). At hop 33: `hop_ceiling`. With delegation off: `hop_ceiling`. |
| 15h | **Re-ring.** A pending re-ring lists the hop-9 controller message and not the hop-9 peer message. |
| 15i | **Tenancy.** A second workspace's `muse` with its own token sees 0 while `default`'s muse has mail. |
| 15j | **Pre-v0.5 database** (`--local` only). With `agent_signals` renamed away, the signal gives 404 and nothing else breaks. |

### P6. Deploy (on the owner's go)

1. `scripts/backup.sh`.
2. `schema.sql --remote` (creates `agent_signals`).
3. `migrate.mjs --remote` (adds `agents.type`).
4. `wrangler deploy` with the two `--var` flags.
5. `agent-type.mjs`: `claude` → `claude-routine`, `claude-code` → `claude-code`, `grokbot` → `grokbot`, `muse` → `muse`.
6. `signal.mjs mint muse --remote`. The URL goes to the owner for the Muse hook prompt.
7. Production checks:
   - version `0.5.0-pre`, `server.rev` 5;
   - `type` in `me` and `agents_list`;
   - the signal: 404 for a bad token, 200 for the real one, and 1 after a test message, which a claim then clears;
   - `/v1/_echo` still 404.

## 4. Out of scope

- A signal for pushed agents. They have doorbells.
- A workspace-level off switch for signals. Phase 1 has one workspace; minting is already owner-only.
- Rate limiting. The Cache API is a no-op on `workers.dev`, which Muse uses.
- Server behaviour keyed on `type`.
- Renaming ids.

## 5. Decisions for the council

- **D1. Where the token goes:**
  - (a) the query string `?token=`, as the owner asked (proposed);
  - (b) the path `/v1/signal/<token>`.

  Both land in the same logs.
- **D2. What the signal counts:**
  - (a) ringable mail only, the P3 predicate (proposed);
  - (b) all unread mail.
- **D3. The bound on controller tasks past hop 8:**
  - (a) a second ceiling at 32 (proposed);
  - (b) at most 6 past-ceiling controller rings per recipient per hour;
  - (c) both.
- **D4. Type validation:**
  - (a) scripts validate against `src/agent-types.json`, with no CHECK (proposed);
  - (b) a CHECK constraint;
  - (c) free text.
- **D5. The signal's gate:**
  - (a) the owner-minted token only (proposed);
  - (b) also an optional capability with a per-agent grant.

## 6. Risks

- **Muse may refuse the URL in a detector** under its "no secrets" rule (§7). The fallback is an owner choice: a
  tokenless, opt-in public signal per agent id, or a shorter poll.
- **A hooked Muse with a dead backstop poll** would miss mail whose wake failed. The recipe keeps the poll.
- **Concurrent Muse runs** cost usage, not correctness.

## 7. Muse's answer (botline thread `thr_01m5jefse0kwrk0jzhsmn3yj6v`, 18:44Z)

- **Outbound HTTPS from a detector:** unverified. No doc line permits or forbids it.
- **The watch URL:** "Yes, it would break it ... A 32-char token in a URL is a bearer credential - unlisted and revocable
  does not make it a non-secret." Muse's alternative is a detector reading a local file that the poll writes. It cannot
  cut the wait, because the poll is the wait.
- **`cron.run` from a woken run:** unverified. Its advice is that the woken prompt does the poll itself, with the stored
  credential.

What that leaves is the owner's call, in Muse's main chat, not botline's:
- approve the URL explicitly, since it is a non-credential the owner publishes on purpose; or
- if Muse still refuses, choose between a public watch URL by agent id (a small follow-up, with exposure equal to a
  leaked token) and a shorter poll.

The token design ships as asked. It also serves any other hook-style watcher.

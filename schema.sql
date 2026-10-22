-- botline schema (v0.5-pre). Every table carries workspace_id (Phase 1 always 'default').
-- The full fresh-install definition. Idempotent and non-destructive: safe to re-run against a live database.
-- An existing database also needs `node scripts/migrate.mjs` (adds columns that CREATE IF NOT EXISTS cannot).

CREATE TABLE IF NOT EXISTS agents (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,                 -- sha256 hex of the bearer key
  key_hash_prev TEXT,                            -- the key before the last rotation, accepted until prev_valid_until
  prev_valid_until TEXT,
  allowed_senders TEXT NOT NULL DEFAULT '*',     -- '*' or JSON array of agent ids ('[]' = nobody)
  doorbell_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (doorbell_kind IN ('none','claude_fire','grokbot_webhook','generic_webhook')),
  doorbell_url TEXT,
  doorbell_secret TEXT,                          -- enc:v1:<iv>:<ct> (AES-256-GCM, DOORBELL_MASTER_KEY) or legacy plaintext
  created_at TEXT NOT NULL,
  controllers TEXT NOT NULL DEFAULT '[]',        -- v0.4: JSON array of agent ids whose messages are tasks for THIS agent
                                                 -- (only while the workspace has delegation on; scripts/agent-trust.mjs)
  type TEXT NOT NULL DEFAULT 'custom',           -- v0.5: the runtime it is (src/agent-types.json; scripts/agent-type.mjs).
                                                 -- A label only: nothing on the server decides anything from it.
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  hop_count INTEGER NOT NULL DEFAULT 0,
  from_agent TEXT NOT NULL,
  to_agents TEXT NOT NULL,                       -- JSON array
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT 'none' CHECK (needs IN ('reply','ack','none')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  meta TEXT,                                     -- JSON object
  UNIQUE (workspace_id, from_agent, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (workspace_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS receipts (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  message_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  delivered_at TEXT,                             -- doorbell accepted (2xx)
  read_at TEXT,                                  -- agent fetched it via inbox
  acked_at TEXT,                                 -- agent acked it
  trust_at_send TEXT,                            -- v0.4: 'controller' if the sender was this recipient's controller at
                                                 -- send (delegation on, current key); NULL = peer
  PRIMARY KEY (workspace_id, message_id, agent)
);
CREATE INDEX IF NOT EXISTS receipts_unread ON receipts (workspace_id, agent, read_at);

CREATE TABLE IF NOT EXISTS rings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  agent TEXT NOT NULL,
  in_flight_since TEXT,
  lease_until TEXT,
  last_status TEXT,
  last_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,         -- consecutive failed/timeout/error rings; 5 = dead-lettered until doorbell-set
  busy_count INTEGER NOT NULL DEFAULT 0,         -- v0.4: consecutive "busy" rings (the endpoint said it is mid-run)
  rering_at TEXT,                                -- v0.4: when a scheduled re-ring is due (NULL = none pending)
  rering_gen TEXT,                               -- v0.4: the pending re-ring's token; a queue message with another is stale
  rering_hour TEXT,                              -- v0.4: the UTC hour rering_count counts in
  rering_count INTEGER NOT NULL DEFAULT 0,       -- v0.4: automatic re-rings scheduled in rering_hour (capped)
  PRIMARY KEY (workspace_id, agent)
);

CREATE TABLE IF NOT EXISTS ring_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  agent TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,          -- ok | failed | timeout | coalesced | no_doorbell | hop_ceiling | nothing_unread
                                 -- | blocked_destination | error (reason in detail and rings.last_status)
                                 -- | backoff (not rung: inside the backoff after a failure) | dead_letter (not rung: 5 failures)
  http_status INTEGER,
  message_ids TEXT,              -- JSON array
  at TEXT NOT NULL,
  detail TEXT                    -- reason on error/failed/timeout rows: no_master_key | bad_master_key | decrypt_failed
                                 -- | http <status> | timeout | network_error | exception (NULL otherwise)
);

CREATE TABLE IF NOT EXISTS echo_hits (         -- test doorbell target (POST /v1/_echo; only when ECHO_SECRET is set)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  auth_present INTEGER NOT NULL,
  body TEXT
);

-- Hosted-interest waitlist (plan §2 rule 8): double opt-in. Only token hashes are stored. (A database created before
-- waitlist_mail may still have mail_day / mail_count columns here; nothing reads them now.)
CREATE TABLE IF NOT EXISTS waitlist (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL,                           -- lowercased
  would_pay TEXT NOT NULL CHECK (would_pay IN ('yes','no','maybe')),
  source TEXT,
  created_at TEXT NOT NULL,
  confirm_token_hash TEXT,                       -- sha256 hex of the token in the confirmation link
  confirmed_at TEXT,
  delete_token_hash TEXT,                        -- sha256 hex of the token in the delete link
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS waitlist_confirm ON waitlist (confirm_token_hash);
CREATE INDEX IF NOT EXISTS waitlist_delete ON waitlist (delete_token_hash);

-- Confirmation mails sent, per UTC day and address: the ledger both mail caps read (3 per address, and
-- WAITLIST_MAIL_CAP_PER_DAY in all). Deleting a signup does not touch it, so sign up, delete, sign up again cannot reset
-- either cap. Days older than 2 are purged on signup.
CREATE TABLE IF NOT EXISTS waitlist_mail (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  day TEXT NOT NULL,                             -- YYYY-MM-DD (UTC)
  email_hash TEXT NOT NULL,                      -- sha256 hex of the lowercased address
  count INTEGER NOT NULL DEFAULT 0,              -- confirmation mails to that address on that day
  PRIMARY KEY (workspace_id, day, email_hash)
);

-- Files (v0.2, docs/plan-files-v0.2.md). Bytes live in R2 (binding FILES) under ws/<workspace_id>/<id>; these rows hold
-- metadata, access and accounting. A file is usable only once state = 'ready' (R2 verified its sha256 and its size).
CREATE TABLE IF NOT EXISTS files (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,                              -- fil_<time-sortable>
  uploader TEXT NOT NULL,                        -- agent id, stamped from the key
  name TEXT NOT NULL,                            -- sanitized filename; returned only HTML-escaped inside a wrapper
  content_type TEXT NOT NULL,                    -- validated type/subtype token
  size INTEGER NOT NULL,                         -- bytes (the accepted Content-Length; checked against R2's size)
  sha256 TEXT,                                   -- hex, verified by R2 on write (set when ready)
  state TEXT NOT NULL CHECK (state IN ('pending','ready','deleting')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                      -- unattached: +FILE_UNATTACHED_HOURS; attached: max(file, message)
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS files_expiry ON files (state, expires_at);

CREATE TABLE IF NOT EXISTS message_files (       -- which messages carry which files (written with the message)
  workspace_id TEXT NOT NULL DEFAULT 'default',
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, message_id, file_id)
);
CREATE INDEX IF NOT EXISTS message_files_file ON message_files (workspace_id, file_id);

CREATE TABLE IF NOT EXISTS file_usage (          -- per-workspace reservation counter (quota checks are one UPDATE)
  workspace_id TEXT NOT NULL PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,              -- reserved or stored bytes, released only when R2 deletes them
  files INTEGER NOT NULL DEFAULT 0
);

-- Capabilities (v0.3, docs/plan-capabilities-v0.3.md). What each workspace may use, whether its agents get "what's new"
-- notices, and which changelog entries (src/changelog.json) each agent has recorded as read. The server block on me /
-- inbox is computed from these rows and deployed code; no text is ever stored here.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT NOT NULL PRIMARY KEY,
  notices INTEGER NOT NULL DEFAULT 1,            -- 0: server.changes stays empty for this workspace's agents
  created_at TEXT NOT NULL,
  delegation INTEGER NOT NULL DEFAULT 0          -- v0.4: 1 = honour agents.controllers (owner switch; default off everywhere)
);

CREATE TABLE IF NOT EXISTS workspace_capabilities (
  workspace_id TEXT NOT NULL,
  capability TEXT NOT NULL,                      -- an optional capability id from src/changelog.json (e.g. files)
  enabled INTEGER NOT NULL,                      -- 1 on, 0 off; no row = off (and the deployment's bindings still apply)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, capability)
);

CREATE TABLE IF NOT EXISTS capability_seen (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rev INTEGER NOT NULL,                          -- a changelog entry the agent recorded as read (POST /v1/me/seen, MCP me)
  seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, rev)
);

-- Phase 1 seeds. INSERT OR IGNORE, so re-running this file never undoes an owner's change. Turn files or notices off by
-- setting enabled / notices to 0, never by deleting the row: a re-run re-seeds a missing row. The one workspace with notices
-- on and files enabled; every agent already here has read the v0.1 baseline (rev 1), so files (rev 2) is its first
-- change. A later optional capability adds its own 'default' row here. scripts/agent-add.mjs records every current
-- entry for a new agent (it is set up from the current recipe).
INSERT OR IGNORE INTO workspaces (id, notices, created_at) VALUES ('default', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO workspace_capabilities (workspace_id, capability, enabled, updated_at)
  VALUES ('default', 'files', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO capability_seen (workspace_id, agent_id, rev, seen_at)
  SELECT workspace_id, id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agents;

-- Delegation (v0.4, docs/plan-delegation-v0.4.md). Per-agent grants of optional capabilities (no row = not granted;
-- scripts/grant.mjs is the only writer, and nothing here seeds them), and an owner-visible log of trust, grant and key
-- changes (scripts/activity.mjs).
CREATE TABLE IF NOT EXISTS agent_capabilities (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,                      -- an optional capability id from src/changelog.json (e.g. files)
  granted INTEGER NOT NULL,                      -- 1 granted, 0 revoked
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,                        -- the agent the event is about
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- key_rotate | key_revoke | controllers | delegation | grant | revoke
                                                 -- | type | signal_mint | signal_revoke (v0.5)
  detail TEXT                                    -- ids and values only; never a key or a secret
);
CREATE INDEX IF NOT EXISTS agent_events_at ON agent_events (workspace_id, at);

-- Watch URLs (v0.5, docs/plan-v0.5.md P2). GET /v1/signal?token=sig_<32> answers, with no key, how much ringable unread
-- mail one agent has and when the newest arrived; nothing else. Only the token's sha256 is stored, one live token per
-- agent; scripts/signal.mjs is the only writer (mint replaces, revoke deletes). Nothing here seeds a row.
CREATE TABLE IF NOT EXISTS agent_signals (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,               -- sha256 hex of the sig_ token
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);

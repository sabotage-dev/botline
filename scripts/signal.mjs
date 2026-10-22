#!/usr/bin/env node
// Usage (v0.5 watch URLs, docs/plan-v0.5.md P2):
//   node scripts/signal.mjs show                         [--local|--remote]
//   node scripts/signal.mjs mint <agent>                 [--local|--remote]
//   node scripts/signal.mjs revoke <agent>               [--local|--remote]
// mint: a new token to stdout ONCE (only its sha256 is stored); it replaces the agent's earlier token at once. The watch
//   URL is <your-botline>/v1/signal?token=<token>: no key, it answers only {unread, latest} for that agent and marks
//   nothing read. Give it to the script that watches for mail (a Muse hook's detector). `T=$(node scripts/signal.mjs
//   mint muse)` works (notes go to stderr).
// revoke: the agent's watch URL answers 404 from now on.
// Only this script writes watch URLs (no API, no agent can mint one). Logged in agent_events, never with the token.
import { createHash, randomBytes } from "node:crypto";
import { ID_RE, die, hasTable, logEvent, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [cmd, id] = pos;
const USAGE = "usage: signal.mjs show | mint <agent> | revoke <agent>  [--local|--remote]";
const rows = (sql) => { const out = runQuery(sql, mode); return Array.isArray(out) ? out.at(-1)?.results ?? [] : []; };

if (!hasTable("agent_signals", mode)) die(`no agent_signals table (${mode.slice(2)}): run schema.sql for v0.5 first`);

function show() {
  console.error(`watch URLs (workspace default, ${mode.slice(2)} database):`);
  console.error("| agent | watch URL since |");
  console.error("|---|---|");
  const s = rows("SELECT agent_id, created_at FROM agent_signals WHERE workspace_id = 'default';");
  for (const r of rows("SELECT id FROM agents WHERE workspace_id = 'default' ORDER BY id;"))
    console.error(`| ${r.id} | ${s.find((x) => x.agent_id === r.id)?.created_at ?? "-"} |`);
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function rand(n) {
  let s = "";
  while (s.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALPHA[b % 62]; // unbiased
  return s;
}

if (cmd === "show" && !id) show();
else if ((cmd === "mint" || cmd === "revoke") && id && pos.length === 2) {
  if (!ID_RE.test(id)) die(`bad agent id: ${id}`);
  if (!rows(`SELECT id FROM agents WHERE workspace_id = 'default' AND id = ${q(id)};`).length) die(`no agent '${id}' (${mode.slice(2)})`);
  if (cmd === "mint") {
    const token = `sig_${rand(32)}`, hash = createHash("sha256").update(token).digest("hex"), at = new Date().toISOString();
    runSql(`INSERT INTO agent_signals (workspace_id, agent_id, token_hash, created_at) VALUES ('default', ${q(id)}, ${q(hash)}, ${q(at)})
      ON CONFLICT (workspace_id, agent_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at;`, mode);
    const ok = rows(`SELECT token_hash = ${q(hash)} AS ok FROM agent_signals WHERE workspace_id = 'default' AND agent_id = ${q(id)};`)[0]?.ok === 1;
    if (!ok) die(`mint for '${id}' did not apply (${mode.slice(2)})`);
    logEvent(id, "signal_mint", "watch URL minted; any earlier one stopped working", mode);
    console.error(`watch URL for '${id}' minted (${mode.slice(2)}): <your-botline>/v1/signal?token=<token below>. Token shown ONCE:`);
    console.log(token);
  } else {
    runSql(`DELETE FROM agent_signals WHERE workspace_id = 'default' AND agent_id = ${q(id)};`, mode);
    logEvent(id, "signal_revoke", "watch URL revoked", mode);
    console.error(`watch URL for '${id}' revoked (${mode.slice(2)}): it answers 404 now.`);
  }
} else die(USAGE);

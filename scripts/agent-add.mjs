#!/usr/bin/env node
// Usage: node scripts/agent-add.mjs <id> [--name N] [--type T] [--allow a,b|*] [--local|--remote]
// Creates an agent with a fresh key. The key goes to stdout ONCE (only its sha256 is stored);
// human-readable notes go to stderr, so `KEY=$(node scripts/agent-add.mjs claude)` works.
// --type (v0.5): the runtime it runs on, one of src/agent-types.json (default custom); a label, never a permission.
// The id is only an address: two agents of one type are two ids (e.g. muse-home and muse-work), each with its own key.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ID_RE, die, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, flags, mode } = parseArgs(process.argv.slice(2), ["name", "type", "allow"]);
const [id] = pos;
if (!id || !ID_RE.test(id)) die("usage: agent-add.mjs <id> [--name N] [--type T] [--allow a,b|*] [--local|--remote]  (id: [a-z0-9_-], <= 32)");
const name = (flags.name ?? id).slice(0, 64);
const { types } = JSON.parse(readFileSync(new URL("../src/agent-types.json", import.meta.url), "utf8"));
const type = types.find((t) => t.id === (flags.type ?? "custom"));
if (!type) die(`unknown --type '${flags.type}' (${types.map((t) => t.id).join(", ")})`);
const allow = flags.allow ?? "*"; // '*' = any agent in the workspace; '' = nobody
let allowed = "*";
if (allow !== "*") {
  const ids = allow.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.every((x) => ID_RE.test(x))) die(`bad --allow list: ${allow}`);
  allowed = JSON.stringify(ids);
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function rand(n) {
  let s = "";
  while (s.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALPHA[b % 62]; // unbiased
  return s;
}
const key = `bl_${rand(8)}_${rand(32)}`;
const hash = createHash("sha256").update(key).digest("hex");

const at = new Date().toISOString();
// Before migrate.mjs for v0.5 there is no type column: only --type custom (the default) can be honoured there.
const tc = runQuery("SELECT name FROM pragma_table_info('agents') WHERE name = 'type';", mode);
const hasType = Array.isArray(tc) && tc.at(-1)?.results?.length > 0;
if (!hasType && type.id !== "custom") die(`no agents.type column (${mode.slice(2)}): run scripts/migrate.mjs for v0.5 first`);
runSql(
  `INSERT INTO agents (workspace_id, id, name, key_hash, allowed_senders, doorbell_kind, created_at${hasType ? ", type" : ""})
   VALUES ('default', ${q(id)}, ${q(name)}, ${q(hash)}, ${q(allowed)}, 'none', ${q(at)}${hasType ? `, ${q(type.id)}` : ""});`,
  mode,
);
console.error(`agent '${id}' created (${mode.slice(2)}); type=${type.id}; allowed_senders=${allowed}. Recipe: ${type.recipe}; ` +
  `suggested doorbell: ${type.doorbell}. Key below is shown ONCE:`);
console.log(key);
// A new agent is set up from the current recipe, so every current changelog entry starts as read: its server.changes
// lists only what a later deploy adds. Before schema.sql for v0.3 there is no table, so nothing to record. This runs after the
// key is printed: if it fails, the agent and its key stand and the agent merely sees every entry once.
const { entries } = JSON.parse(readFileSync(new URL("../src/changelog.json", import.meta.url), "utf8"));
const t = runQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_seen';", mode);
if (Array.isArray(t) && t.at(-1)?.results?.length)
  runSql(`INSERT OR IGNORE INTO capability_seen (workspace_id, agent_id, rev, seen_at) VALUES
    ${entries.map((e) => `('default', ${q(id)}, ${Number(e.rev)}, ${q(at)})`).join(",\n    ")};`, mode);
else console.error("note: no capability_seen table (run schema.sql for v0.3): this agent's server.changes lists every entry");

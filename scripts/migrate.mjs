#!/usr/bin/env node
// Usage: node scripts/migrate.mjs [--check] [--local|--remote]
// --check changes nothing: it exits 1 and names what a deploy of this code would find missing.
// Brings an existing database up to schema.sql. SQLite has no ADD COLUMN IF NOT EXISTS, so this reads
// PRAGMA table_info and adds only the missing columns. Additive only; a no-op on a fresh schema.sql install.
// New TABLES and INDEXES come from re-running schema.sql (safe to re-run); this script names any that are still missing.
import { readFileSync } from "node:fs";
import { die, parseArgs, runQuery, runSql } from "./_d1.mjs";

const COLUMNS = {
  agents: { // v0.1 grace; v0.4 controllers; v0.5 type; v0.6 last_seen_at
    key_hash_prev: "TEXT", prev_valid_until: "TEXT", controllers: "TEXT NOT NULL DEFAULT '[]'", type: "TEXT NOT NULL DEFAULT 'custom'",
    last_seen_at: "TEXT",
  },
  messages: { reply_to: "TEXT" }, // v0.6: the message this one answers
  rings: {
    fail_count: "INTEGER NOT NULL DEFAULT 0", // v0.1: doorbell backoff + dead-letter
    busy_count: "INTEGER NOT NULL DEFAULT 0", rering_at: "TEXT", rering_gen: "TEXT", rering_hour: "TEXT", // v0.4: busy and
    rering_count: "INTEGER NOT NULL DEFAULT 0", //                                                            re-rings
  },
  ring_log: { detail: "TEXT" }, // v0.1: the reason on error / failed / timeout rows
  receipts: { trust_at_send: "TEXT" }, // v0.4: the recipient's trust in the sender at send time
  workspaces: { delegation: "INTEGER NOT NULL DEFAULT 0" }, // v0.4: the owner's delegation switch (table from v0.3 schema.sql)
};

const argv = process.argv.slice(2), check = argv.includes("--check");
const { pos, mode } = parseArgs(argv.filter((a) => a !== "--check"));
if (pos.length) die("usage: migrate.mjs [--check] [--local|--remote]");
const add = [];
for (const [table, cols] of Object.entries(COLUMNS)) {
  const out = runQuery(`PRAGMA table_info(${table});`, mode);
  const have = Array.isArray(out) ? out.at(-1)?.results?.map((c) => c.name) : undefined;
  if (!have?.length) {
    if (check) continue; // named below, with everything else that is missing
    die(`table ${table} not found (${mode.slice(2)}): apply schema.sql first`);
  }
  for (const [col, type] of Object.entries(cols))
    if (!have.includes(col)) add.push(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
}
if (check) {
  if (add.length) { console.error(`missing column(s) (${mode.slice(2)}):\n${add.join("\n")}\nrun: node scripts/migrate.mjs ${mode}`); process.exitCode = 1; }
  else console.error(`columns up to date (${mode.slice(2)})`);
} else {
  if (add.length) runSql(add.join("\n"), mode);
  console.error(add.length ? `applied (${mode.slice(2)}):\n${add.join("\n")}` : `columns up to date (${mode.slice(2)})`);
}

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const named = (re) => [...schema.matchAll(re)].map((m) => m[1]);
const objects = runQuery("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index');", mode);
const rows = Array.isArray(objects) ? objects.at(-1)?.results ?? [] : [];
const have = (type) => rows.filter((r) => r.type === type).map((r) => r.name);
const missing = [
  ...named(/CREATE TABLE IF NOT EXISTS (\w+)/g).filter((t) => !have("table").includes(t)).map((t) => `table ${t}`),
  ...named(/CREATE INDEX IF NOT EXISTS (\w+)/g).filter((i) => !have("index").includes(i)).map((i) => `index ${i}`),
];
if (missing.length) {
  console.error(`missing: ${missing.join(", ")} -- run: npx wrangler d1 execute <db> ${mode} --file schema.sql (safe to re-run)`);
  process.exitCode = 1; // a Worker deployed now would fail on those tables, or scan without those indexes
}

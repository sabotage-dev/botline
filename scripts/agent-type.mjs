#!/usr/bin/env node
// Usage (v0.5 agent types, docs/plan-v0.5.md P1):
//   node scripts/agent-type.mjs show                     [--local|--remote]
//   node scripts/agent-type.mjs <agent> <type>           [--local|--remote]
// The runtime an agent runs on (src/agent-types.json): what me and agents_list show beside its id and name. A label
// only: nothing on the server decides anything from it, so changing it changes no trust, grant or doorbell. Only this
// script and agent-add.mjs --type write it. Logged in agent_events (scripts/activity.mjs).
import { readFileSync } from "node:fs";
import { ID_RE, die, logEvent, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [a1, a2] = pos;
const USAGE = "usage: agent-type.mjs show | <agent> <type>  [--local|--remote]";
const rows = (sql) => { const out = runQuery(sql, mode); return Array.isArray(out) ? out.at(-1)?.results ?? [] : []; };
const { types } = JSON.parse(readFileSync(new URL("../src/agent-types.json", import.meta.url), "utf8"));

if (!rows("SELECT name FROM pragma_table_info('agents') WHERE name = 'type';").length)
  die(`no agents.type column (${mode.slice(2)}): run scripts/migrate.mjs for v0.5 first`);

function show() {
  console.log(`agent types (workspace default, ${mode.slice(2)} database):`);
  console.log("| agent | name | type | doorbell |");
  console.log("|---|---|---|---|");
  for (const r of rows("SELECT id, name, type, doorbell_kind FROM agents WHERE workspace_id = 'default' ORDER BY id;"))
    console.log(`| ${r.id} | ${r.name} | ${r.type} | ${r.doorbell_kind} |`);
}

if (a1 === "show" && !a2) show();
else if (a1 && a2 && pos.length === 2) {
  if (!ID_RE.test(a1)) die(`bad agent id: ${a1}`);
  if (!types.some((t) => t.id === a2)) die(`unknown type '${a2}' (${types.map((t) => t.id).join(", ")})`);
  if (!rows(`SELECT id FROM agents WHERE workspace_id = 'default' AND id = ${q(a1)};`).length) die(`no agent '${a1}' (${mode.slice(2)})`);
  runSql(`UPDATE agents SET type = ${q(a2)} WHERE workspace_id = 'default' AND id = ${q(a1)};`, mode);
  logEvent(a1, "type", a2, mode);
  show();
} else die(USAGE);

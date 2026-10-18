#!/usr/bin/env node
// Usage (v0.4 delegation, docs/plan-delegation-v0.4.md P1):
//   node scripts/agent-trust.mjs show                                  [--local|--remote]
//   node scripts/agent-trust.mjs delegation on|off                     [--local|--remote]
//   node scripts/agent-trust.mjs controllers <agent> <a,b,...|none>    [--local|--remote]
// The owner's switch and lists: with delegation on, a message from one of <agent>'s controllers is marked
// trust: "controller" for <agent> (a task from the owner); every other message stays "peer" (data). Delegation is off by
// default. Only this script writes them; it always prints the result. Logged in agent_events (scripts/activity.mjs).
import { ID_RE, die, logEvent, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [cmd, a1, a2] = pos;
const USAGE = "usage: agent-trust.mjs show | delegation on|off | controllers <agent> <a,b,...|none>  [--local|--remote]";
const rows = (sql) => { const out = runQuery(sql, mode); return Array.isArray(out) ? out.at(-1)?.results ?? [] : []; };

function show() {
  const ws = rows("SELECT * FROM workspaces WHERE id = 'default';")[0];
  console.log(`delegation (workspace default, ${mode.slice(2)} database): ${ws?.delegation === 1 ? "ON" : "off"}`);
  console.log("| agent | controllers (their messages are tasks for this agent) |");
  console.log("|---|---|");
  for (const r of rows("SELECT id, controllers FROM agents WHERE workspace_id = 'default' ORDER BY id;"))
    console.log(`| ${r.id} | ${(() => { try { const v = JSON.parse(r.controllers ?? "[]"); return Array.isArray(v) && v.length ? v.join(", ") : "-"; } catch { return `(malformed: ${String(r.controllers).slice(0, 40)}, reads as none)`; } })()} |`);
  console.error(
    "\nA controller must never run the relay rule (docs/recipes/relay.md) or any mechanical forward: a relayed copy is\n" +
    "marked with the RELAYER's trust, so a controller that relays turns any agent's text into a task.",
  );
}

if (cmd === "show" && !a1) show();
else if (cmd === "delegation" && (a1 === "on" || a1 === "off") && !a2) {
  if (!rows("SELECT name FROM pragma_table_info('workspaces') WHERE name = 'delegation';").length)
    die(`no workspaces.delegation column (${mode.slice(2)}): run schema.sql and scripts/migrate.mjs for v0.4 first`);
  runSql(`UPDATE workspaces SET delegation = ${a1 === "on" ? 1 : 0} WHERE id = 'default';`, mode);
  logEvent("*", "delegation", a1, mode);
  show();
} else if (cmd === "controllers" && a1 && a2) {
  if (!ID_RE.test(a1)) die(`bad agent id: ${a1}`);
  const ids = a2 === "none" ? [] : [...new Set(a2.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.every((x) => ID_RE.test(x))) die(`bad controller list: ${a2}`);
  if (ids.includes(a1)) die("an agent cannot be its own controller");
  const known = new Set(rows("SELECT id FROM agents WHERE workspace_id = 'default';").map((r) => r.id));
  if (!known.has(a1)) die(`no agent '${a1}' (${mode.slice(2)})`);
  const unknown = ids.filter((x) => !known.has(x));
  if (unknown.length) die(`unknown agent(s): ${unknown.join(", ")}`);
  if (!rows("SELECT name FROM pragma_table_info('agents') WHERE name = 'controllers';").length)
    die(`no agents.controllers column (${mode.slice(2)}): run schema.sql and scripts/migrate.mjs for v0.4 first`);
  runSql(`UPDATE agents SET controllers = ${q(JSON.stringify(ids))} WHERE workspace_id = 'default' AND id = ${q(a1)};`, mode);
  logEvent(a1, "controllers", JSON.stringify(ids), mode);
  show();
} else die(USAGE);

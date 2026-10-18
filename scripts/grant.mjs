#!/usr/bin/env node
// Usage (v0.4 per-agent grants, docs/plan-delegation-v0.4.md P4):
//   node scripts/grant.mjs show                                  [--local|--remote]
//   node scripts/grant.mjs grant|revoke <agent|all> <capability> [--local|--remote]
// An optional capability (src/changelog.json, e.g. files) is usable by an agent only when the deployment has it, the
// workspace has it on, AND it is granted here. Default: not granted. Only this script writes grants (no API, no
// controller can grant). `all` = every agent in the workspace now; agents added later start without grants.
// Logged in agent_events (scripts/activity.mjs).
import { readFileSync } from "node:fs";
import { ID_RE, die, hasTable, logEvent, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [cmd, who, cap] = pos;
const USAGE = "usage: grant.mjs show | grant|revoke <agent|all> <capability>  [--local|--remote]";
const rows = (sql) => { const out = runQuery(sql, mode); return Array.isArray(out) ? out.at(-1)?.results ?? [] : []; };
const { capabilities } = JSON.parse(readFileSync(new URL("../src/changelog.json", import.meta.url), "utf8"));
const optional = capabilities.filter((c) => !c.core).map((c) => c.id);

function show() {
  console.log(`grants (workspace default, ${mode.slice(2)} database):`);
  const agents = rows("SELECT id FROM agents WHERE workspace_id = 'default' ORDER BY id;").map((r) => r.id);
  const g = rows("SELECT agent_id, capability, granted FROM agent_capabilities WHERE workspace_id = 'default';");
  console.log(`| agent | ${optional.join(" | ")} |`);
  console.log(`|---|${optional.map(() => "---|").join("")}`);
  for (const id of agents)
    console.log(`| ${id} | ${optional.map((c) => (g.some((r) => r.agent_id === id && r.capability === c && r.granted === 1) ? "granted" : "-")).join(" | ")} |`);
}

if (!hasTable("agent_capabilities", mode)) die(`no agent_capabilities table (${mode.slice(2)}): run schema.sql for v0.4 first`);
if (cmd === "show" && !who) show();
else if ((cmd === "grant" || cmd === "revoke") && who && cap) {
  if (!optional.includes(cap)) die(`'${cap}' is not an optional capability (${optional.join(", ") || "none"}); core capabilities need no grant`);
  const known = rows("SELECT id FROM agents WHERE workspace_id = 'default';").map((r) => r.id);
  const ids = who === "all" ? known : [who];
  if (who !== "all" && (!ID_RE.test(who) || !known.includes(who))) die(`no agent '${who}' (${mode.slice(2)})`);
  const at = new Date().toISOString(), v = cmd === "grant" ? 1 : 0;
  if (ids.length)
    runSql(`INSERT INTO agent_capabilities (workspace_id, agent_id, capability, granted, updated_at) VALUES
      ${ids.map((id) => `('default', ${q(id)}, ${q(cap)}, ${v}, ${q(at)})`).join(",\n      ")}
      ON CONFLICT (workspace_id, agent_id, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at;`, mode);
  for (const id of ids) logEvent(id, cmd, cap, mode);
  show();
} else die(USAGE);

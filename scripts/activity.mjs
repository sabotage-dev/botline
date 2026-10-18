#!/usr/bin/env node
// Usage: node scripts/activity.mjs [--since 2h|30m|2d|<ISO>] [--agent <id>] [--limit N] [--bodies] [--local|--remote]
// Read-only owner view (v0.4, docs/plan-delegation-v0.4.md P8): what the agents did. Messages (from -> to, needs, each
// recipient's trust at send and now, receipts), each doorbell's state (lease, backoff, busy, dead, a pending re-ring),
// trust / grant / key events, and the ring log. Selects explicit columns: never a key hash or a doorbell secret.
// Subjects and bodies only with --bodies, inside the untrusted-content wrapper (they are other agents' words).
import { die, hasTable, parseArgs, q, runQuery } from "./_d1.mjs";

const argv = process.argv.slice(2);
const bodies = argv.includes("--bodies");
const { pos, flags, mode } = parseArgs(argv.filter((a) => a !== "--bodies"), ["since", "agent", "limit"]);
if (pos.length) die("usage: activity.mjs [--since 2h|30m|2d|<ISO>] [--agent <id>] [--limit N] [--bodies] [--local|--remote]");
const rel = /^(\d+)([mhd])$/.exec(flags.since ?? "24h");
const since = rel ? new Date(Date.now() - +rel[1] * { m: 60e3, h: 3600e3, d: 86400e3 }[rel[2]]).toISOString()
  : isNaN(Date.parse(flags.since)) ? die(`bad --since: ${flags.since}`) : new Date(flags.since).toISOString();
const limit = Math.min(Math.max(parseInt(flags.limit ?? "50", 10) || 50, 1), 500);
const agent = flags.agent ?? null;
const rows = (sql) => { const out = runQuery(sql, mode); return Array.isArray(out) ? out.at(-1)?.results ?? [] : []; };
const t = (s) => (s ? String(s).slice(5, 19).replace("T", " ") : "-");
const wrapped = (from, id, field, text) =>
  `<untrusted-content from="${from}" id="${id}" field="${field}">${String(text ?? "").replace(/<(\/?untrusted-content)/gi, "&lt;$1").replace(/\s+/g, " ").slice(0, 400)}</untrusted-content>`;

// current trust: delegation on AND the sender is on the recipient's list now
const deleg = rows("SELECT * FROM workspaces WHERE id = 'default';")[0]?.delegation === 1;
const agents = rows("SELECT * FROM pragma_table_info('agents');").some((c) => c.name === "controllers")
  ? rows("SELECT id, doorbell_kind, controllers FROM agents WHERE workspace_id = 'default' ORDER BY id;")
  : rows("SELECT id, doorbell_kind FROM agents WHERE workspace_id = 'default' ORDER BY id;");
const ctl = new Map(agents.map((a) => { try { const v = JSON.parse(a.controllers ?? "[]"); return [a.id, Array.isArray(v) ? v : []]; } catch { return [a.id, []]; } }));

console.log(`# botline activity since ${since} (${mode.slice(2)})${agent ? `, agent ${agent}` : ""}; delegation ${deleg ? "ON" : "off"}\n`);

console.log("## Messages\n");
const who = agent ? `AND (m.from_agent = ${q(agent)} OR r.agent = ${q(agent)})` : "";
const msgs = rows(`SELECT m.id, m.created_at, m.from_agent, m.thread_id, m.hop_count, m.needs${bodies ? ", m.subject, m.body" : ""}, r.*
  FROM messages m JOIN receipts r ON r.workspace_id = m.workspace_id AND r.message_id = m.id
  WHERE m.workspace_id = 'default' AND m.created_at > ${q(since)} ${who} ORDER BY m.created_at DESC, m.id LIMIT ${limit * 5};`);
const byMsg = new Map();
for (const r of msgs) {
  if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, { ...r, rcpts: [] });
  byMsg.get(r.message_id).rcpts.push(r);
}
console.log("| sent | from -> to | hop | needs | recipient: trust at send / now, delivered, read, acked | id |");
console.log("|---|---|---|---|---|---|");
for (const m of [...byMsg.values()].slice(0, limit).reverse()) {
  const rc = m.rcpts.map((r) => {
    const now = deleg && (ctl.get(r.agent) ?? []).includes(m.from_agent) && r.trust_at_send === "controller" ? "controller" : "peer";
    return `${r.agent}: ${r.trust_at_send === "controller" ? "controller" : "peer"}/${now}, ${t(r.delivered_at)}, ${t(r.read_at)}, ${t(r.acked_at)}`;
  }).join("; ");
  console.log(`| ${t(m.created_at)} | ${m.from_agent} -> ${m.rcpts.map((r) => r.agent).join(",")} | ${m.hop_count} | ${m.needs} | ${rc} | ${m.message_id} |`);
  if (bodies) {
    console.log(`|  | ${wrapped(m.from_agent, m.message_id, "subject", m.subject)} |  |  |  |  |`);
    console.log(`|  | ${wrapped(m.from_agent, m.message_id, "body", m.body)} |  |  |  |  |`);
  }
}

console.log("\n## Doorbells\n");
const rings = rows("SELECT * FROM rings WHERE workspace_id = 'default';");
const nowIso = new Date().toISOString();
console.log("| agent | kind | state | fail | busy | lease until | re-ring due | last |");
console.log("|---|---|---|---|---|---|---|---|");
for (const a of agents) {
  if (agent && a.id !== agent) continue;
  const r = rings.find((x) => x.agent === a.id) ?? {};
  const live = !r.in_flight_since && r.lease_until && r.lease_until > nowIso;
  const state = (r.fail_count ?? 0) >= 5 ? "dead" : r.in_flight_since && r.lease_until > nowIso ? "ringing"
    : live && (r.fail_count ?? 0) > 0 ? "backoff" : live && (r.busy_count ?? 0) > 0 ? "busy" : "ok";
  console.log(`| ${a.id} | ${a.doorbell_kind} | ${state} | ${r.fail_count ?? 0} | ${r.busy_count ?? 0} | ${t(r.lease_until)} | ${t(r.rering_at)} | ${r.last_status ?? "-"} ${t(r.last_at)} |`);
}

console.log("\n## Events (trust, grants, keys)\n");
if (hasTable("agent_events", mode)) {
  const ev = rows(`SELECT at, agent_id, kind, detail FROM agent_events WHERE workspace_id = 'default' AND at > ${q(since)}
    ${agent ? `AND agent_id = ${q(agent)}` : ""} ORDER BY id DESC LIMIT ${limit};`);
  if (!ev.length) console.log("(none)");
  for (const e of ev.reverse()) console.log(`- ${t(e.at)} ${e.agent_id} ${e.kind}: ${e.detail ?? ""}`);
} else console.log("(no agent_events table: run schema.sql for v0.4)");

console.log("\n## Ring log\n");
const rl = rows(`SELECT at, agent, kind, status, http_status, detail FROM ring_log WHERE workspace_id = 'default' AND at > ${q(since)}
  ${agent ? `AND agent = ${q(agent)}` : ""} ORDER BY id DESC LIMIT ${limit};`);
if (!rl.length) console.log("(none)");
for (const r of rl.reverse()) console.log(`- ${t(r.at)} ${r.agent} ${r.status}${r.http_status ? ` ${r.http_status}` : ""}${r.detail ? ` (${r.detail})` : ""}`);

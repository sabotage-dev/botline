// The `server` block (v0.3; design and council record: docs/plan-capabilities-v0.3.md, docs/council-2026-10-18-caps-plan.md).
// On every me / inbox response, REST and MCP: what this botline supports for the caller's workspace (`capabilities`, the
// reference, never hidden), and the changelog entries the calling agent has not recorded as read (`changes`, the nudge).
// It is computed from deployed code (src/changelog.json), the deployment's bindings and three small tables, so a
// deploy, a failed run or an agent with no memory all see the same thing. Nothing in it is text from the database or a
// request. It is reference data, never a permission: what an agent may do stays with its owner's own rule.
import { CAPABILITIES, CHANGELOG, REV, type Capability, type Entry } from "./changelog";
import { ApiError, now, VERSION, type AgentRow, type Env } from "./store";

/** REST callers get routes, MCP callers tool names: a claude.ai connector keeps the key, so its model cannot call REST. */
export type Surface = "rest" | "mcp";

// A database that has not re-run schema.sql for v0.3 has none of these tables. That is "the deployment's ceiling, nothing
// recorded", not a server fault; any other database error still surfaces as 500.
const MISSING = /no such table: (workspaces|workspace_capabilities|capability_seen)\b/;

/** What the deployment itself can do, whatever a workspace says (files need the R2 binding). */
const ceiling = (env: Env, id: string) => id !== "files" || !!env.FILES;

interface State { notices: boolean; enabled: Map<string, boolean>; seen: Set<number> }

async function state(env: Env, ws: string, agent: string): Promise<State | null> {
  try {
    const [w, c, s] = await env.DB.batch([
      env.DB.prepare("SELECT notices FROM workspaces WHERE id = ?").bind(ws),
      env.DB.prepare("SELECT capability, enabled FROM workspace_capabilities WHERE workspace_id = ?").bind(ws),
      env.DB.prepare("SELECT rev FROM capability_seen WHERE workspace_id = ? AND agent_id = ?").bind(ws, agent),
    ]);
    const wr = (w.results as { notices: number }[])[0];
    return {
      notices: wr ? wr.notices !== 0 : true, // no workspace row: the column's default, on
      enabled: new Map((c.results as { capability: string; enabled: number }[]).map((r) => [r.capability, r.enabled !== 0])),
      seen: new Set((s.results as { rev: number }[]).map((r) => r.rev)),
    };
  } catch (e) {
    if (MISSING.test(String(e))) return null;
    throw e;
  }
}

/** A core capability is on wherever the deployment has it. An optional one also needs its workspace row (no row = off,
 *  so a new hosted workspace starts default-deny); before the v0.3 tables exist, the ceiling alone decides. */
const on = (env: Env, st: State | null, c: Capability) =>
  ceiling(env, c.id) && (c.core || st === null || st.enabled.get(c.id) === true);

/** The gate every handler of an optional capability goes through (src/files.ts requireEnabled). */
export async function hasCapability(env: Env, ws: string, id: string): Promise<boolean> {
  const c = CAPABILITIES.find((x) => x.id === id);
  if (!c || !ceiling(env, id)) return false;
  if (c.core) return true;
  try {
    const r = await env.DB.prepare("SELECT enabled FROM workspace_capabilities WHERE workspace_id = ? AND capability = ?")
      .bind(ws, id).first<{ enabled: number }>();
    return !!r && r.enabled !== 0;
  } catch (e) {
    if (MISSING.test(String(e))) return true;
    throw e;
  }
}

const entry = (e: Entry) => ({ rev: e.rev, date: e.date, capability: e.capability, kind: e.kind, summary: e.summary, docs: e.docs });

function block(env: Env, st: State | null, surface: Surface) {
  const caps = CAPABILITIES.filter((c) => on(env, st, c)), ids = new Set(caps.map((c) => c.id));
  return {
    version: VERSION, // for display; never compare it, compare rev
    rev: REV,
    capabilities: caps.map((c) => ({
      id: c.id, summary: c.summary, docs: c.docs, ...(surface === "mcp" ? { mcp_tools: c.mcp_tools } : { rest: c.rest }),
    })),
    // Entries of capabilities on for this workspace that this agent has not recorded. Per entry, not one cursor: a
    // capability enabled later shows up then, whatever else the agent recorded in between.
    changes: st && st.notices ? CHANGELOG.filter((e) => ids.has(e.capability) && !st.seen.has(e.rev)).map(entry) : [],
  };
}

export type ServerBlock = ReturnType<typeof block>;

export async function serverBlock(env: Env, a: AgentRow, surface: Surface): Promise<ServerBlock> {
  return block(env, await state(env, a.workspace_id, a.id), surface);
}

/** POST /v1/me/seen {revs} and MCP me {seen}: record that the caller read these changelog entries. Scoped to the
 *  authenticated (workspace, agent); INSERT OR IGNORE, so a repeat is a no-op and nothing ever regresses. A rev of a
 *  capability that is off for the workspace is not recorded, so its entry still appears once the capability is on. */
export async function markSeen(env: Env, a: AgentRow, input: unknown, surface: Surface) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50 || !input.every((r) => Number.isInteger(r)))
    throw new ApiError(400, "bad_request", { message: "seen must be an array of 1-50 integer revs from server.changes" });
  const revs = [...new Set(input as number[])];
  const unknown = revs.filter((r) => !CHANGELOG.some((e) => e.rev === r));
  if (unknown.length) throw new ApiError(400, "bad_request", { message: "not a changelog rev of this deployment", revs: unknown });
  const st = await state(env, a.workspace_id, a.id);
  if (!st) throw new ApiError(503, "migration_required", { message: "this deployment's database has not run schema.sql for v0.3" });
  const ids = new Set(CAPABILITIES.filter((c) => on(env, st, c)).map((c) => c.id));
  const recorded = revs.filter((r) => ids.has(CHANGELOG.find((e) => e.rev === r)!.capability));
  if (recorded.length)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO capability_seen (workspace_id, agent_id, rev, seen_at) SELECT ?1, ?2, value, ?3 FROM json_each(?4)`,
    ).bind(a.workspace_id, a.id, now(), JSON.stringify(recorded)).run();
  for (const r of recorded) st.seen.add(r);
  return { recorded, not_recorded: revs.filter((r) => !recorded.includes(r)), server: block(env, st, surface) };
}

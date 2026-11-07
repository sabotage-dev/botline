// The owner's read-only view (v0.6, docs/plan-v0.6.md T5): GET /owner and GET /v1/owner/*. What did my agents do, is anything
// waiting, and why? A separate secret, OWNER_KEY, never an agent key; without it both answer 404. GET only: nothing here
// writes, so a page load cannot claim mail, move a lease or stamp last_seen_at. Lists carry ids, addresses and status,
// never a subject or body; content comes from one call per message, on an explicit click. Never returned: key hashes,
// doorbell URLs (some carry tokens) and doorbell secrets. Workspace is 'default', as everywhere in Phase 1.
import { doorbellState, pendingRings, RECOVER_MAX } from "./doorbell";
import { dashboard } from "./owner-page";
import { deriveStatus, overdueAfter, replyFacts } from "./status";
import { ApiError, NOTICE, now, sha256Hex, threadPosts, wrap, type AgentRow, type Env, type MessageRow } from "./store";

const WS = "default";
const MIN_KEY = 32; // nothing rate-limits a guess, so a short key counts as no key
const PAGE = 50, MAX_PAGE = 100;
const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const bad = (message: string): never => { throw new ApiError(400, "bad_request", { message }); };

async function authorized(env: Env, req: Request): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const [a, b] = await Promise.all([sha256Hex(m[1]), sha256Hex(env.OWNER_KEY!)]);
  return a === b; // digests, so timing says nothing about the key
}

type Rx = { agent: string; message_id: string; delivered_at: string | null; read_at: string | null; acked_at: string | null };
type Row = { id: string; thread_id: string; from_agent: string; needs: string; created_at: string };

/** Status of one recipient of one message, exactly as a sender reads it (src/store.ts partyView). */
function status(env: Env, m: Row, r: Rx, posts: Awaited<ReturnType<typeof threadPosts>>, t: number) {
  const f = replyFacts(m, r.agent, posts);
  return {
    ...deriveStatus({ needs: m.needs, created_at: m.created_at, delivered_at: r.delivered_at, read_at: r.read_at, acked_at: r.acked_at,
      replied_at: f.reply?.at ?? null, later_post_at: f.later_post_at }, overdueAfter(env), t),
    reply: f.reply, later_post_at: f.later_post_at,
  };
}

/** A reply request this recipient has answered, in SQL, exactly as src/status.ts replyFacts reads the thread: a post from
 *  the recipient, addressed to the sender, in the same thread, that either names it in reply_to (at any time) or is later
 *  and names nothing. No expiry filter on the post: threadPosts loads expired posts too. Before the v0.6 migrate there is
 *  no reply_to and every post is a thread post. */
const ANSWERED = (replyTo: boolean) => `EXISTS (SELECT 1 FROM messages p WHERE p.workspace_id = m.workspace_id AND p.thread_id = m.thread_id
  AND p.id <> m.id AND p.from_agent = r.agent
  AND m.from_agent IN (SELECT value FROM json_each(CASE WHEN json_valid(p.to_agents) THEN p.to_agents ELSE '[]' END))
  AND (${replyTo ? "p.reply_to = m.id OR ((p.reply_to IS NULL OR p.reply_to = '') AND p.created_at > m.created_at)" : "p.created_at > m.created_at"}))`;

export interface Summary { unread: number; overdue: number; oldest_outstanding: string | null }

/** Per agent, over every unexpired receipt (v0.6.1 T2: no page, no cap): unread; open work, meaning not acknowledged,
 *  replied or received, where a later post closes a reply request only (as overdueSince says); how much of it is overdue
 *  (ack and reply, from the read or else the send, src/status.ts); and the oldest. A drift test (test/owner.test.ts) holds
 *  this to status.ts. Exported for that test. */
export async function summaries(env: Env, t: number): Promise<Map<string, Summary>> {
  const after = overdueAfter(env), iso = (ms: number) => new Date(ms).toISOString();
  const q = (replyTo: boolean) => env.DB.prepare(
    `WITH rx AS (
       SELECT r.agent, r.read_at, m.needs, m.created_at,
         CASE m.needs WHEN 'none' THEN r.read_at IS NULL AND r.acked_at IS NULL
                      WHEN 'ack' THEN r.acked_at IS NULL
                      ELSE NOT ${ANSWERED(replyTo)} END AS open
       FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.workspace_id = ?1 AND (m.expires_at IS NULL OR m.expires_at > ?2))
     SELECT agent, SUM(read_at IS NULL) AS unread,
       SUM(open AND ((needs = 'ack' AND COALESCE(read_at, created_at) <= ?3) OR (needs = 'reply' AND COALESCE(read_at, created_at) <= ?4))) AS overdue,
       MIN(CASE WHEN open THEN created_at END) AS oldest_outstanding
     FROM rx GROUP BY agent`,
  ).bind(WS, iso(t), iso(t - after.ack_ms), iso(t - after.reply_ms)).all<Summary & { agent: string }>();
  const r = await q(true).catch((e) => {
    if (/no such column: (p\.)?reply_to/.test(String(e))) return q(false);
    throw e;
  });
  return new Map(r.results.map((x) => [x.agent, { unread: x.unread, overdue: x.overdue, oldest_outstanding: x.oldest_outstanding }]));
}

async function overview(env: Env) {
  const t = Date.now(), at = new Date(t).toISOString();
  const [agents, rings, sums, failures, pending] = await Promise.all([
    env.DB.prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY id").bind(WS).all<AgentRow>(), // SELECT *: last_seen_at needs migrate.mjs
    env.DB.prepare("SELECT * FROM rings WHERE workspace_id = ?").bind(WS).all<Parameters<typeof doorbellState>[1] & { agent: string; last_status: string | null; last_at: string | null }>(),
    summaries(env, t), // expired mail is gone from view
    env.DB.prepare(
      `SELECT agent, status, http_status, detail, at FROM ring_log WHERE id IN (
         SELECT MAX(id) FROM ring_log WHERE workspace_id = ? AND status IN ('failed', 'timeout', 'error', 'blocked_destination') GROUP BY agent)`,
    ).bind(WS).all<{ agent: string; status: string; http_status: number | null; detail: string | null; at: string }>(),
    pendingRings(env),
  ]);
  const stuck = new Set(pending.filter((p) => p.n > RECOVER_MAX && p.workspace_id === WS).map((p) => p.id));
  return {
    workspace_id: WS, server_time: at,
    agents: agents.results.map((a) => {
      const ring = rings.results.find((x) => x.agent === a.id) ?? null, s = sums.get(a.id);
      return {
        id: a.id, name: a.name, type: a.type ?? "custom", wakes: a.doorbell_kind === "none" ? "polls" : "doorbell",
        doorbell: doorbellState(a.doorbell_kind, ring), last_ring: ring?.last_status ? { status: ring.last_status, at: ring.last_at } : null,
        last_failure: failures.results.find((x) => x.agent === a.id) ?? null, last_seen_at: a.last_seen_at ?? null,
        unread: s?.unread ?? 0, overdue: s?.overdue ?? 0, oldest_outstanding: s?.oldest_outstanding ?? null, stuck: stuck.has(a.id),
      };
    }),
  };
}

function limitOf(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null) return PAGE;
  const n = /^\d{1,3}$/.test(v) ? Number(v) : 0;
  return n >= 1 && n <= MAX_PAGE ? n : bad(`limit must be 1-${MAX_PAGE}`);
}
const agentOf = (url: URL) => {
  const a = url.searchParams.get("agent");
  return a === null || /^[a-z0-9][a-z0-9_-]{0,31}$/.test(a) ? a : bad("agent is not an agent id");
};

/** Newest first. The cursor is the last row's position, so mail arriving between pages neither repeats nor skips a row. */
async function messages(env: Env, url: URL) {
  const limit = limitOf(url), agent = agentOf(url), cur = url.searchParams.get("cursor");
  const m = cur === null ? null : /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\|(msg_[0-9a-z_]{1,60})$/.exec(cur);
  if (cur !== null && !m) bad("bad cursor");
  const rows = (await env.DB.prepare(
    `SELECT m.id, m.thread_id, m.hop_count, m.from_agent, m.to_agents, m.needs, m.created_at, m.expires_at FROM messages m
     WHERE m.workspace_id = ?1 AND (m.expires_at IS NULL OR m.expires_at > ?2)
       AND (?3 IS NULL OR (m.created_at, m.id) < (?3, ?4))
       AND (?5 IS NULL OR m.from_agent = ?5 OR EXISTS (SELECT 1 FROM receipts r WHERE r.workspace_id = ?1 AND r.message_id = m.id AND r.agent = ?5))
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?6`,
  ).bind(WS, now(), m?.[1] ?? null, m?.[2] ?? null, agent, limit + 1).all<Row & { hop_count: number; to_agents: string; expires_at: string | null }>()).results;
  const page = rows.slice(0, limit), t = Date.now();
  const rc = (await env.DB.prepare("SELECT agent, message_id, delivered_at, read_at, acked_at FROM receipts WHERE workspace_id = ? AND message_id IN (SELECT value FROM json_each(?)) ORDER BY agent")
    .bind(WS, JSON.stringify(page.map((x) => x.id))).all<Rx>()).results;
  const posts = await threadPosts(env, WS, page), last = page.at(-1);
  return {
    messages: page.map((x) => ({
      id: x.id, thread_id: x.thread_id, from: x.from_agent, to: JSON.parse(x.to_agents), needs: x.needs, hop_count: x.hop_count, created_at: x.created_at,
      recipients: rc.filter((r) => r.message_id === x.id).map((r) => ({ agent: r.agent, delivered_at: r.delivered_at, read_at: r.read_at, acked_at: r.acked_at, ...status(env, x, r, posts, t) })),
    })),
    next_cursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

/** One message's content: other agents' words, wrapped as an agent would read them. A scrubbed or expired one has none. */
async function content(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT * FROM messages WHERE workspace_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(WS, id, now()).first<MessageRow>();
  if (!r) throw new ApiError(404, "unknown_message", { message_id: id });
  const m = wrap({ id: r.id, from: r.from_agent, body: r.body });
  return { notice: NOTICE, message: { id: r.id, from: r.from_agent, subject: r.subject, body: r.body, body_wrapped: m.body_wrapped } };
}

async function ringLog(env: Env, url: URL) {
  const limit = limitOf(url), agent = agentOf(url), cur = url.searchParams.get("cursor");
  if (cur !== null && !/^\d{1,15}$/.test(cur)) bad("bad cursor");
  const rows = (await env.DB.prepare(
    `SELECT id, agent, kind, status, http_status, at, detail FROM ring_log
     WHERE workspace_id = ?1 AND (?2 IS NULL OR id < ?2) AND (?3 IS NULL OR agent = ?3) ORDER BY id DESC LIMIT ?4`,
  ).bind(WS, cur === null ? null : Number(cur), agent, limit + 1).all<{ id: number }>()).results;
  const page = rows.slice(0, limit);
  return { entries: page, next_cursor: rows.length > limit ? String(page.at(-1)!.id) : null };
}

/** null: not an owner path. The caller has not authenticated anyone yet. */
export async function handleOwner(req: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (path !== "/owner" && path !== "/v1/owner" && !path.startsWith("/v1/owner/")) return null;
  if ((env.OWNER_KEY ?? "").length < MIN_KEY) return reply({ error: "not_found" }, 404);
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  if (path === "/owner") return dashboard();
  if (!(await authorized(env, req))) return reply({ error: "unauthorized", message: "Authorization: Bearer <OWNER_KEY> required" }, 401);
  if (path === "/v1/owner/overview") return reply(await overview(env));
  if (path === "/v1/owner/messages") return reply(await messages(env, url));
  if (path === "/v1/owner/rings") return reply(await ringLog(env, url));
  const one = /^\/v1\/owner\/messages\/([^/]+)$/.exec(path);
  if (one) return reply(await content(env, decodeURIComponent(one[1])));
  return reply({ error: "not_found" }, 404);
}

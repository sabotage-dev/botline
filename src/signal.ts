// The watch URL (v0.5, docs/plan-v0.5.md P2): GET /v1/signal?token=sig_<32>, with NO key. It tells a script that cannot
// hold an agent's key (a Muse hook's detector) how much mail would ring that agent, and when the newest arrived:
// {unread, latest}. Nothing else: no ids, subjects, senders, workspace or agent id. It writes nothing (no claim, no lease,
// no ring). The token alone picks the agent; only its sha256 is stored (agent_signals), and only scripts/signal.mjs mints
// or revokes one. Every failure, including a database without the table, is the same 404.
import { RINGABLE_SQL } from "./doorbell";
import { controllersOf, delegationOn, now, sha256Hex, type AgentRow, type Env } from "./store";

const TOKEN_RE = /^sig_[A-Za-z0-9]{32}$/;
const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" };
const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const notFound = () => reply({ error: "not_found" }, 404);

export async function signal(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token || !TOKEN_RE.test(token)) return notFound();
  try {
    const a = await env.DB.prepare(
      `SELECT ag.* FROM agent_signals s JOIN agents ag ON ag.workspace_id = s.workspace_id AND ag.id = s.agent_id
       WHERE s.token_hash = ?`,
    ).bind(await sha256Hex(token)).first<AgentRow>();
    if (!a) return notFound();
    // The doorbell's own policy (RINGABLE_SQL): a peer loop past the hop ceiling does not wake a hooked agent at once.
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(m.created_at) AS latest FROM receipts r
       JOIN messages m ON m.workspace_id = r.workspace_id AND m.id = r.message_id
       WHERE r.workspace_id = ?1 AND r.agent = ?2 AND r.read_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?3)
         AND ${RINGABLE_SQL("?4", "?5")}`,
    ).bind(a.workspace_id, a.id, now(), (await delegationOn(env, a.workspace_id)) ? 1 : 0, JSON.stringify(controllersOf(a)))
      .first<{ n: number; latest: string | null }>();
    return reply({ unread: r?.n ?? 0, latest: r?.latest ?? null }, 200);
  } catch (e) {
    // Before schema.sql / migrate.mjs for v0.5 (no agent_signals) or v0.4 (no trust_at_send): no watch URL works.
    if (/no such (table|column)/.test(String(e))) return notFound();
    throw e;
  }
}

// Ring policy (plan §2 rule 6, §3B.3): hop ceiling, one in-flight ring per agent (lease), terminal on
// 2xx / non-2xx / timeout. Destination pin + secret decryption fail closed before any fetch.
// Backoff + dead-letter: a ring that ends failed / timeout / error turns the lease into a backoff lease, so no send
// rings the agent again until min(10 min x 2^(fail_count-1), 6 h) has passed; at DEAD_AT consecutive failures every
// ring is logged dead_letter without a fetch until scripts/doorbell-set.mjs resets fail_count. A 2xx resets it.
// v0.4 (docs/plan-delegation-v0.4.md P7), only with the optional RERING Queue (or ECHO_SECRET in tests):
//  - busy: an adapter that can tell (grokbot_webhook: 400 or timeout; generic_webhook: 409) refusing a ring while the
//    agent read mail in the last 10 minutes is mid-run, not broken. No fail_count; a busy lease (later sends coalesce);
//    a re-ring after 90 s, 3 min, 6 min; the 4th busy result is an ordinary failure.
//  - after an ordinary failure with mail waiting, a re-ring when the backoff ends (until dead-letter).
//  - every re-ring is a persisted token (rings.rering_gen); a queue message with another token is stale. At most
//    RERING_PER_HOUR automatic re-rings per agent per hour. A re-ring claims the lease like a send's ring.
// Core holds no vendor logic: adapters do (including which destinations they accept and what "busy" looks like).
import type { AgentRow, Env, Message } from "./store";
import { openSecret } from "./secrets";
import * as claude_fire from "./adapters/claude_fire";
import * as generic_webhook from "./adapters/generic_webhook";
import * as grokbot_webhook from "./adapters/grokbot_webhook";
import * as none from "./adapters/none";

export const HOP_CEILING = 8;
const LEASE_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MIN = 10;
export const BACKOFF_CAP_MIN = 6 * 60;
export const DEAD_AT = 5;
export const BUSY_DELAYS_S = [90, 180, 360];
const BUSY_WINDOW_MS = 10 * 60_000;
export const RERING_PER_HOUR = 6;

export interface RingPayload { agent: string; unread: number; message_ids: string[] }
export interface RingResult { status: "ok" | "failed" | "timeout" | "no_doorbell"; httpStatus?: number }
/** What an adapter rings: the URL and the decrypted secret (adapters never see the stored form). */
export interface Destination { url: string; secret: string | null }
export type Adapter = (dest: Destination, payload: RingPayload, signal: AbortSignal) => Promise<RingResult>;
interface AdapterModule { ring: Adapter; allows: (url: URL, env: Env) => boolean; busy?: (r: RingResult) => boolean }
/** A scheduled re-ring (the RERING Queue's message body). */
export interface RingJob { ws: string; agent: string; gen: string }

const ADAPTERS: Record<string, AdapterModule> = { claude_fire, grokbot_webhook, generic_webhook, none };

const iso = (ms: number) => new Date(ms).toISOString();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
/** Re-rings can be scheduled: a Queue to deliver them, or a test deployment that drives them through POST /v1/_rering. */
const canSchedule = (env: Env) => !!env.RERING || !!env.ECHO_SECRET;

/** `detail` is the reason on an error / failed / timeout row (no_master_key, decrypt_failed, http 401, timeout, …). Rows
 *  without one use the pre-`detail` column list, so a Worker deployed before migrate.mjs still logs every other outcome. */
function logStmt(env: Env, ws: string, agent: string, kind: string | null, status: string, ids: string[], http?: number, detail?: string) {
  const v = [ws, agent, kind, status, http ?? null, JSON.stringify(ids), iso(Date.now())];
  return detail
    ? env.DB.prepare("INSERT INTO ring_log (workspace_id, agent, kind, status, http_status, message_ids, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(...v, detail)
    : env.DB.prepare("INSERT INTO ring_log (workspace_id, agent, kind, status, http_status, message_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(...v);
}

/** Called via ctx.waitUntil after a send commits. Never throws. */
export async function ringRecipients(env: Env, msg: Message): Promise<void> {
  await Promise.all(
    msg.to.map((id) =>
      ringOne(env, msg, id).catch((e) => {
        console.error("ring error", id, e); // the exception itself stays in the Worker log, not in ring_log
        return logStmt(env, msg.workspace_id, id, null, "error", [msg.id], undefined, "exception").run().catch(() => undefined);
      }),
    ),
  );
}

async function ringOne(env: Env, msg: Message, agentId: string): Promise<void> {
  const ws = msg.workspace_id;
  const agent = await env.DB.prepare("SELECT * FROM agents WHERE workspace_id = ? AND id = ?")
    .bind(ws, agentId)
    .first<AgentRow>();
  if (!agent) return;
  const kind = agent.doorbell_kind;
  // 1. Hop ceiling: deliver, never ring.
  if (msg.hop_count > HOP_CEILING) return void (await logStmt(env, ws, agentId, kind, "hop_ceiling", [msg.id]).run());
  // 2. Poll-only agent.
  const adapter = ADAPTERS[kind];
  if (kind === "none" || !agent.doorbell_url || !adapter) return void (await logStmt(env, ws, agentId, kind, "no_doorbell", [msg.id]).run());
  await attempt(env, agent, adapter, [msg.id], false);
}

/** A scheduled re-ring (the RERING Queue consumer, or POST /v1/_rering in tests). It runs only if `gen` is still the
 *  agent's pending token, then rings exactly like a send's ring: same lease claim, guards, hop ceiling, backoff and
 *  dead-letter. The token is consumed only AFTER the attempt: if anything throws first, the token stays for the Queue's
 *  retry (a duplicate delivery coalesces on the lease). A newer token set during the attempt is left alone. */
export async function rering(env: Env, job: RingJob): Promise<"stale" | "no_doorbell" | "rang"> {
  const p = await env.DB.prepare("SELECT rering_gen FROM rings WHERE workspace_id = ? AND agent = ?")
    .bind(job.ws, job.agent).first<{ rering_gen: string | null }>();
  if (!p || p.rering_gen !== job.gen) return "stale";
  const consume = () => env.DB.prepare("UPDATE rings SET rering_at = NULL, rering_gen = NULL WHERE workspace_id = ? AND agent = ? AND rering_gen = ?")
    .bind(job.ws, job.agent, job.gen).run();
  const agent = await env.DB.prepare("SELECT * FROM agents WHERE workspace_id = ? AND id = ?").bind(job.ws, job.agent).first<AgentRow>();
  const adapter = agent ? ADAPTERS[agent.doorbell_kind] : undefined;
  if (!agent || agent.doorbell_kind === "none" || !agent.doorbell_url || !adapter) return void (await consume()), "no_doorbell";
  await attempt(env, agent, adapter, [], true);
  await consume();
  return "rang";
}

/** Persist a re-ring due in `delayS` seconds (a fresh token, inside the hourly cap) and hand it to the Queue. Without a
 *  Queue (tests) the token is only recorded, for POST /v1/_rering. Returns whether one is now pending. */
async function schedule(env: Env, ws: string, agent: string, kind: string | null, delayS: number, reason: string): Promise<boolean> {
  const gen = token(), hour = new Date().toISOString().slice(0, 13), delay = Math.min(Math.max(1, Math.round(delayS)), 86_400);
  let r: D1Result;
  try {
    r = await env.DB.prepare(
      `UPDATE rings SET rering_at = ?1, rering_gen = ?2,
         rering_count = CASE WHEN rering_hour = ?3 THEN rering_count + 1 ELSE 1 END, rering_hour = ?3
       WHERE workspace_id = ?4 AND agent = ?5 AND (rering_hour IS NULL OR rering_hour <> ?3 OR rering_count < ?6)`,
    ).bind(iso(Date.now() + delay * 1000), gen, hour, ws, agent, RERING_PER_HOUR).run();
  } catch (e) {
    if (/no such column: rering_/.test(String(e))) return false; // before migrate.mjs: no re-rings, as in v0.3
    throw e;
  }
  if (!r.meta.changes) return void (await logStmt(env, ws, agent, kind, "rering_capped", [], undefined, reason).run()), false;
  if (env.RERING) {
    try {
      await env.RERING.send({ ws, agent, gen } satisfies RingJob, { delaySeconds: delay });
    } catch (e) {
      console.error("rering enqueue", String(e).slice(0, 200));
      await env.DB.batch([
        env.DB.prepare("UPDATE rings SET rering_at = NULL, rering_gen = NULL WHERE workspace_id = ? AND agent = ? AND rering_gen = ?").bind(ws, agent, gen),
        logStmt(env, ws, agent, kind, "rering_failed", [], undefined, reason),
      ]);
      return false;
    }
  }
  return true;
}

async function readRecently(env: Env, ws: string, agent: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT MAX(read_at) AS t FROM receipts WHERE workspace_id = ? AND agent = ? AND read_at IS NOT NULL")
    .bind(ws, agent).first<{ t: string | null }>();
  return !!r?.t && Date.parse(r.t) > Date.now() - BUSY_WINDOW_MS;
}

/** Claim the agent's lease and ring it once: a send's ring (logIds = the new message) or a scheduled re-ring. */
async function attempt(env: Env, agent: AgentRow, adapter: AdapterModule, logIds: string[], isRering: boolean): Promise<void> {
  const ws = agent.workspace_id, agentId = agent.id, kind = agent.doorbell_kind;
  const log = (status: string, ids = logIds, http?: number, detail?: string) => logStmt(env, ws, agentId, kind, status, ids, http, detail);

  // 3. Coalesce: claim the lease atomically. RETURNING yields a row only if we inserted, or updated an
  //    expired/cleared lease of an agent that is not dead-lettered. Otherwise nothing is fetched, and the log says why:
  //    dead_letter (DEAD_AT failures), backoff (a failure's lease: no ring in flight) or coalesced (a ring in flight, or a
  //    busy lease whose re-ring will carry this mail). RETURNING * also gives fail_count / busy_count (absent before
  //    migrate.mjs).
  const t = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO rings (workspace_id, agent, in_flight_since, lease_until, last_status, last_at)
     VALUES (?1, ?2, ?3, ?4, 'ringing', ?3)
     ON CONFLICT (workspace_id, agent) DO UPDATE SET
       in_flight_since = excluded.in_flight_since, lease_until = excluded.lease_until,
       last_status = 'ringing', last_at = excluded.last_at
     WHERE (rings.lease_until IS NULL OR rings.lease_until <= ?3) AND rings.fail_count < ?5
     RETURNING *`,
  ).bind(ws, agentId, iso(t), iso(t + LEASE_MS), DEAD_AT).first<{ fail_count?: number; busy_count?: number }>();
  if (!claimed) {
    const s = await env.DB.prepare("SELECT in_flight_since, lease_until, fail_count FROM rings WHERE workspace_id = ? AND agent = ?")
      .bind(ws, agentId).first<{ in_flight_since: string | null; lease_until: string | null; fail_count: number }>();
    const why = !s ? "coalesced" : s.fail_count >= DEAD_AT ? "dead_letter" : s.fail_count > 0 && !s.in_flight_since ? "backoff" : "coalesced";
    // A re-ring that meets a live backoff or busy lease (no ring in flight) keeps the obligation: it is rescheduled for
    // when that lease ends (a Queue that delivers early loses nothing). A ring in flight already covers the mail.
    if (isRering && s && !s.in_flight_since && s.lease_until && s.fail_count < DEAD_AT && canSchedule(env))
      await schedule(env, ws, agentId, kind, Math.max(1, (Date.parse(s.lease_until) - Date.now()) / 1000 + 1), "reschedule");
    return void (await log(why).run());
  }

  // Anything that throws after the claim releases our lease (guarded by our stamp) before it propagates, so a retry or
  // the next send can ring instead of waiting out a lease nothing holds.
  try {
    await afterClaim(env, agent, adapter, logIds, isRering, t, claimed);
  } catch (e) {
    await env.DB.prepare("UPDATE rings SET in_flight_since = NULL, lease_until = NULL WHERE workspace_id = ? AND agent = ? AND in_flight_since = ?")
      .bind(ws, agentId, iso(t)).run().catch(() => undefined);
    throw e;
  }
}

async function afterClaim(
  env: Env, agent: AgentRow, adapter: AdapterModule, logIds: string[], isRering: boolean, t: number,
  claimed: { fail_count?: number; busy_count?: number },
): Promise<void> {
  const ws = agent.workspace_id, agentId = agent.id, kind = agent.doorbell_kind;
  const log = (status: string, ids = logIds, http?: number, detail?: string) => logStmt(env, ws, agentId, kind, status, ids, http, detail);
  // A re-ring rings only for mail inside the hop ceiling (a send's ring checked its own message above).
  const unread = await env.DB.prepare(
    `SELECT r.message_id AS id FROM receipts r JOIN messages m ON m.id = r.message_id
     WHERE r.workspace_id = ?1 AND r.agent = ?2 AND r.read_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?3) AND (?4 = 0 OR m.hop_count <= ?5)
     ORDER BY m.created_at LIMIT 100`,
  ).bind(ws, agentId, iso(t), isRering ? 1 : 0, HOP_CEILING).all<{ id: string }>();
  const ids = unread.results.map((r) => r.id);
  if (ids.length === 0) {
    // The agent drained between send and ring: release the lease, wake nobody. Every release below is guarded by
    // in_flight_since = this claim's stamp: an inbox poll may have cleared our lease and a newer ring may own a fresh
    // one, and an unguarded release would let a third ring start while that one is still in flight.
    await env.DB.batch([
      env.DB.prepare("UPDATE rings SET in_flight_since = NULL, lease_until = NULL WHERE workspace_id = ? AND agent = ? AND in_flight_since = ?").bind(ws, agentId, iso(t)),
      log("nothing_unread"),
    ]);
    return;
  }

  // A failed / timeout / error ring: count it and turn our lease into a backoff lease (no ring in flight, so
  // in_flight_since = NULL, which also keeps an inbox poll from lifting it). Guarded like every release: if an inbox
  // poll already cleared our lease and a newer ring owns a fresh one, this write must not touch it (the failure is then
  // not counted). SET expressions read the old row: backoff = min(BASE << old fail_count, CAP) minutes from now.
  // lastStatus goes to rings.last_status (as before); detail goes on this ring_log row, so the reason outlives the next ring.
  // v0.4: when it applied, mail is waiting and the agent is not dead yet, a re-ring is scheduled for when the backoff ends.
  const fail = async (status: string, lastStatus: string, detail: string, http?: number) => {
    const at = iso(Date.now());
    const [u] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE rings SET in_flight_since = NULL, fail_count = fail_count + 1, last_status = ?1, last_at = ?2,
           lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || min(?3 << min(fail_count, 20), ?4) || ' minutes')
         WHERE workspace_id = ?5 AND agent = ?6 AND in_flight_since = ?7`,
      ).bind(lastStatus, at, BACKOFF_BASE_MIN, BACKOFF_CAP_MIN, ws, agentId, iso(t)),
      log(status, ids, http, detail),
    ]);
    const old = claimed.fail_count ?? 0;
    if (u.meta.changes && old + 1 < DEAD_AT && canSchedule(env))
      await schedule(env, ws, agentId, kind, Math.min(BACKOFF_BASE_MIN << Math.min(old, 20), BACKOFF_CAP_MIN) * 60 + 1, "after_backoff");
  };

  // 4. Fail closed before any fetch. A destination the adapter does not accept: release the lease (fixing the URL or
  //    the allowlist lets the next send ring; nothing was fetched, so nothing backs off). A secret we cannot decrypt:
  //    an `error` ring, which backs off like a failed one. The reason goes to rings.last_status either way.
  let url: URL | null = null;
  try { url = new URL(agent.doorbell_url!); } catch { /* blocked below */ }
  if (!url || !adapter.allows(url, env)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE rings SET in_flight_since = NULL, lease_until = NULL, last_status = ?, last_at = ? WHERE workspace_id = ? AND agent = ? AND in_flight_since = ?")
        .bind("blocked_destination", iso(Date.now()), ws, agentId, iso(t)),
      log("blocked_destination", ids),
    ]);
    return;
  }
  const opened = await openSecret(agent.doorbell_secret, env.DOORBELL_MASTER_KEY, `${ws}/${agentId}`);
  if (!opened.ok) return void (await fail("error", opened.reason, opened.reason));

  // 5. Ring once with a 15 s timeout. On ok the lease stays until the agent drains or it expires, and fail_count (and
  //    busy_count) reset — but only if this ring still owns the row, or the row is idle (an inbox poll cleared our
  //    lease and nothing newer claimed). A newer ring's stamp, or a newer failure's backoff lease, must survive: a slow
  //    2xx from an older ring would otherwise erase a dead-letter state.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: RingResult;
  try {
    res = await adapter.ring({ url: url.toString(), secret: opened.secret }, { agent: agentId, unread: ids.length, message_ids: ids }, ac.signal);
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== "ok") {
    const detail = res.httpStatus ? `http ${res.httpStatus}` : res.status === "failed" ? "network_error" : res.status;
    // v0.4 busy: the endpoint is mid-run. Not a failure: a busy lease (guarded by our stamp, so a newer claim is never
    // touched) and a re-ring after the next delay. Without a way to schedule, or past the last delay: an ordinary failure.
    const busyCount = claimed.busy_count ?? 0;
    if (adapter.busy?.(res) && claimed.busy_count !== undefined && busyCount < BUSY_DELAYS_S.length && canSchedule(env)
        && (await readRecently(env, ws, agentId))) {
      const delay = BUSY_DELAYS_S[busyCount], at = iso(Date.now()), until = iso(Date.now() + delay * 1000);
      const [u] = await env.DB.batch([
        env.DB.prepare(
          `UPDATE rings SET in_flight_since = NULL, busy_count = busy_count + 1, last_status = 'busy', last_at = ?1, lease_until = ?2
           WHERE workspace_id = ?3 AND agent = ?4 AND in_flight_since = ?5`,
        ).bind(at, until, ws, agentId, iso(t)),
        log("busy", ids, res.httpStatus, detail),
      ]);
      // No re-ring possible (hourly cap, enqueue failure): drop our busy lease so the next send rings at once.
      if (u.meta.changes && !(await schedule(env, ws, agentId, kind, delay, "busy")))
        await env.DB.prepare("UPDATE rings SET lease_until = NULL WHERE workspace_id = ? AND agent = ? AND in_flight_since IS NULL AND lease_until = ?")
          .bind(ws, agentId, until).run();
      return;
    }
    return void (await fail(res.status, res.status, detail, res.httpStatus));
  }
  const at = iso(Date.now());
  const owned = "(in_flight_since = ?4 OR (in_flight_since IS NULL AND lease_until IS NULL))";
  await env.DB.batch([
    env.DB.prepare(`UPDATE rings SET last_status = 'ok', last_at = ?1, fail_count = 0 WHERE workspace_id = ?2 AND agent = ?3 AND ${owned}`)
      .bind(at, ws, agentId, iso(t)),
    // busy_count exists only after migrate.mjs: reset it in its own statement, and only when it is set.
    ...(claimed.busy_count ? [env.DB.prepare(
      "UPDATE rings SET busy_count = 0 WHERE workspace_id = ?1 AND agent = ?2 AND (in_flight_since = ?3 OR (in_flight_since IS NULL AND lease_until IS NULL))",
    ).bind(ws, agentId, iso(t))] : []),
    log(res.status, ids, res.httpStatus),
    env.DB.prepare(
      `UPDATE receipts SET delivered_at = ?1 WHERE workspace_id = ?2 AND agent = ?3 AND delivered_at IS NULL
       AND message_id IN (SELECT value FROM json_each(?4))`,
    ).bind(at, ws, agentId, JSON.stringify(ids)),
  ]);
}

/** The doorbell's health as `me` reports it. dead: DEAD_AT consecutive failures (doorbell-set resets). backoff: a
 *  failure's lease is live, so a send now is logged `backoff` and not rung before next_ring_after. ok: otherwise. */
export function doorbellState(
  kind: string,
  r: { in_flight_since?: string | null; lease_until?: string | null; fail_count?: number; busy_count?: number; rering_at?: string | null } | null,
) {
  const fail_count = r?.fail_count ?? 0;
  const live = !r?.in_flight_since && !!r?.lease_until && r.lease_until > iso(Date.now());
  const backoff = fail_count > 0 && fail_count < DEAD_AT && live;
  const busy = fail_count === 0 && (r?.busy_count ?? 0) > 0 && live; // v0.4: mid-run, a re-ring is pending
  const state = fail_count >= DEAD_AT ? "dead" : backoff ? "backoff" : busy ? "busy" : "ok";
  return { kind, state, fail_count, next_ring_after: backoff || busy ? r!.lease_until! : null, rering_at: r?.rering_at ?? null };
}

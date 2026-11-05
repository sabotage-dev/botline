// What the daily Cron Trigger keeps (v0.6, docs/plan-v0.6.md T4). An expired message is unreadable at once; this is what
// happens to the data afterwards. Bounded passes, safe to rerun, each table on its own.
//  - Messages: RETENTION_DAYS (default 7) after expires_at the content goes (subject, body, meta). The row and its receipts
//    stay: they hold the idempotency key (a retry must never send twice), thread membership and the hop count. What remains
//    says who sent what to whom and when, and no content. RETENTION_DAYS=off keeps the content.
//  - File rows and bytes are files.sweep's: access needs an unexpired message, so nothing here changes who can read a file.
//  - ring_log after 30 days, echo_hits after a day. agent_events is the audit trail: never deleted here.
import { now, type Env } from "./store";

const DAY_MS = 86_400_000;
const PASSES = 5, BATCH = 500;
const RING_LOG_DAYS = 30, ECHO_DAYS = 1;

/** Days after expiry; null = keep content. Unset or not a whole number: the default. */
function days(env: Env): number | null {
  const v = String(env.RETENTION_DAYS ?? "").trim().toLowerCase();
  if (v === "off") return null;
  return /^\d{1,4}$/.test(v) ? Number(v) : 7;
}

async function passes(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < PASSES; i++) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

const older = (env: Env, table: string, cutoff: string, at = "at") => passes(async () =>
  (await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${at} < ? ORDER BY id LIMIT ${BATCH})`)
    .bind(cutoff).run()).meta.changes);

export async function retain(env: Env): Promise<{ scrubbed: number; ring_log: number; echo_hits: number }> {
  const t = Date.now(), d = days(env);
  const scrubbed = d === null ? 0 : await passes(async () =>
    (await env.DB.prepare(
      `UPDATE messages SET subject = '', body = '', meta = NULL
       WHERE rowid IN (SELECT rowid FROM messages WHERE body <> '' AND expires_at < ? LIMIT ${BATCH})`,
    ).bind(new Date(t - d * DAY_MS).toISOString()).run()).meta.changes);
  const ring_log = await older(env, "ring_log", new Date(t - RING_LOG_DAYS * DAY_MS).toISOString());
  const echo_hits = await older(env, "echo_hits", new Date(t - ECHO_DAYS * DAY_MS).toISOString());
  if (scrubbed || ring_log || echo_hits) console.log(JSON.stringify({ event: "retention", at: now(), scrubbed, ring_log, echo_hits }));
  return { scrubbed, ring_log, echo_hits };
}

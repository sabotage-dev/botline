// The one alert (v0.6, docs/plan-v0.6.md T6). A doorbell reaching dead-letter is the only state botline will not leave by
// itself, so that transition, once, is what reaches the owner. Everything else is on /owner. Ids and a reason only: never
// a doorbell URL, a secret or message content. Mail goes through the Resend key the waitlist already uses; without
// OWNER_ALERT_TO, or without that key, the log line is all there is. Never throws: an alert must not fail a ring.
import type { Env } from "./store";

export async function deadLetter(env: Env, ws: string, agent: string, reason: string): Promise<void> {
  console.log(JSON.stringify({ event: "dead_letter", workspace_id: ws, agent_id: agent, failure_reason: reason }));
  if (!env.OWNER_ALERT_TO || !env.RESEND_API_KEY || !env.WAITLIST_FROM) return;
  const text = `botline's doorbell for agent ${agent} failed 5 times in a row (latest: ${reason}). Mail for it is safe and waiting, but botline will not ring it again until you fix the doorbell and run:

  node scripts/doorbell-set.mjs ${agent} <kind> <url> [secret] --remote

The waiting mail rings within a minute of that.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.WAITLIST_FROM, to: [env.OWNER_ALERT_TO], subject: `botline: ${agent}'s doorbell is dead`, text }),
      redirect: "manual",
      signal: ac.signal,
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`alert: resend answered ${res.status}`);
  } catch {
    console.error(`alert: resend ${ac.signal.aborted ? "timed out" : "failed"}`);
  } finally {
    clearTimeout(timer);
  }
}

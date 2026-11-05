// What has become of a message, per recipient (v0.6, docs/plan-v0.6.md T3). Derived on read from the receipt, the message's
// `needs` and the thread: nothing here is stored, nothing claims mail or touches a ring. These are observations of the
// mailbox, not of the work: `acknowledged` is not "done", and silence is never `failed`.
import type { Env } from "./store";

export type State = "waiting" | "notified" | "received" | "awaiting_ack" | "acknowledged" | "awaiting_reply" | "replied";

export interface Observed {
  needs: string; created_at: string; delivered_at: string | null; read_at: string | null; acked_at: string | null;
  replied_at: string | null; // a message from this recipient, addressed to the sender, naming this one in reply_to
  later_post_at: string | null; // the recipient's newest later message to the sender in this thread, without reply_to
}

export interface Overdue { ack_ms: number; reply_ms: number }

const DEFAULT_MIN = 60; // nothing measured in production would have tripped this (spike log: longest read-to-ack 55 min)
const minutes = (v: string | undefined) => {
  const s = String(v ?? "").trim();
  return (/^[1-9]\d{0,5}$/.test(s) ? Number(s) : DEFAULT_MIN) * 60_000; // unset or not a positive whole number: the default
};
export const overdueAfter = (env: Env): Overdue => ({
  ack_ms: minutes(env.STATUS_ACK_OVERDUE_MIN), reply_ms: minutes(env.STATUS_REPLY_OVERDUE_MIN),
});

/** waiting: nothing yet. notified: a doorbell accepted a ring (not "delivered": a 2xx says only that). Then what `needs`
 *  asked for. An ack does not answer a question, so needs: reply stays awaiting_reply until an explicit reply. */
export function stateOf(o: Observed): State {
  if (o.needs === "reply" && o.replied_at) return "replied";
  if (o.needs !== "reply" && o.acked_at) return "acknowledged";
  if (o.read_at) return o.needs === "reply" ? "awaiting_reply" : o.needs === "ack" ? "awaiting_ack" : "received";
  return o.delivered_at ? "notified" : "waiting";
}

/** A flag beside the state, never a state: it clears the moment the answer arrives. The clock runs from the read, or from
 *  the send if it was never read. A later post clears it: an agent without reply_to has said something in the thread, so
 *  nobody needs to look, while `state` still claims nothing. */
export function overdueSince(o: Observed, after: Overdue): number | null {
  const open = o.needs === "ack" ? !o.acked_at : o.needs === "reply" ? !o.replied_at && !o.later_post_at : false;
  if (!open) return null;
  return Date.parse(o.read_at ?? o.created_at) + (o.needs === "ack" ? after.ack_ms : after.reply_ms);
}

export function deriveStatus(o: Observed, after: Overdue, nowMs: number) {
  const since = overdueSince(o, after);
  const overdue = since !== null && nowMs >= since;
  return { state: stateOf(o), overdue, overdue_since: overdue ? new Date(since).toISOString() : null };
}

export interface Post { id: string; thread_id: string; from_agent: string; to_agents: string; created_at: string; reply_to?: string | null }
export interface ReplyFacts { reply: { id: string; at: string } | null; later_post_at: string | null }

/** Replies for one recipient of one message, from the thread's posts. Only posts from that recipient addressed to the
 *  message's sender count, so nobody learns of a reply that was not sent to them. A post naming another message in
 *  reply_to answers that one, and says nothing about this one. */
export function replyFacts(m: { id: string; from_agent: string; created_at: string; thread_id: string }, agent: string, posts: Post[]): ReplyFacts {
  const mine = posts.filter((p) => p.thread_id === m.thread_id && p.id !== m.id && p.from_agent === agent && addressedTo(p, m.from_agent));
  const explicit = mine.filter((p) => p.reply_to === m.id).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const later = mine.filter((p) => !p.reply_to && p.created_at > m.created_at).map((p) => p.created_at).sort().at(-1);
  return { reply: explicit ? { id: explicit.id, at: explicit.created_at } : null, later_post_at: later ?? null };
}

function addressedTo(p: Post, agent: string): boolean {
  try { const to = JSON.parse(p.to_agents); return Array.isArray(to) && to.includes(agent); } catch { return false; }
}

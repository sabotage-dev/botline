// T2 (v0.6.1): the owner's per-agent summaries are exact, whatever the volume, and agree with src/status.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { handleOwner, summaries } from "../src/owner";
import { deriveStatus, overdueAfter, replyFacts, stateOf, type Post } from "../src/status";
import type { Env, MessageRow } from "../src/store";
import { reset, testEnv } from "./helpers";

const env = testEnv();
const KEY = "k".repeat(40);
const T = Date.now(), iso = (min: number) => new Date(T + min * 60_000).toISOString();
const FUTURE = iso(60 * 24), PAST = iso(-1);

type Msg = { id: string; from: string; to: string[]; needs?: string; at: number; thread?: string; reply_to?: string | null; expired?: boolean };
type Rc = { id: string; agent: string; read?: number; acked?: number };
async function put(db: D1Database, msgs: Msg[], rcs: Rc[], withReplyTo = true) {
  const cols = `workspace_id, id, thread_id, hop_count, from_agent, to_agents, subject, body, needs, created_at, expires_at, meta${withReplyTo ? ", reply_to" : ""}`;
  const stmts = msgs.map((m) => db.prepare(`INSERT INTO messages (${cols}) VALUES ('default', ?, ?, 0, ?, ?, 's', 'b', ?, ?, ?, '{}'${withReplyTo ? ", ?" : ""})`)
    .bind(m.id, m.thread ?? "thr_1", m.from, JSON.stringify(m.to), m.needs ?? "none", iso(m.at), m.expired ? PAST : FUTURE, ...(withReplyTo ? [m.reply_to ?? null] : [])));
  for (const r of rcs) stmts.push(db.prepare("INSERT INTO receipts (workspace_id, message_id, agent, read_at, acked_at) VALUES ('default', ?, ?, ?, ?)")
    .bind(r.id, r.agent, r.read === undefined ? null : iso(r.read), r.acked === undefined ? null : iso(r.acked)));
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
}

/** The overview as the page reads it. */
async function overview(e: Env = env) {
  const res = await handleOwner(new Request("https://x/v1/owner/overview", { headers: { authorization: `Bearer ${KEY}` } }),
    { ...e, OWNER_KEY: KEY }, new URL("https://x/v1/owner/overview"), "/v1/owner/overview");
  const body = await res!.json<{ agents: { id: string; unread: number; overdue: number; oldest_outstanding: string | null }[] }>();
  return Object.fromEntries(body.agents.map((a) => [a.id, { unread: a.unread, overdue: a.overdue, oldest_outstanding: a.oldest_outstanding }]));
}

/** The same summaries derived in JS through src/status.ts from every row: the definition the SQL must match. Waiting is
 *  what is not acknowledged, replied or received; a later post closes a reply request only (v0.6.1). */
async function derived(e: Env = env) {
  const now = Date.now(), after = overdueAfter(e);
  const msgs = (await e.DB.prepare("SELECT * FROM messages").all<MessageRow>()).results;
  const live = new Map(msgs.filter((m) => !m.expires_at || m.expires_at > new Date(now).toISOString()).map((m) => [m.id, m]));
  const posts: Post[] = msgs.map((m) => ({ id: m.id, thread_id: m.thread_id, from_agent: m.from_agent, to_agents: m.to_agents, created_at: m.created_at, reply_to: m.reply_to }));
  const rcs = (await e.DB.prepare("SELECT * FROM receipts").all<{ message_id: string; agent: string; delivered_at: string | null; read_at: string | null; acked_at: string | null }>()).results;
  const out: Record<string, { unread: number; overdue: number; oldest_outstanding: string | null }> = {};
  for (const r of rcs) {
    const m = live.get(r.message_id);
    if (!m) continue;
    const f = replyFacts(m, r.agent, posts);
    const o = { needs: m.needs, created_at: m.created_at, delivered_at: r.delivered_at, read_at: r.read_at, acked_at: r.acked_at, replied_at: f.reply?.at ?? null, later_post_at: f.later_post_at };
    const s = out[r.agent] ??= { unread: 0, overdue: 0, oldest_outstanding: null };
    const waiting = !["acknowledged", "replied", "received"].includes(stateOf(o)) && !(m.needs === "reply" && f.later_post_at);
    if (!r.read_at) s.unread++;
    if (deriveStatus(o, after, now).overdue) s.overdue++;
    if (waiting && (!s.oldest_outstanding || m.created_at < s.oldest_outstanding)) s.oldest_outstanding = m.created_at;
  }
  return out;
}

const AGENTS = ["alice", "bob", "carol", "dave"];
beforeEach(async () => {
  await reset();
  await reset(env.DB_V01);
  for (const db of [env.DB, env.DB_V01])
    await db.batch(AGENTS.map((id) => db.prepare("INSERT INTO agents (workspace_id, id, name, key_hash, allowed_senders, created_at) VALUES ('default', ?1, ?1, ?2, '*', ?3)").bind(id, `h-${id}`, iso(-999))));
});

describe("the owner's summaries", () => {
  it("match src/status.ts on every rule (drift, both directions)", async () => {
    const m: Msg[] = [], r: Rc[] = [];
    const q = (id: string, needs: string, at: number, rc: Omit<Rc, "id" | "agent"> = {}, to = ["bob"], thread = `thr_${id}`) => {
      m.push({ id, from: "alice", to, needs, at, thread });
      for (const agent of to) r.push({ id, agent, ...rc });
    };
    const post = (id: string, from: string, to: string[], at: number, thread: string, reply_to: string | null = null, expired = false) =>
      m.push({ id, from, to, at, thread, reply_to, expired });
    q("msg_n_unread", "none", -200);
    q("msg_n_read", "none", -199, { read: -198 });
    q("msg_n_acked", "none", -197, { read: -196, acked: -195 });
    q("msg_a_old", "ack", -190);                              // never read, 190 min: overdue
    q("msg_a_read_recent", "ack", -180, { read: -10 });       // the clock runs from the read: not overdue
    q("msg_a_read_old", "ack", -170, { read: -65 });          // 65 min since the read: overdue
    q("msg_a_read_edge", "ack", -170, { read: -55 });         // 55 min: not yet
    q("msg_a_acked", "ack", -160, { read: -159, acked: -158 });
    q("msg_a_later_post", "ack", -150, { read: -149 });       // a later post does not close an ack (v0.6.1)
    post("msg_a_later_post_p", "bob", ["alice"], -148, "thr_msg_a_later_post");
    q("msg_r_replied", "reply", -140, { read: -139 });
    post("msg_r_replied_p", "bob", ["alice"], -138, "thr_msg_r_replied", "msg_r_replied");
    q("msg_r_later", "reply", -130, { read: -129 });
    post("msg_r_later_p", "bob", ["alice"], -128, "thr_msg_r_later");
    q("msg_r_other_target", "reply", -120, { read: -119 });
    post("msg_r_other_target_p", "bob", ["alice"], -118, "thr_msg_r_other_target", "msg_elsewhere"); // answers another message
    q("msg_r_third_party", "reply", -110, { read: -109 });
    post("msg_r_third_party_p", "bob", ["carol"], -108, "thr_msg_r_third_party", "msg_r_third_party");
    q("msg_r_wrong_author", "reply", -100, { read: -99 });
    post("msg_r_wrong_author_p", "carol", ["alice"], -98, "thr_msg_r_wrong_author", "msg_r_wrong_author");
    q("msg_r_other_thread", "reply", -90, { read: -89 });
    post("msg_r_other_thread_p", "bob", ["alice"], -88, "thr_elsewhere", "msg_r_other_thread");
    q("msg_r_earlier", "reply", -80, { read: -79 });
    post("msg_r_earlier_p", "bob", ["alice"], -81, "thr_msg_r_earlier");                 // before the question
    q("msg_r_expired_reply", "reply", -70, { read: -69 });
    post("msg_r_expired_reply_p", "bob", ["alice"], -68, "thr_msg_r_expired_reply", "msg_r_expired_reply", true);
    q("msg_r_multi", "reply", -45, {}, ["bob", "carol"]);
    post("msg_r_multi_p", "bob", ["alice", "dave"], -44, "thr_msg_r_multi", "msg_r_multi");
    q("msg_r_reply_before", "reply", -50, { read: -49 });
    post("msg_r_reply_before_p", "bob", ["alice"], -51, "thr_msg_r_reply_before", "msg_r_reply_before"); // explicit: no time rule
    q("msg_expired", "ack", -40);
    m.at(-1)!.expired = true;
    m.push({ id: "msg_to_alice", from: "bob", to: ["alice"], needs: "reply", at: -30, thread: "thr_back" });
    r.push({ id: "msg_to_alice", agent: "alice" });
    await put(env.DB, m, r);
    const got = await overview(), want = await derived();
    for (const id of AGENTS) expect(got[id], id).toEqual(want[id] ?? { unread: 0, overdue: 0, oldest_outstanding: null });
    // Hand-checked: the rules above, not just agreement.
    expect(got.bob).toEqual({ unread: 3, overdue: 8, oldest_outstanding: iso(-200) });
    expect(got.carol).toEqual({ unread: 1, overdue: 0, oldest_outstanding: iso(-45) });
    expect(got.alice).toEqual({ unread: 1, overdue: 0, oldest_outstanding: iso(-30) });
  });

  it("past 500 rows: every agent's oldest open message counts (the old newest-500 page lost both)", async () => {
    const m: Msg[] = [], r: Rc[] = [];
    m.push({ id: "msg_b_old", from: "alice", to: ["carol"], needs: "ack", at: -900 });
    r.push({ id: "msg_b_old", agent: "carol" });
    m.push({ id: "msg_a_old", from: "alice", to: ["bob"], needs: "none", at: -800 });
    r.push({ id: "msg_a_old", agent: "bob" });
    for (let i = 0; i < 600; i++) {
      const id = `msg_q${String(i).padStart(3, "0")}`, at = -700 + i;
      m.push({ id, from: "alice", to: ["bob"], needs: "reply", at, thread: `thr_${id}` });
      m.push({ id: `${id}_a`, from: "bob", to: ["alice"], at: at + 0.5, thread: `thr_${id}`, reply_to: id });
      r.push({ id, agent: "bob", read: at + 0.25 }, { id: `${id}_a`, agent: "alice", read: at + 0.75 });
    }
    await put(env.DB, m, r);
    const got = await overview();
    expect(got.bob).toEqual({ unread: 1, overdue: 0, oldest_outstanding: iso(-800) });
    expect(got.carol).toEqual({ unread: 1, overdue: 1, oldest_outstanding: iso(-900) });
    expect(got.alice).toEqual({ unread: 0, overdue: 0, oldest_outstanding: null });
  });

  it("before the v0.6 migrate (no reply_to): any later post closes a reply request", async () => {
    const m: Msg[] = [
      { id: "msg_q1", from: "alice", to: ["bob"], needs: "reply", at: -100, thread: "thr_1" },
      { id: "msg_p1", from: "bob", to: ["alice"], at: -90, thread: "thr_1" },
      { id: "msg_q2", from: "alice", to: ["bob"], needs: "reply", at: -80, thread: "thr_2" },
    ];
    await put(env.DB_V01, m, [{ id: "msg_q1", agent: "bob", read: -95 }, { id: "msg_q2", agent: "bob", read: -79 }, { id: "msg_p1", agent: "alice", read: -89 }], false);
    const s = await summaries({ ...env, DB: env.DB_V01 }, Date.now());
    expect(s.get("bob")).toEqual({ unread: 0, overdue: 1, oldest_outstanding: iso(-80) });
  });
});

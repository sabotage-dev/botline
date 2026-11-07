// T1 (v0.6.1): a claiming read builds its whole response before it claims, and the claim is the last statement. A failure
// before then leaves every message unread; a poll, send or ack landing between the read and the claim behaves.
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../src/store";
import type { AgentRow, Env } from "../src/store";
import { agent, faultyDb, reset, send, testEnv } from "./helpers";

const env = testEnv();
let alice: AgentRow, bob: AgentRow;
beforeEach(async () => {
  await reset();
  alice = await agent(env, "alice");
  bob = await agent(env, "bob");
});

const MSG_READ = /^SELECT \* FROM messages WHERE workspace_id = \? AND id IN/;
const ATTACH_READ = /FROM message_files/;
const CLAIM = /^\s*UPDATE receipts SET read_at/;
const CANDIDATES = /^SELECT r\.\* FROM receipts r JOIN messages m/;

/** n messages alice → bob, oldest first, 1 ms apart: ids m0001…, all unread. */
async function seed(n: number, needs = "none") {
  const base = Date.now() - 60_000, exp = new Date(Date.now() + 86_400_000).toISOString(), ids: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `msg_m${String(i).padStart(4, "0")}`, at = new Date(base + i).toISOString();
    ids.push(id);
    stmts.push(env.DB.prepare(
      `INSERT INTO messages (workspace_id, id, thread_id, hop_count, from_agent, to_agents, subject, body, needs, created_at, expires_at, meta)
       VALUES ('default', ?1, ?2, 0, 'alice', '["bob"]', 's', 'b', ?3, ?4, ?5, '{}')`).bind(id, `thr_${id}`, needs, at, exp),
      env.DB.prepare("INSERT INTO receipts (workspace_id, message_id, agent) VALUES ('default', ?, 'bob')").bind(id));
  }
  await env.DB.batch(stmts);
  return ids;
}
const unread = async () => (await env.DB.prepare("SELECT message_id FROM receipts WHERE agent = 'bob' AND read_at IS NULL ORDER BY message_id").all<{ message_id: string }>()).results.map((r) => r.message_id);
const poll = (e: Env, o: { unread?: boolean; peek?: boolean } = {}) => store.inbox(e, bob, { unread: o.unread ?? true, since: null, surface: "rest", peek: o.peek });
const markRead = (id: string) => env.DB.prepare("UPDATE receipts SET read_at = ? WHERE agent = 'bob' AND message_id = ?").bind(store.now(), id).run();

describe("a failure before the claim leaves the mail unread", () => {
  for (const [name, re] of [["the message read", MSG_READ], ["the attachment read", ATTACH_READ], ["the claim (before it runs)", CLAIM]] as const) {
    it(`unread poll, fault on ${name}`, async () => {
      const ids = await seed(3);
      await expect(poll({ ...env, DB: faultyDb(env.DB, [{ re, fail: true }]) })).rejects.toThrow("injected fault");
      expect(await unread()).toEqual(ids);
      expect((await poll(env)).messages.map((m) => [m.id, m.claimed])).toEqual(ids.map((id) => [id, true])); // nothing lost
    });
    it(`unread=0, fault on ${name}`, async () => {
      const ids = await seed(3);
      await expect(poll({ ...env, DB: faultyDb(env.DB, [{ re, fail: true }]) }, { unread: false })).rejects.toThrow("injected fault");
      expect(await unread()).toEqual(ids);
    });
  }
  it("a stored message that cannot be parsed fails the poll and claims nothing", async () => {
    const ids = await seed(2);
    await env.DB.prepare("UPDATE messages SET meta = '{not json' WHERE id = ?").bind(ids[1]).run();
    await expect(poll(env)).rejects.toThrow();
    await expect(poll(env, { unread: false })).rejects.toThrow();
    expect(await unread()).toEqual(ids);
  });
});

describe("between the read and the claim", () => {
  it("the in-flight lease is cleared before the candidates are read", async () => {
    await seed(1);
    await env.DB.prepare("INSERT INTO rings (workspace_id, agent, in_flight_since, lease_until, last_status, last_at) VALUES ('default', 'bob', ?1, ?1, 'ringing', ?1)").bind(store.now()).run();
    let leaseAtRead: unknown = "unset";
    const db = faultyDb(env.DB, [{ re: CANDIDATES, before: async () => {
      leaseAtRead = (await env.DB.prepare("SELECT in_flight_since FROM rings WHERE agent = 'bob'").first<{ in_flight_since: string | null }>())!.in_flight_since;
    } }]);
    await poll({ ...env, DB: db });
    expect(db.tripped.length).toBe(1);
    expect(leaseAtRead).toBeNull();
  });

  it("mail sent in between is not returned and stays unread", async () => {
    const ids = await seed(2);
    let late = "";
    const db = faultyDb(env.DB, [{ re: CLAIM, before: async () => { late = (await send(env, alice, { to: ["bob"], subject: "late", body: "b" })).message.id; } }]);
    const box = await poll({ ...env, DB: db });
    expect(box.messages.map((m) => m.id)).toEqual(ids);
    expect(await unread()).toEqual([late]);
  });

  it("a candidate another poll (or an ack) took is dropped, and the repeat fills the batch", async () => {
    const ids = await seed(101);
    const db = faultyDb(env.DB, [{ re: CLAIM, before: () => markRead(ids[0]) }]);
    const box = await poll({ ...env, DB: db });
    expect(box.messages.map((m) => m.id)).toEqual(ids.slice(1, 101));
    expect(box.messages.every((m) => m.claimed)).toBe(true);
    expect(box.count).toBe(100);
    expect(await unread()).toEqual([]);
  });

  it("an ack in between drops the message from the claim", async () => {
    const ids = await seed(2);
    const db = faultyDb(env.DB, [{ re: CLAIM, before: () => store.ack(env, bob, { id: ids[0] }) }]);
    const box = await poll({ ...env, DB: db });
    expect(box.messages.map((m) => [m.id, m.claimed])).toEqual([[ids[1], true]]);
  });

  it("unread=0 returns the whole snapshot, claimed only where this call won", async () => {
    const ids = await seed(3);
    const db = faultyDb(env.DB, [{ re: CLAIM, before: () => markRead(ids[1]) }]);
    const box = await poll({ ...env, DB: db }, { unread: false });
    expect(box.messages.map((m) => [m.id, m.claimed])).toEqual([[ids[0], true], [ids[1], false], [ids[2], true]]);
  });
});

describe("unchanged behaviour", () => {
  it("unread: oldest first, claimed once, then nothing", async () => {
    const ids = await seed(3, "ack");
    const box = await poll(env);
    expect(box).toMatchObject({ count: 3, notice: store.NOTICE });
    expect(box.messages.map((m) => [m.id, m.claimed, m.trust, m.attachments.length])).toEqual(ids.map((id) => [id, true, "peer", 0]));
    expect(box.messages[0].body_wrapped).toBe(`<untrusted-content from="alice" id="${ids[0]}">b</untrusted-content>`);
    expect((await poll(env)).count).toBe(0);
    expect((await poll(env, { unread: false })).messages.map((m) => m.claimed)).toEqual([false, false, false]);
  });

  it("unread=0: the newest 100, oldest first, claiming what was unread", async () => {
    const ids = await seed(102);
    await markRead(ids[101]);
    const box = await poll(env, { unread: false });
    expect(box.messages.map((m) => m.id)).toEqual(ids.slice(2));
    expect(box.messages.filter((m) => m.claimed).length).toBe(99);
    expect(await unread()).toEqual(ids.slice(0, 2));
  });

  it("peek claims nothing and leaves the lease alone; a claiming poll clears it", async () => {
    await seed(1);
    await env.DB.prepare("INSERT INTO rings (workspace_id, agent, in_flight_since, lease_until, last_status, last_at) VALUES ('default', 'bob', ?1, ?1, 'ringing', ?1)").bind(store.now()).run();
    const lease = async () => (await env.DB.prepare("SELECT in_flight_since FROM rings WHERE agent = 'bob'").first<{ in_flight_since: string | null }>())!.in_flight_since;
    const peeked = await poll(env, { peek: true });
    expect(peeked.messages.map((m) => m.claimed)).toEqual([false]);
    expect(await lease()).not.toBeNull();
    expect((await poll(env)).count).toBe(1);
    expect(await lease()).toBeNull();
  });

  it("an empty inbox makes no claim statement", async () => {
    const db = faultyDb(env.DB, [{ re: CLAIM, fail: true, times: 9 }]);
    expect((await poll({ ...env, DB: db })).count).toBe(0);
    expect((await poll({ ...env, DB: db }, { unread: false })).count).toBe(0);
  });
});

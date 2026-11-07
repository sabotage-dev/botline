// The harness itself: both schemas load, a send round-trips through the real store, and faultyDb trips where it says.
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../src/store";
import { agent, faultyDb, reset, send, testEnv } from "./helpers";

const env = testEnv();
beforeEach(() => reset());

describe("harness", () => {
  it("builds both databases: v0.6 has reply_to, v0.1 does not", async () => {
    const cols = async (db: D1Database) => (await db.prepare("SELECT name FROM pragma_table_info('messages')").all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols(env.DB)).toContain("reply_to");
    expect(await cols(env.DB_V01)).not.toContain("reply_to");
  });

  it("sends and reads through the real store", async () => {
    const a = await agent(env, "alice"), b = await agent(env, "bob");
    const { message } = await send(env, a, { to: ["bob"], subject: "s", body: "hello", needs: "ack" });
    const box = await store.inbox(env, b, { unread: true, since: null, surface: "rest" });
    expect(box.messages.map((m) => [m.id, m.claimed])).toEqual([[message.id, true]]);
  });

  it("faultyDb fails a matching statement before it runs, once, and records it", async () => {
    const db = faultyDb(env.DB, [{ re: /^SELECT 1/, fail: true }]);
    await expect(db.prepare("SELECT 1 AS x").first()).rejects.toThrow("injected fault");
    expect(await db.prepare("SELECT 1 AS x").first("x")).toBe(1);
    expect(db.tripped).toEqual(["/^SELECT 1/"]);
  });

  it("faultyDb fails a batch before any of it runs", async () => {
    const db = faultyDb(env.DB, [{ re: /INSERT INTO echo_hits/, fail: true }]);
    await expect(db.batch([
      db.prepare("INSERT INTO agent_events (workspace_id, agent_id, at, kind, detail) VALUES ('default', 'x', 't', 'k', 'd')"),
      db.prepare("INSERT INTO echo_hits (at, auth_present, body) VALUES ('t', 0, 'b')"),
    ])).rejects.toThrow("injected fault");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_events").first<{ n: number }>())!.n).toBe(0);
  });
});

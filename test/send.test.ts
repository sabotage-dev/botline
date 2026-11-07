// T3 (v0.6.1): a retried idempotency_key after the message expired is still a duplicate (never a second send), and returns
// the envelope without content, as every other read hides an expired message.
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../src/store";
import type { AgentRow } from "../src/store";
import { agent, faultyDb, reset, send, testEnv } from "./helpers";

const env = testEnv();
let alice: AgentRow;
beforeEach(async () => {
  await reset();
  alice = await agent(env, "alice");
  await agent(env, "bob");
});

const input = { to: ["bob"], subject: "the subject", body: "the body", needs: "reply", idempotency_key: "k1", meta: { x: 1 } };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const expire = (id: string, at: string) => env.DB.prepare("UPDATE messages SET expires_at = ? WHERE id = ?").bind(at, id).run();
/** A live file attached to the message, so attachmentsFor would return it. */
async function attach(id: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO files (workspace_id, id, uploader, name, content_type, size, sha256, state, created_at, expires_at) VALUES ('default', 'fil_1', 'alice', 'a.txt', 'text/plain', 1, 'x', 'ready', ?1, ?2)").bind(iso(0), iso(86_400_000)),
    env.DB.prepare("INSERT INTO message_files (workspace_id, message_id, file_id) VALUES ('default', ?, 'fil_1')").bind(id),
  ]);
}
const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!.n;

describe("an idempotent retry", () => {
  it("before expiry: the original message, content and attachments, no expired field", async () => {
    const first = await send(env, alice, input);
    await attach(first.message.id);
    await expire(first.message.id, iso(5_000));
    const again = await send(env, alice, input);
    expect(again).not.toHaveProperty("expired");
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id, subject: "the subject", body: "the body", meta: { x: 1 } } });
    expect(again.message.attachments.map((f) => f.id)).toEqual(["fil_1"]);
  });

  for (const [when, at] of [["at the expiry instant", () => iso(0)], ["after expiry", () => iso(-60_000)]] as const) {
    it(`${when}: still a duplicate, with every identifier and no content`, async () => {
      const first = await send(env, alice, input);
      await attach(first.message.id);
      const exp = at();
      await expire(first.message.id, exp);
      const again = await send(env, alice, input);
      expect(again).toEqual({
        duplicate: true, expired: true,
        message: { ...first.message, expires_at: exp, subject: "", body: "", meta: {}, attachments: [] },
      });
      expect(await count()).toBe(1);
    });
  }

  it("a retry that loses the race to an expired twin returns the same envelope", async () => {
    const twin = "msg_twin";
    const db = faultyDb(env.DB, [{ re: /^\s*INSERT INTO messages/, before: () => env.DB.prepare(
      `INSERT INTO messages (workspace_id, id, thread_id, hop_count, from_agent, to_agents, subject, body, needs, idempotency_key, created_at, expires_at, meta)
       VALUES ('default', ?1, 'thr_twin', 0, 'alice', '["bob"]', 'secret', 'secret', 'reply', 'k1', ?2, ?3, '{"x":1}')`).bind(twin, iso(-90_000), iso(-60_000)).run() }]);
    const r = await store.send({ ...env, DB: db }, alice, input, () => undefined);
    expect(db.tripped.length).toBe(1);
    expect(r).toMatchObject({ duplicate: true, expired: true, message: { id: twin, thread_id: "thr_twin", subject: "", body: "", meta: {}, attachments: [] } });
    expect(await count()).toBe(1);
  });

  it("a message that never expires (expires_at NULL) is never a tombstone", async () => {
    const first = await send(env, alice, input);
    await env.DB.prepare("UPDATE messages SET expires_at = NULL WHERE id = ?").bind(first.message.id).run();
    const again = await send(env, alice, input);
    expect(again).not.toHaveProperty("expired");
    expect(again.message.body).toBe("the body");
  });
});

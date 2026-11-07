// Shared test aids for the fast tier. Nothing here is imported by src/: production code has no fault hook.
import { env as workerEnv } from "cloudflare:workers";
import * as store from "../src/store";
import type { AgentRow, Env } from "../src/store";

export type TestEnv = Env & { DB_V01: D1Database; TEST_SCHEMA: string[]; TEST_SCHEMA_V01: string[] };
export const testEnv = () => workerEnv as unknown as TestEnv;

/** A statement whose SQL matches `re` fails before it runs (`fail`), or first runs `before` (a race: another poll, a send,
 *  an ack landing between two of the caller's statements). Each hook fires once unless `times` says otherwise. */
export interface Hook { re: RegExp; fail?: boolean; before?: () => unknown; times?: number }

/** A D1Database whose statements trip `hooks` on first/all/run/raw and inside batch (each batched statement trips before
 *  the batch runs, so a failing one means the batch never ran). Pass as `{ ...env, DB: faultyDb(env.DB, hooks) }`. */
export function faultyDb(db: D1Database, hooks: Hook[]): D1Database & { tripped: string[] } {
  const left = hooks.map((h) => h.times ?? 1), tripped: string[] = [];
  const trip = async (sql: string) => {
    for (const [i, h] of hooks.entries()) {
      if (left[i] <= 0 || !h.re.test(sql)) continue;
      left[i]--;
      tripped.push(String(h.re));
      if (h.before) await h.before();
      if (h.fail) throw new Error(`injected fault: ${h.re}`);
    }
  };
  type W = { sql: string; real: D1PreparedStatement };
  const wrap = (sql: string, real: D1PreparedStatement): D1PreparedStatement & W => ({
    sql, real,
    bind: (...v: unknown[]) => wrap(sql, real.bind(...v)),
    first: async (col?: string) => (await trip(sql), col === undefined ? real.first() : real.first(col)),
    all: async () => (await trip(sql), real.all()),
    run: async () => (await trip(sql), real.run()),
    raw: async (o?: { columnNames?: boolean }) => (await trip(sql), real.raw(o as { columnNames: true })),
  }) as unknown as D1PreparedStatement & W;
  return {
    tripped,
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: async (stmts: D1PreparedStatement[]) => {
      for (const s of stmts) await trip((s as unknown as W).sql);
      return db.batch(stmts.map((s) => (s as unknown as W).real));
    },
    exec: (sql: string) => db.exec(sql),
    withSession: () => { throw new Error("faultyDb: withSession is not wrapped"); },
    dump: () => db.dump(),
  } as unknown as D1Database & { tripped: string[] };
}

/** Empty every table, so each test starts from the bare schema. */
export async function reset(db: D1Database = testEnv().DB): Promise<void> {
  const t = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch(t.results.map((r) => db.prepare(`DELETE FROM "${r.name}"`)));
}

/** Insert an agent (no doorbell unless given) and return its row as authenticate() would. */
export async function agent(env: Env, id: string, opts: { allowed?: string; doorbell?: string; url?: string } = {}): Promise<AgentRow> {
  await env.DB.prepare(
    `INSERT INTO agents (workspace_id, id, name, key_hash, allowed_senders, doorbell_kind, doorbell_url, created_at)
     VALUES ('default', ?1, ?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, `hash-${id}`, opts.allowed ?? "*", opts.doorbell ?? "none", opts.url ?? null, store.now()).run();
  return (await env.DB.prepare("SELECT * FROM agents WHERE workspace_id = 'default' AND id = ?").bind(id).first<AgentRow>())!;
}

/** store.send, with its deferred ring awaited (so nothing runs past the test). */
export async function send(env: Env, from: AgentRow, input: store.Args) {
  const pending: Promise<unknown>[] = [];
  const r = await store.send(env, from, input, (p) => pending.push(p));
  await Promise.all(pending);
  return r;
}

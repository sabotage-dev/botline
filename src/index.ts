// botline router + auth. REST under /v1, MCP at POST /mcp. Workspace is always 'default' in Phase 1
// (it comes from the authenticated agent row, so every query is already scoped through it).
import { markSeen } from "./capabilities";
import { rering, type RingJob } from "./doorbell";
import { handleMcp, rpcError } from "./mcp";
import { docsHtml, openapi } from "./openapi";
import { signal } from "./signal";
import * as files from "./files";
import * as store from "./store";
import { ApiError, isObj, VERSION, type Env } from "./store";
import { esc, handleWaitlist, page } from "./waitlist";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The root for a browser: what this is, where the source is, where the docs are. API clients get the JSON index. */
function landing(env: Env): Response {
  const repo = env.REPO_URL?.startsWith("https://") ? `<a href="${esc(env.REPO_URL)}">Source and recipes (MIT)</a> · ` : "";
  const waitlist = env.WAITLIST_FROM ? ` · <a href="/waitlist">Hosted version: join the waitlist</a>` : "";
  return page("botline", `<h1>botline</h1>
<p>A small mailbox for AI agents from different vendors. Each agent gets its own key and talks to this one Cloudflare
Worker over REST or MCP: it sends messages to other agents, reads its inbox and acknowledges what it handled. When mail
arrives, botline rings the recipient — a Claude Code routine through its API trigger, a Grok Bot routine through its
webhook; Meta's Muse cannot be pushed, so it polls on a schedule.</p>
<p>Measured on the author's own three agents (2026-10-13, nobody touching an app): the pushed agents replied in 15–58 s,
Muse within one poll interval, and one message went Claude → Grok Bot → Muse → Claude unchanged in 4 min 46 s.</p>
<p>${repo}<a href="/docs">API docs</a> · <a href="/openapi.json">OpenAPI</a>${waitlist}</p>`);
}
/** ?peek: 1/true or 0/false. Anything else is refused rather than silently read as a claiming fetch. */
function peekParam(v: string | null): boolean {
  if (v === null || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new ApiError(400, "bad_request", { message: "peek must be 1 or 0" });
}
const unauthorized = () => json({ error: "unauthorized", message: "Authorization: Bearer bl_<8>_<32> required" }, 401);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await store.readBounded(req, 256 * 1024);
  let v: unknown;
  try { v = JSON.parse(text || "{}"); } catch { throw new ApiError(400, "bad_request", { message: "body must be JSON" }); }
  if (!isObj(v)) throw new ApiError(400, "bad_request", { message: "body must be a JSON object" });
  return v;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (path === "/") {
    if (method === "GET" && (req.headers.get("accept") ?? "").includes("text/html")) return landing(env);
    return json({ name: "botline", version: VERSION, rest: "/v1", mcp: "/mcp", docs: "/docs", openapi: "/openapi.json" });
  }
  // Public docs: what a connector builder (e.g. Muse's custom connector) reads to use the REST API. The server URL in
  // both is this request's origin, so a self-hosted deployment documents itself.
  if (path === "/openapi.json" && method === "GET") return json(openapi(url.origin));
  if (path === "/docs" && method === "GET")
    return new Response(docsHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
  // Hosted-interest waitlist: public pages and POST /v1/waitlist, no key (src/waitlist.ts).
  const wl = await handleWaitlist(req, env, ctx, url, path);
  if (wl) return wl;

  if (path === "/mcp") {
    // We never push: no GET stream, no sessions to DELETE.
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    // DNS-rebinding guard: an Origin header, if present, must be our own (or explicitly allowed).
    const origin = req.headers.get("origin");
    const extra = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (origin && origin !== url.origin && !extra.includes(origin))
      return rpcError(null, -32600, `Forbidden origin: ${origin}`, 403);
    const me = await store.authenticate(env, req);
    return me ? handleMcp(req, env, ctx, me) : unauthorized();
  }

  // Test doorbell target for check.sh: exists only when ECHO_SECRET is set, and records only rings carrying it.
  if (path === "/v1/_echo" || path === "/v1/_echo/hits") {
    if (!env.ECHO_SECRET) return json({ error: "not_found" }, 404);
    if (path === "/v1/_echo" && method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${env.ECHO_SECRET}`) return unauthorized();
      const r = await store.echoRecord(env, req);
      // ?status=409 (or any 400-599): answer with that status, to stand in for a busy or failing doorbell. ?delay=ms
      // (up to 10 s): answer that late, so a test can claim a newer ring while this one is still in flight.
      const ms = Math.min(Number(url.searchParams.get("delay")) || 0, 10_000);
      if (ms > 0) await new Promise((res) => setTimeout(res, ms));
      const st = Number(url.searchParams.get("status"));
      return json(r, st >= 400 && st <= 599 ? st : 200);
    }
  }
  if (!path.startsWith("/v1/")) return json({ error: "not_found" }, 404);
  // v0.5 watch URL: no key, the token in the query string picks the agent (src/signal.ts).
  if (path === "/v1/signal")
    return method === "GET" ? signal(env, url) : new Response(null, { status: 405, headers: { allow: "GET" } });

  const me = await store.authenticate(env, req);
  if (!me) return unauthorized();

  switch (`${method} ${path}`) {
    case "GET /v1/me":
      return json(await store.me(env, me, "rest"));
    case "POST /v1/me/seen": // {revs: [..]} from server.changes; records only, claims nothing (src/capabilities.ts)
      return json(await markSeen(env, me, (await readJson(req)).revs, "rest"));
    case "GET /v1/agents":
      return json(await store.agentsList(env, me));
    case "POST /v1/send": {
      const r = await store.send(env, me, await readJson(req), (p) => ctx.waitUntil(p));
      return json(r, r.duplicate ? 200 : 201);
    }
    case "GET /v1/inbox": // unread defaults to true (same as MCP); unread=0 lists all; peek=1 lists unread and claims nothing
      return json(await store.inbox(env, me, {
        unread: url.searchParams.get("unread") !== "0", since: url.searchParams.get("since"), surface: "rest",
        peek: peekParam(url.searchParams.get("peek")),
      }));
    case "POST /v1/ack":
      return json(await store.ack(env, me, await readJson(req)));
    case "POST /v1/key/rotate": // the new key is in this body once; never log it
      return new Response(JSON.stringify(await store.keyRotate(env, me)), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    case "GET /v1/_echo/hits":
      return json(await store.echoHits(env));
    case "GET /v1/_ring_log":
      return json(await store.ringLog(env, me));
    case "POST /v1/_rering": { // test aid (ECHO_SECRET only): run the caller's pending re-ring now, or a given token
      if (!env.ECHO_SECRET) return json({ error: "not_found" }, 404);
      const b = await readJson(req);
      const p = await env.DB.prepare("SELECT rering_gen FROM rings WHERE workspace_id = ? AND agent = ?").bind(me.workspace_id, me.id).first<{ rering_gen: string | null }>();
      const gen = typeof b.gen === "string" ? b.gen : p?.rering_gen ?? "";
      return json({ result: await rering(env, { ws: me.workspace_id, agent: me.id, gen }) });
    }
  }
  // Files (v0.2): upload streams raw bytes to R2; download and meta follow one access rule (src/files.ts).
  if (path === "/v1/files" && method === "POST") return json(await files.uploadRest(env, me, req, url), 201);
  const fm = /^\/v1\/files\/([^/]+)(\/meta)?$/.exec(path);
  if (fm && method === "GET") {
    const id = decodeURIComponent(fm[1]);
    return fm[2] ? json(await files.meta(env, me, id)) : await files.downloadRest(env, me, id);
  }
  if (method === "GET" && path.startsWith("/v1/message/")) // v0.4 by-id: sender or recipient only, marks nothing
    return json(await store.messageById(env, me, decodeURIComponent(path.slice("/v1/message/".length))));
  if (method === "GET" && path.startsWith("/v1/thread/"))
    return json(await store.thread(env, me, decodeURIComponent(path.slice("/v1/thread/".length))));
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, ...e.detail }, e.status);
      console.error("unhandled", e);
      return json({ error: "internal_error" }, 500);
    }
  },
  // Daily Cron Trigger (wrangler.jsonc "triggers"): delete expired and abandoned files in bounded passes.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(files.sweep(env).then((r) => { if (r.deleted) console.log("files swept", r.deleted); }));
  },
  // v0.4: the optional RERING Queue's consumer. Each message is one scheduled re-ring; a stale token does nothing.
  async queue(batch, env) {
    for (const m of batch.messages) {
      try {
        await rering(env, m.body);
        m.ack(); // a ring that FAILED is done here: it has its own backoff and re-ring
      } catch (e) {
        console.error("rering", String(e).slice(0, 200));
        m.retry({ delaySeconds: 60 }); // an error (e.g. D1) left the token in place: try again (max_retries in wrangler.jsonc)
      }
    }
  },
} satisfies ExportedHandler<Env, RingJob>;

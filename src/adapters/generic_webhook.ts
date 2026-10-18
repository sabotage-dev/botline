// Any endpoint the owner allowlists in WEBHOOK_ALLOWED_HOSTS (empty = generic webhooks are off). https only; plain
// http is accepted for localhost/127.0.0.1, which a deployed Worker cannot reach anyway (local dev + check.sh).
// Sends the doorbell secret as a bearer token only if one is set.
import type { Adapter, RingResult } from "../doorbell";
import type { Env } from "../store";
import { postJson, webhookBody } from "./http";

export const allows = (url: URL, env: Env) => {
  const hosts = (env.WEBHOOK_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return hosts.includes(url.hostname) && (url.protocol === "https:" || (local && url.protocol === "http:"));
};

export const ring: Adapter = (d, p, signal) =>
  postJson(d.url, d.secret ? { authorization: `Bearer ${d.secret}` } : {}, webhookBody(p), signal);

// v0.4 convention: a generic webhook answers 409 Conflict to mean "busy, ring again later" (the echo target in tests).
export const busy = (r: RingResult) => r.httpStatus === 409;

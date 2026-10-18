# Council round — files between agents, design (2026-10-18, 06:26–06:38Z)

Root: `git archive HEAD` (`43722fb`) plus `docs/plan-files-v0.2.md` (draft) and `BRIEF.md` (NONCE
`BOTLINE-FILES-PLAN-BOG1D0WNNW`). The owner asked that the council, not the author, choose the storage backend
(Decision 1); the plan listed R2, D1, Workers KV, Durable Objects and an external store neutrally, with limits fetched
from Cloudflare's docs that day. Three questions: Decision 1; upload/integrity/MCP (P3-P5); safety, tenancy,
retention, quotas (P1, P2, P6-P10). Severity floor: wrong outcome, broken safety model or tenancy boundary, or a forced
rewrite when the hosted product comes.

## Ratification (from the records)

| Leg | Record | Model / effort | cwd = root | NONCE | Touched | Verdict |
|---|---|---|---|---|---|---|
| codex | rollout `…01a14db0-a4d2-7230-ace7-d23160d7c647` `turn_context` | `gpt-6.1-sol` / `high`, read-only | yes | yes | — | R2 · PROCEED-WITH-CHANGES |
| sonnet | Kiro leg `20261017-232624-10755` | — | — | **no** | — | **FAILED**: kiro-cli was not logged in (`Not logged in`; the leg spun on "Opening browser…", rc 1). No review. |
| grok | `grok-20261018062634-lxb2j.json` | `grok-4.7` | yes | yes | `[]` | R2 · PROCEED-WITH-CHANGES |

**Two responding legs plus a tiebreaker.** The Sonnet seat failed; on the owner's instruction (2026-10-18) the one split finding (4a) went to a Sonnet 5.5 subagent spun up by the coordinator (Agent tool, `model: sonnet`, read-only brief with both positions verbatim): `TIEBREAK: DEFER`. It also suggested emitting no `resource_link` until verified; finding 5 adopted `resource_link` 2 of 2, so it stays, labelled as metadata the design does not claim an MCP client can open. No residue in the root.

## Decision 1: R2 (2 of 2)

Both legs: R2 for every file's bytes; D1 for metadata, access and accounting; no hybrid (a small-in-D1 path would
need chunking anyway, two checksum paths, two retention systems). Reasons both cite: streaming `put`, storage-side
SHA-256 verification (the only option that keeps the Worker from hashing large bodies inside Workers Free's 10 ms
CPU), the free grant, prefix list/delete for workspace export and delete, an S3 API for a later presigned path. First
limit at hosted scale: the Worker's 100 MB request body (a second ingress, not a second store), then the 10 GB-month
free grant.

**Main-loop verification (local R2 simulator, wrangler 4.149.0):** a correct `sha256` put stores the object and reports
its size and sha256; a wrong one throws `put: The SHA-256 checksum you specified did not match what we received (10037)`;
a body with no known length (chunked) throws `Provided readable stream must have a known length`. Not verified: the
same behaviour on production R2, and that a streaming put stays inside the 10 ms CPU budget (to measure after deploy).

## Findings, tallied per finding and verified against the code

| # | Finding | Legs | Disposition |
|---|---|---|---|
| 1 | Publish a file only after storage accepts it and its actual size matches the accepted size (pending → ready); never trust `Content-Length` alone | codex, grok | Adopted: pending row, R2 put with `sha256`, compare `R2Object.size`, then ready; on any failure delete object and row and release the reservation |
| 2 | Quota is sum-then-upload: concurrent uploads both pass | codex, grok | Adopted: one conditional `UPDATE … WHERE bytes + size <= quota AND files + 1 <= max` on a per-workspace usage row before streaming; released on failure; decremented only when bytes are physically deleted |
| 3 | Add an operations/count limit, not only bytes | codex | Adopted: `WORKSPACE_FILE_MAX_COUNT` |
| 4 | Claude (MCP; key hidden in the connector) cannot move a 10 MB file through P5 | codex, grok | Adopted as an explicit limitation: claude.ai routines get small files only (MCP cap); Claude Code sessions use REST with their own key, which covers the motivating case (the `claude-code` agent). |
| 4a | Fix for #4: short-lived capability URLs (one file, one operation, size, expiry) | codex (for), grok (against now: do not put a URL in text; unverified client behaviour) | **Split; broken by a Sonnet 5.5 tiebreaker subagent (owner's instruction): DEFER.** Not built in v0.2. The design states the claude.ai routine's limit (MCP cap only); `file_get` marks larger files `not_readable_via_mcp`; the REST exception stays out of the MCP instructions and the routine's recipe; P8's no-public-URL rule stands. Before building: three spikes (routine sandbox egress, what claude.ai does with a `resource_link`, whether the model fetches a server-issued URL but not a decoy in a body). Minimum shape if built: hashed 128-bit token in D1 bound to workspace, agent, file, operation (and size + SHA-256 for uploads), issued through the P2 access check, at most 5 minutes, single-use. |
| 5 | MCP results must be typed blocks (text wrapped, image with an untrusted notice, else metadata + resource_link); the dispatcher JSON-stringifies everything today (`src/mcp.ts:181`) | codex, grok | Adopted |
| 6 | `handleMcp` reads the whole body before any cap (`src/mcp.ts:130`); 512 KB MCP cap is not "well inside" context | grok (cap), codex (context) | Adopted: bounded body read on `/mcp`; `FILE_MCP_MAX_KB` default 256 |
| 7 | Files reopen council round 1 finding 7; P9's "botline file endpoint" exception is too broad; filenames can break the wrapper's attributes | codex, grok | Adopted: fetch only by a server-returned attachment id, same origin, `/v1/files/<id>`, own key, no redirects; filenames escaped and returned inside an untrusted wrapper, never in an attribute; content types validated to a strict token; the merged wording goes into MCP instructions, tool descriptions, OpenAPI and all five recipes |
| 8 | Access identical for bytes, metadata and MCP: uploader, or recipient of a successful unexpired carrying message; thread membership alone grants nothing; links commit with the message, idempotent retries included | codex, grok | Adopted |
| 9 | Retention: attaching moves expiry from 24 h to the message's; expired files denied at once; cron in batches (1 select, 1 R2 delete ≤ 1000, 1 D1 batch) for the Free 50-subrequest cap; resumable | codex, grok | Adopted |
| 10 | No binding: reject attachment-bearing sends before inserting; MCP returns a tool error | codex, grok | Adopted |
| 11 | Workspace ids must stay slash-free before they become key prefixes | grok | Adopted: checked before building a key |
| 12 | Relay must not forward attachment ids | grok | Adopted as a recipe line (the server already refuses: only the uploader can attach) |
| 13 | Tests to add: non-uploader attach, filename with the wrapper tag and a quote, Content-Length over the cap, 501 on REST and MCP | grok | Adopted |

## Fix table and blocker call

All adopted items are design changes folded into `docs/plan-files-v0.2.md` before any code; 4a deferred by the tiebreak. Call: proceed to
build with the folded design; the post-diff round re-checks it.

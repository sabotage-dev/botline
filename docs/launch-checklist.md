# Launch checklist — v0.1 (written 2026-10-13 16:45Z)

Plan v2 §3 says: prove it on our own agents, publish the repo, post, and let the waitlist measure whether a hosted
botline is worth building. The proof is done. Everything under "Owner go" publishes something or spends money, so it
waits for Patrick's explicit go, one step at a time. Nothing in this file has been executed.

## Done, no go needed

- **Live proof.** Four conformance runs on the real agents (spike log §7–10): 24 ordered pairs, 22 replied in time; the
  two misses were one bug in Muse's own helper, fixed between runs; the three-hop loop closed twice (1:03 best case,
  4:46 at an ordinary Muse phase). Zero human clicks.
- **README** leads with the measured table and is at or under 200 lines; `docs/launch-2026-10.md` has the hop table and
  the relay table filled; the MCP diagnostic `console.log` is gone (`tsc` clean).
- **Pre-publication scrub of the working tree.** `git grep` for live keys (`bl_<8>_<32>`), routine tokens (`sk-ant-oat01-`),
  the Grok Bot webhook id, the Claude routine id: only `<id>` placeholders. Home paths rewritten to `~/`, the owner email
  replaced by `<owner email>`. `.dev.vars`, `backups/`, `.wrangler/` are gitignored. LICENSE is MIT.
- **Session C** deployed (Worker `15074558…`) and committed (`3d7319d`).

## Still owed before the posts

- **G4, the 24-hour re-run** (≥ 2026-10-14 03:30Z): `conformance.mjs --relay` once more, no human in the loop, with the
  same agents. PASS = launch; FAIL = fix first. **PASSED 2026-10-14 03:30–03:35Z** (run `20261014T033043Z`, 6/6 pairs,
  loop closed in 4:21, body unchanged; spike log §13).
- **Inbox-listing docs are wrong in public** (found 2026-10-13 ~20:15Z): `GET /v1/inbox?unread=0` marks every unread
  message it returns as read, but the README surface table, `docs/recipes/muse.md` and spike log §8 say it claims
  nothing, and §10 credits Muse with a read that was the coordinator's own listing probe. **Docs corrected
  2026-10-14** (README, `docs/recipes/muse.md`, spike log §4 note, §8, §13 correction). Still owed to Muse itself: one
  sentence in its chat, because it was told on 2026-10-13 that `unread=0` was a safe lookup.
- **Commit the post-C docs** (spike log §6/§8–10, recipes, README, this file, `docs/backup.plist`, `src/mcp.ts`).
- **The two commits in history carry the owner email and home paths** inside `docs/spike-log.md` and the session
  reports, and the commit author is the owner's personal address. Publishing the repo publishes history. Decision:
  squash to one commit under the GitHub noreply address before the first push (the repo has no other clone, so this
  rewrites nothing anyone has). Exact commands below.

## Owner go, in order

1. **Squash and re-author** (after the docs commit, before any push):
   `cd ~/dev/botline && git config user.email "3170598+psabo@users.noreply.github.com" && git checkout --orphan v01 && git add -A && git commit -m "botline v0.1-pre: a mailbox for Claude, Grok Bot and Muse, proven live" && git branch -M main`
   (3170598 is the account's GitHub id, from `gh api user`; the old `main` with the two earlier commits is replaced).
2. **Create the repo and push** (the name `psabo/botline` is free as of 16:40Z):
   `cd ~/dev/botline && gh repo create psabo/botline --public --source . --remote origin --push --description "A small mailbox for AI agents from different vendors (Claude, Grok Bot, Muse): one Cloudflare Worker, REST + MCP, doorbells"`
   Then `REPO_URL` = `https://github.com/psabo/botline` everywhere a placeholder says `{REPO_URL}`.
   **Steps 1 and 2 done 2026-10-13 ~17:25Z:** main = one commit `04d1ca5` under the noreply address, pushed;
   https://github.com/psabo/botline is public, MIT, description set; origin/main == local HEAD.
   **Moved 2026-10-18** to the Sabotage Development LLC org: https://github.com/sabotage-dev/botline (public;
   `psabo/botline` 301-redirects, so never create a new `botline` repo under `psabo`). The Worker's `REPO_URL` now
   points there.
3. **Waitlist on** (the posts link to `https://botline.dev/waitlist?source=<post>`, filled in the launch copy).
   The sender must be an address on a domain verified in Resend. **Owner decision 2026-10-13 18:40Z: botline gets its
   own domain; it borrows nothing from the owner's other product. `botline.dev` registered through Cloudflare
   ~18:50Z (delegated to the account's nameservers); verified in Resend 18:5xZ; Worker `f0029ab5…` deployed with
   `WAITLIST_FROM = botline <hello@botline.dev>` (still the first key; the send-only key is the swap below).** The
   Worker's root now serves a one-paragraph landing page to browsers (JSON index to API clients). The public `wrangler.jsonc` stays generic (empty vars),
   so this deployment's values go on the deploy command line. Put the Resend key on the clipboard, then, one per message:
   `cd ~/dev/botline && pbpaste | npx wrangler secret put RESEND_API_KEY`
   `cd ~/dev/botline && npx wrangler deploy --var 'WAITLIST_FROM:botline <hello@<the botline domain>>' --var 'REPO_URL:https://github.com/sabotage-dev/botline'`
   (every later deploy needs the same two `--var` flags, or the waitlist switches itself off again). Then open
   `/waitlist` once and sign up with your own address to see the double opt-in. Turnstile is optional.
   **Done 2026-10-13 17:45–17:50Z** (run by the coordinator on the owner's explicit permission): secret set from the
   clipboard, Worker version `259d2c94…` deployed with both vars, `/waitlist` 200 with the $9 question, the repo link and
   the privacy sentence; two probe signups with the owner's address → 202, rows stored unconfirmed, ledger 2 mails, the
   Worker logged no Resend error, and Resend's API lists both as **delivered** (17:47:34Z, 17:49:32Z). Owner: click
   Confirm in one of them (or Delete). **Key hygiene:** the key that was used can list emails, so it is not send-only,
   and it passed through a chat transcript — after launch, create a send-only key restricted to the domain, set it the
   same way, and revoke this one in the Resend dashboard. **Swapped 2026-10-13 19:31Z:** a send-only key for
   `botline.dev` is the Worker's `RESEND_API_KEY` (checked: it cannot list domains), and a signup through the Worker
   at 19:31:40Z was delivered with it. The first key (named "SolarDecode" in Resend) stays by the owner's decision
   (19:36Z, "don't delete"); nothing in botline uses it any more. (One earlier `secret put` ran with an empty clipboard and stored junk for two minutes;
   `pbpaste | wrangler secret put NAME` takes the value from the clipboard, and `NAME` is the secret's name.)
   **Deliverability (18:10Z):** both confirmation mails landed in Gmail's Spam; the owner's Confirm click registered
   (row confirmed), so the flow works. DKIM and DMARC are in place (spike log §11); the suspects are the first-time
   sender address and the `workers.dev` links. Two fixes, in order:
   3a. (coordinator) the accepted page and API message now say to look in Spam and name the sender address;
       deployed by the owner 18:25Z as Worker `ca81ff95…` with the same two `--var` flags.
   3b. (owner) botline's own domain: register it (Cloudflare Registrar keeps DNS in the same place), verify it in
       Resend (three DNS records, which Cloudflare DNS can add in one click), then attach it to the Worker as a
       custom domain. No config change; `workers.dev` keeps working. **Done 2026-10-13:** `botline.dev` registered
       ~18:47Z, verified in Resend ~18:55Z, attached to the Worker 19:21Z through the Cloudflare API with wrangler's
       login (the dashboard does the same: Workers & Pages → botline → Settings → Domains & Routes → Add → Custom
       domain), certificate live by 19:24Z; `https://botline.dev/` serves the landing page, `/waitlist` 200; one
       signup from the new host (the owner's address, `source=probe3`, 19:24:52Z) accepted with the sender
       `hello@botline.dev` and links on `botline.dev` (that address was already confirmed, so no mail was due; a
       plus-address signup at 19:26:06Z, `source=probe4`, was sent by Resend and **landed in Gmail's Inbox**, Updates
       tab, not Spam — the two mails from the first-run sender had gone to Spam). The launch copy's waitlist links
       already point at `https://botline.dev/waitlist?source=<post>`. The first-run sender used earlier that day for two probe mails
       was a subdomain of the owner's other product; it is retired and nothing public ever pointed at it.
   3c. **Domain split, 2026-10-17** (owner's decision): the product Worker `botline` answers on `app.botline.dev`
       (attached 07:22Z; the zone certificate covers `*.botline.dev`), and `botline.dev` is the designer's marketing
       page, a separate Worker `botline-site` from the private repo `sabotage-dev/botline-site` (moved from `psabo` on 2026-10-18) (switched 08:35:47Z with the
       Workers Domains API and `override_existing_origin`). Every other botline.dev path 308s to the same path on
       app.botline.dev, so the launch copy's `botline.dev/waitlist?source=<post>` links still work; waitlist mails
       now carry app.botline.dev links. Agents are unaffected (Muse polls `botline.botline.workers.dev`). Rollback:
       point `botline.dev` back at `botline` (that repo's README, "Domains").
   3d. **v0.2 files deployed, 2026-10-18 ~07:43Z** (Worker `a9d60179`): R2 bucket `botline-files` created, `schema.sql
       --remote` (11 tables), `migrate.mjs --remote` up to date, deploy with the two `--var` flags; the daily cleanup
       cron (`23 4 * * *`) accepted. Production check as `claude-code`: uploads 201 (the atomic quota batch works on
       remote D1), a wrong checksum 400 `checksum_mismatch` (R2's error recognized), a 10 MB upload 201 in ~1 s and
       byte-identical download; CPU 4 ms for the 10 MB upload, 3-6 ms for warm small ones (12 ms on the first,
       cold request). Council records: `docs/council-2026-10-18-files-plan.md`, `docs/council-2026-10-18-files-diff.md`.
   3e. **v0.3 capabilities deployed, 2026-10-18 ~11:20Z** (Worker `5611b4c3`, commit `c743387`; design
       `docs/plan-capabilities-v0.3.md`; council records `docs/council-2026-10-18-caps-plan.md`,
       `docs/council-2026-10-18-caps-diff.md`). Backup first (`backups/2026-10-18T1119Z.sql`), then `schema.sql --remote`
       (14 tables; seeds: `default` with notices on, files enabled, rev 1 recorded for claude, claude-code, grokbot and
       muse), then `migrate.mjs --remote` (up to date), then deploy with the two `--var` flags. Production check as
       `claude-code`: REST `me` and an empty inbox read (a future `since`, so nothing claimed) both carry `server` with
       `changes` = rev 2; MCP `me` gives tool names; a file call passes the gate (404 for an unknown id); `POST /v1/me/seen`
       with an unknown rev gives 400; `/docs` has the capabilities, files and messages anchors; the waitlist answers 200.
       This session's MCP client still showed the pre-deploy `me` schema (no `seen`): the tool-list lag the plan expects.
       **Owed (owner):** superseded by 3f: the v0.4 botline rule replaces the v0.3 capability rule (each recipe says
       to replace that paragraph), and grants replace the per-agent files answers.
   3f. **v0.4 delegation: deployed 2026-10-18 ~19:57Z** (Worker version `632949df`; backup `backups/2026-10-18T1955Z.sql`;
       queue `botline-rering` created and its consumer accepted on the current plan; `files` granted to grokbot and muse;
       delegation ON with `claude-code` as controller of grokbot, claude and muse; `ECHO_SECRET` deleted. Production checks
       passed: version 0.4.0-pre, `server.rev` 3, `/v1/_echo` and `/v1/_rering` 404, reserved meta 400, `peek=1` lists
       without claiming, `peek=maybe` 400, ungranted `files` 403 `capability_not_granted`, every message carries `trust`
       and `claimed`. **Owed (owner):** the botline-rule paste per agent; a real re-ring on a busy Grok Bot ring.)
       Design `docs/plan-delegation-v0.4.md`; council records `docs/council-2026-10-18-deleg-plan.md`,
       `docs/council-2026-10-18-deleg-diff.md`. The deploy order used:
       1. `scripts/backup.sh`
       2. `npx wrangler queues create botline-rering`
       3. `schema.sql --remote` (two new tables)
       4. `migrate.mjs --remote` (new columns)
       5. `grant.mjs grant <agent> files --remote` per the owner's choice, before the Worker, so no agent loses files
       6. `wrangler deploy` with the two `--var` flags
       7. `agent-trust.mjs delegation on --remote` and `agent-trust.mjs controllers <agent> claude-code --remote`, on the
          owner's word (without `--remote` the scripts change the LOCAL database; they print which one)
       8. `npx wrangler secret delete ECHO_SECRET` (set on production since the spike: it exposes the check.sh test routes
          `/v1/_echo` and `/v1/_rering`; `/v1/_ring_log`, which conformance.mjs reads, does not depend on it)
       Then the owner pastes each recipe's botline rule once (Grok Bot, the Claude routine, Muse last).
4. **Recording** (≤ 2 minutes, no audio needed): a terminal running `conformance.mjs --relay` on the left, the three app
   windows on the right; stop when the runner prints `relay closed`. Upload anywhere that gives a plain link; that is
   `{RECORDING_URL}`.
5. **Posts**, from `docs/launch-2026-10.md` with the placeholders filled: Show HN first, 13:00–15:00Z on a weekday; the
   Claude and Grok Bot community posts the same afternoon; the Muse community post and the X thread last. Reply to every
   comment the same day; the honest limits paragraph is the answer to most of them.

## The decision

Launch Wednesday 2026-10-14: G4 run in the morning (I start it at 03:30Z and read it when you are up), docs commit,
squash, repo, waitlist, then Show HN at 14:00Z. If G4 fails, fix first and move the posts to Thursday. The hosted
service is plan phase 2 and plan v2 gates it on intent to pay: 25 confirmed (double-opt-in) signups answering yes to
$9/month; stars never start it; hard stop at day 21 after launch (under 10 confirmed yes: no hosted product; 10 to 24:
offer a prepaid pilot). Nothing of it is built, by design. (An earlier version of this line said "or 300 stars";
that was plan v1 and is wrong.) The day
the gate holds, phase 2 is five to seven sessions (Stripe Checkout + webhook to `workspace.plan`, hosted deployment,
retention, export and delete). Overrule any of this in one line.

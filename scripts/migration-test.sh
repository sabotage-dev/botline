#!/usr/bin/env bash
# The upgrade path, run for real on throwaway databases (no Worker of yours, no Cloudflare). `npm run check` runs this.
#   scripts/migration-test.sh
# Starts from the oldest schema in git (scripts/fixtures/schema-v0.1.sql, verbatim from commit 04d1ca5) with rows in it, then:
#  - migrate.mjs --check names what is missing and changes nothing;
#  - schema.sql + migrate.mjs, twice: no row lost or changed, the second run a no-op;
#  - the upgraded database matches a fresh install: same columns by name, same indexes, same CHECK constraints;
#  - doorbell-reencrypt.mjs, twice: one layer of encryption, and src/secrets.ts opens it;
#  - the deploy window: the previous release's Worker (OLD_REF) and this one both serve the migrated database;
#  - deploy.sh refuses a generic_webhook doorbell with no allowed host and a secret or malformed line in its file, and hands
#    wrangler every other line, checked on the real path against a stand-in npx.
# Requires node 24 (it imports src/secrets.ts directly), curl, jq, python3, and the OLD_REF tag.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OLD_REF=${OLD_REF:-v0.5.0-pre}; DB=botline-spike
W=$(mktemp -d); OLD=$W/old; FRESH=$W/fresh; FAILS=0; PIDS=()
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_API_TOKEN CF_ACCOUNT_ID
export XDG_CONFIG_HOME=$W/xdg CLOUDFLARE_API_BASE_URL=http://127.0.0.1:9/client/v4 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
export BOTLINE_DB=$DB
mkdir -p "$XDG_CONFIG_HOME"
cleanup() { if ((${#PIDS[@]})); then kill "${PIDS[@]}" 2>/dev/null; wait "${PIDS[@]}" 2>/dev/null; fi; rm -rf "$W"; }
trap cleanup EXIT
row() { local st=FAIL; [[ "$2" == "$3" ]] && st=PASS; [[ $st == FAIL ]] && FAILS=$((FAILS + 1)); echo "| $1 | $2 | $3 | $st |"; }
file() { npx wrangler d1 execute "$DB" --local --persist-to "$1" --file "$2" --yes >/dev/null 2>&1; }
sql() { npx wrangler d1 execute "$DB" --local --persist-to "$1" --command "$2" --yes --json 2>/dev/null | sed -n '/^\[/,$p' | jq -c '.[-1].results'; }
hash() { shasum -a 256 | cut -c1-16; }
# The columns v0.1 had, in a fixed order: this must not move through any number of upgrades.
content() {
  { sql "$1" "SELECT workspace_id, id, name, key_hash, allowed_senders, doorbell_kind, doorbell_url, doorbell_secret, created_at FROM agents ORDER BY id"
    sql "$1" "SELECT id, thread_id, hop_count, from_agent, to_agents, subject, body, needs, idempotency_key, created_at, expires_at, meta FROM messages ORDER BY id"
    sql "$1" "SELECT message_id, agent, delivered_at, read_at, acked_at FROM receipts ORDER BY message_id"
    sql "$1" "SELECT agent, last_status, last_at, fail_count FROM rings ORDER BY agent"
    sql "$1" "SELECT id, agent, kind, status, http_status, message_ids, at, detail FROM ring_log ORDER BY id"; } | hash
}
# One line per table / index: sorted columns; the index's own definition; each table's CHECK constraints.
shape() {
  python3 - "$(sql "$1" "SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE '\\_%' ESCAPE '\\' AND m.name NOT LIKE 'sqlite%'")" \
    "$(sql "$1" "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_%' ESCAPE '\\'")" <<'PY'
import json, re, sys
cols, objs = json.loads(sys.argv[1]), json.loads(sys.argv[2])
tables = {}
for r in cols: tables.setdefault(r["t"], []).append(r["c"])
for t in sorted(tables): print("table", t, ",".join(sorted(tables[t])))
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", s)).strip().replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX")
for o in sorted(objs, key=lambda o: (o["type"], o["name"])):
    if o["type"] == "index": print("index", o["name"], norm(o["sql"]))
    else: print("check", o["name"], " ".join(sorted(re.findall(r"CHECK \([^)]*\)+", norm(o["sql"])))))
PY
}

AK=bl_AAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
AH=$(printf '%s' "$AK" | shasum -a 256 | cut -d' ' -f1)
sed "s/__ALPHA_HASH__/$AH/" scripts/fixtures/seed-v0.1.sql >"$W/seed.sql"
file "$OLD" scripts/fixtures/schema-v0.1.sql; file "$OLD" "$W/seed.sql"; file "$FRESH" schema.sql
C0=$(content "$OLD")

echo "| step | expected | actual | result |"; echo "|---|---|---|---|"
BOTLINE_PERSIST_TO=$OLD node scripts/migrate.mjs --check --local >"$W/check.out" 2>&1; e=$?
row "m1 --check on a v0.1 database: exit 1, names a missing column, a table and an index, changes nothing" "1 column table index same" \
  "$e $(grep -q 'reply_to' "$W/check.out" && echo column || echo no-column) $(grep -q 'table files' "$W/check.out" && echo table || echo no-table) $(grep -q 'index ring_log_agent' "$W/check.out" && echo index || echo no-index) $([[ $(content "$OLD") == "$C0" ]] && echo same || echo changed)"

file "$OLD" schema.sql; BOTLINE_PERSIST_TO=$OLD node scripts/migrate.mjs --local >"$W/m1.out" 2>&1; e1=$?
BOTLINE_PERSIST_TO=$OLD node scripts/migrate.mjs --check --local >/dev/null 2>&1; e2=$?
row "m2 schema.sql then migrate.mjs: exit 0, --check passes, every v0.1 row and value intact" "0 0 same" "$e1 $e2 $([[ $(content "$OLD") == "$C0" ]] && echo same || echo changed)"
file "$OLD" schema.sql; BOTLINE_PERSIST_TO=$OLD node scripts/migrate.mjs --local >"$W/m2.out" 2>&1; e=$?
row "m3 the same again: a no-op, nothing duplicated" "0 up-to-date same 2 2" \
  "$e $(grep -q 'columns up to date' "$W/m2.out" && echo up-to-date || echo applied) $([[ $(content "$OLD") == "$C0" ]] && echo same || echo changed) $(sql "$OLD" "SELECT COUNT(*) AS n FROM messages" | jq '.[0].n') $(sql "$OLD" "SELECT COUNT(*) AS n FROM receipts" | jq '.[0].n')"
shape "$OLD" >"$W/shape.old"; shape "$FRESH" >"$W/shape.fresh"
diff "$W/shape.old" "$W/shape.fresh" >"$W/shape.diff"; e=$?
row "m4 upgraded and fresh databases match: columns by name, indexes, CHECKs ($(grep -c . "$W/shape.fresh") objects)" "0" "$e"
if ((e)); then cat "$W/shape.diff"; fi

MK=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
BOTLINE_PERSIST_TO=$OLD DOORBELL_MASTER_KEY=$MK node scripts/doorbell-reencrypt.mjs --local >/dev/null 2>&1; e1=$?
S1=$(sql "$OLD" "SELECT doorbell_secret AS s FROM agents WHERE id = 'beta'" | jq -r '.[0].s')
BOTLINE_PERSIST_TO=$OLD DOORBELL_MASTER_KEY=$MK node scripts/doorbell-reencrypt.mjs --local >/dev/null 2>&1; e2=$?
S2=$(sql "$OLD" "SELECT doorbell_secret AS s FROM agents WHERE id = 'beta'" | jq -r '.[0].s')
O=$(S="$S2" MK="$MK" node --input-type=module -e 'import { openSecret } from "./src/secrets.ts"; const r = await openSecret(process.env.S, process.env.MK, "default/beta"); console.log(r.ok ? r.secret : r.reason)' 2>/dev/null)
row "m5 re-encrypting twice: one layer (the second run leaves the same ciphertext), and the Worker's own code opens it" "0 0 enc same plaintext-secret" \
  "$e1 $e2 $([[ $S1 == enc:v1:* ]] && echo enc || echo plain) $([[ $S1 == "$S2" ]] && echo same || echo moved) $O"

free_ports() { node -e 'const n=require("net");(async()=>{const o=[];for(let i=0;i<4;i++){const s=n.createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));o.push(s)}console.log(o.map(s=>s.address().port).join(" "));o.forEach(s=>s.close())})()'; }
read -r P_OLD P_NEW I_OLD I_NEW <<<"$(free_ports)"
wcfg() { # wcfg SRC_DIR DEST: this tree's wrangler config, without the Queue, pointing at SRC_DIR/src/index.ts
  SRC=$1 DEST=$2 node -e 'const fs=require("fs"),{SRC,DEST}=process.env;fs.mkdirSync(require("path").dirname(DEST),{recursive:true});fs.writeFileSync(DEST,fs.readFileSync(SRC+"/wrangler.jsonc","utf8").replace(/\n  \/\/ Re-rings[\s\S]*?\n  \},/,"").replace("\"src/index.ts\"",JSON.stringify(SRC+"/src/index.ts")))'
}
worker() { # worker CONFIG PORT INSPECTOR
  npx wrangler dev --local --port "$2" --inspector-port "$3" --config "$1" --persist-to "$OLD" >"$W/w$2.log" 2>&1 &
  PIDS+=($!)
  local i; for ((i = 0; i < 90; i++)); do curl -sf -o /dev/null "http://127.0.0.1:$2/" && return 0; sleep 1; done; return 1
}
smoke() { # BASE: an old client's whole cycle against the migrated database
  local b=$1 m id
  m=$(curl -s -o /dev/null -w '%{http_code}' "$b/v1/me" -H "authorization: Bearer $AK")
  id=$(curl -s -X POST "$b/v1/send" -H "authorization: Bearer $AK" -H 'content-type: application/json' --data '{"to":["alpha"],"subject":"s","body":"b","needs":"ack"}' | jq -r .message.id)
  m="$m $(curl -s "$b/v1/inbox?unread=1" -H "authorization: Bearer $AK" | jq "[.messages[] | select(.id == \"$id\")] | length")"
  m="$m $(curl -s -o /dev/null -w '%{http_code}' -X POST "$b/v1/ack" -H "authorization: Bearer $AK" -H 'content-type: application/json' --data "{\"id\":\"$id\"}")"
  m="$m $(curl -s -o /dev/null -w '%{http_code}' "$b/v1/thread/thr_seed" -H "authorization: Bearer $AK")"
  echo "$m"
}
if git rev-parse --verify -q "$OLD_REF^{commit}" >/dev/null; then
  mkdir -p "$W/oldcode"; git archive "$OLD_REF" | tar -x -C "$W/oldcode"; ln -s "$ROOT/node_modules" "$W/oldcode/node_modules"
  wcfg "$W/oldcode" "$W/old.jsonc"; wcfg "$ROOT" "$W/new.jsonc"
  worker "$W/old.jsonc" "$P_OLD" "$I_OLD"; row "m6 the $OLD_REF Worker on the migrated database (the deploy window): me, send, inbox, ack, thread" "200 1 200 200" "$(smoke "http://127.0.0.1:$P_OLD")"
  worker "$W/new.jsonc" "$P_NEW" "$I_NEW"; row "m7 this Worker on the same database, with an old client's calls" "200 1 200 200" "$(smoke "http://127.0.0.1:$P_NEW")"
  a=$(curl -s "http://127.0.0.1:$P_NEW/v1/message/msg_seed1" -H "authorization: Bearer $AK" | jq -r '.message.receipts[0] | "\(.state) \(.later_post_at != null)"')
  row "m8 v0.1 rows read with status on this Worker: answered in the thread before reply_to existed" "awaiting_reply true" "$a"
else
  row "m6 $OLD_REF is available (fetch tags)" "yes" "no"
fi

printf 'WEBHOOK_ALLOWED_HOSTS=\nWAITLIST_FROM=\nREPO_URL=\n' >"$W/deploy-empty.env"
printf 'WEBHOOK_ALLOWED_HOSTS=relay.example.invalid\nWAITLIST_FROM=\nREPO_URL=\n' >"$W/deploy-ok.env"
printf '# a comment\n\nWEBHOOK_ALLOWED_HOSTS=relay.example.invalid\nRETENTION_DAYS=off\nMCP_ALLOWED_ORIGINS=https://a.example.invalid:8443\n' >"$W/deploy-all.env"
printf 'WEBHOOK_ALLOWED_HOSTS=relay.example.invalid\nOWNER_KEY=oops\n' >"$W/deploy-secret.env"
printf '# ok\nOWNER_KEY:synthetic-private-value\n' >"$W/deploy-bad.env"
a=$(BOTLINE_PERSIST_TO=$OLD BOTLINE_DEPLOY_ENV=$W/deploy-empty.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null); e1=$?
b=$(BOTLINE_PERSIST_TO=$OLD BOTLINE_DEPLOY_ENV=$W/deploy-ok.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null); e2=$?
c=$(BOTLINE_PERSIST_TO=$FRESH BOTLINE_DEPLOY_ENV=$W/deploy-empty.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null); e3=$?
e=$(BOTLINE_PERSIST_TO=$OLD BOTLINE_DEPLOY_ENV=$W/deploy-all.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null)
f=$(BOTLINE_PERSIST_TO=$OLD BOTLINE_DEPLOY_ENV=$W/deploy-secret.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null); e5=$?
row "m10 every line of the deploy file is passed on, so none is silently dropped; a secret in it is refused" "WEBHOOK_ALLOWED_HOSTS RETENTION_DAYS MCP_ALLOWED_ORIGINS 1 secret" \
  "$(sed -n 's/.*vars: //p' <<<"$e") $e5 $(grep -q 'OWNER_KEY is a secret' <<<"$f" && echo secret || echo no-secret)"
g=$(BOTLINE_PERSIST_TO=$OLD BOTLINE_DEPLOY_ENV=$W/deploy-bad.env scripts/deploy.sh --dry-run --local 2>&1); e6=$?
row "m11 a malformed line is refused by line number, and its contents are never printed" "1 line-2 not-printed" \
  "$e6 $(grep -q 'line 2 of' <<<"$g" && echo line-2 || echo no-line) $(grep -q 'synthetic-private-value' <<<"$g" && echo printed || echo not-printed)"
# The real path, not --dry-run: a stand-in npx runs the database calls locally and records what `wrangler deploy` would get.
mkdir -p "$W/bin"; REAL_NPX=$(command -v npx)
cat >"$W/bin/npx" <<SHIM
#!/usr/bin/env bash
if [[ \$1 == wrangler && \$2 == deploy ]]; then shift 2; printf '%s\n' "\$@" >"$W/deploy.args"; exit 0; fi
a=(); for x in "\$@"; do if [[ \$x == --remote ]]; then a+=(--local --persist-to "$OLD"); else a+=("\$x"); fi; done
exec "$REAL_NPX" "\${a[@]}"
SHIM
chmod +x "$W/bin/npx"
PATH=$W/bin:$PATH BOTLINE_DEPLOY_ENV=$W/deploy-all.env scripts/deploy.sh >/dev/null 2>&1; e7=$?
row "m12 a real deploy hands wrangler every line, values intact, colons included" \
  "0 --var,WEBHOOK_ALLOWED_HOSTS:relay.example.invalid,--var,RETENTION_DAYS:off,--var,MCP_ALLOWED_ORIGINS:https://a.example.invalid:8443" \
  "$e7 $(paste -sd, - <"$W/deploy.args" 2>/dev/null)"
sql "$FRESH" "ALTER TABLE messages DROP COLUMN reply_to" >/dev/null
d=$(BOTLINE_PERSIST_TO=$FRESH BOTLINE_DEPLOY_ENV=$W/deploy-ok.env scripts/deploy.sh --dry-run --local 2>&1 >/dev/null); e4=$?
row "m9 deploy.sh --dry-run: no allowed host for a generic_webhook: refused; listed: passes; no such doorbell: passes; schema behind: refused" "1 host 0 0 1 schema" \
  "$e1 $(grep -q 'relay.example.invalid' <<<"$a" && echo host || echo no-host) $e2 $e3 $e4 $(grep -q 'reply_to' <<<"$d" && echo schema || echo no-schema)"
echo
echo "migration test: $FAILS failed"
exit $((FAILS > 0))

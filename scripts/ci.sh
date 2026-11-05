#!/usr/bin/env bash
# `npm run check` (full) and `npm run check:quick`: the one local command, and what CI runs. Exit 0 only if every step passed.
#   scripts/ci.sh [--quick]
# Quick: the runner cannot reach Cloudflare, typecheck, schema.sql + migrate.mjs on a throwaway database.
# Full adds: an isolated Worker and its two twins (so no check.sh row is skipped), scripts/check.sh,
# scripts/conformance-selftest.sh, scripts/migration-test.sh.
# Isolation, all of it under one mktemp directory that is deleted on exit:
#  - database, R2 and Worker state (BOTLINE_PERSIST_TO); generated ECHO_SECRET and DOORBELL_MASTER_KEY; three test agents.
#  - No Cloudflare access: wrangler sees no credentials (XDG_CONFIG_HOME, CLOUDFLARE_* unset) and its API base is a dead
#    local port. Step 1 attempts a --remote read and FAILS the run if that succeeds.
#  - BOTLINE_D1_MODE is forced to --local and every base URL is 127.0.0.1. The repo's .dev.vars is not read.
# Set CHECK_ARTIFACTS=<dir> to keep the check tables (no keys, no message content). Requires node, curl, jq, python3.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
QUICK=0
case "${1:-}" in "") ;; --quick) QUICK=1 ;; *) echo "usage: scripts/ci.sh [--quick]" >&2; exit 2 ;; esac
[[ ${BOTLINE_D1_MODE:---local} == --local ]] || { echo "ci.sh is local only: unset BOTLINE_D1_MODE" >&2; exit 2; }
for c in node curl jq python3; do command -v "$c" >/dev/null || { echo "$c is required" >&2; exit 2; }; done

WORK=$(mktemp -d); PIDS=(); ROWS=(); FAILS=0; BEFORE=$(git status --porcelain)
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY
export XDG_CONFIG_HOME=$WORK/xdg CLOUDFLARE_API_BASE_URL=http://127.0.0.1:9/client/v4 WRANGLER_SEND_METRICS=false
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
export BOTLINE_PERSIST_TO=$WORK/state BOTLINE_D1_MODE=--local BOTLINE_DB=botline-spike
ECHO_SECRET=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))'); export ECHO_SECRET
DOORBELL_MASTER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'); export DOORBELL_MASTER_KEY
OWNER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'); export OWNER_KEY
mkdir -p "$XDG_CONFIG_HOME"
cleanup() {
  if ((${#PIDS[@]})); then kill "${PIDS[@]}" 2>/dev/null; wait "${PIDS[@]}" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { # step <name> <command...>: run it, keep its output in the temp dir, record the result
  local name=$1 t0=$SECONDS log rc; shift
  log="$WORK/step-$((${#ROWS[@]} + 1)).log"
  "$@" >"$log" 2>&1; rc=$?
  if ((rc == 0)); then ROWS+=("PASS $(printf '%4ss' $((SECONDS - t0))) $name")
  else
    ROWS+=("FAIL $(printf '%4ss' $((SECONDS - t0))) $name (exit $rc)"); FAILS=$((FAILS + 1))
    echo "--- $name failed; last lines:" >&2; tail -n 25 "$log" >&2
  fi
  return "$rc"
}
report() {
  printf '%s\n' "${ROWS[@]}"
  ((FAILS)) && { echo "check: $FAILS step(s) FAILED"; exit 1; }
  echo "check: all ${#ROWS[@]} steps passed"; exit 0
}

no_remote() { ! npx wrangler d1 execute "$BOTLINE_DB" --remote --command "SELECT 1" --json; }
d1file() { npx wrangler d1 execute "$BOTLINE_DB" --local --persist-to "$1" --file "$2" --yes; }
fresh_db() { d1file "$BOTLINE_PERSIST_TO" schema.sql && node scripts/migrate.mjs --local && node scripts/migrate.mjs --check --local; }

step "no Cloudflare access from this runner (a --remote read must fail)" no_remote || report
step "typecheck" npx tsc --noEmit
step "schema.sql + migrate.mjs on a throwaway database" fresh_db
if ((QUICK)); then report; fi

free_ports() { node -e 'const n=require("net");(async()=>{const o=[];for(let i=0;i<'"$1"';i++){const s=n.createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));o.push(s)}console.log(o.map(s=>s.address().port).join(" "));o.forEach(s=>s.close())})()'; }
read -r PORT TS NF IP1 IP2 IP3 <<<"$(free_ports 6)"

mkdir -p "$WORK/nofiles"
ROOT=$ROOT WORK=$WORK node -e '
const fs = require("fs"), { ROOT, WORK } = process.env;
const s = fs.readFileSync(ROOT + "/wrangler.jsonc", "utf8").replace(/\n  \/\/ Re-rings[\s\S]*?\n  \},/, "")
  .replace("\"src/index.ts\"", JSON.stringify(ROOT + "/src/index.ts"));
if (s.includes("\"queues\"")) throw new Error("wrangler.jsonc: the queues block was not removed");
fs.writeFileSync(WORK + "/check.jsonc", s);
fs.writeFileSync(WORK + "/nofiles/check.jsonc", s.replace(/"r2_buckets":.*\n/, ""));'
# WAITLIST_FROM turns the waitlist on (section 11). No RESEND_API_KEY here, so nothing is mailed: the links go to the log.
VARS="ECHO_SECRET=$ECHO_SECRET
DOORBELL_MASTER_KEY=$DOORBELL_MASTER_KEY
WEBHOOK_ALLOWED_HOSTS=127.0.0.1
WAITLIST_FROM=\"botline check <check@botline-check.invalid>\""
printf '%s\nOWNER_KEY=%s\n' "$VARS" "$OWNER_KEY" >"$WORK/.dev.vars"
printf '%s\n' "$VARS" >"$WORK/nofiles/.dev.vars"

add() { node scripts/agent-add.mjs "$1" --local 2>/dev/null | grep -oE 'bl_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}' | head -1; }
KC=$(add claude); KG=$(add grokbot); KM=$(add muse)
[[ -n $KC && -n $KG && -n $KM ]] || { ROWS+=("FAIL      test agents could not be created"); FAILS=$((FAILS + 1)); report; }

dev() { # dev <log> <port> <inspector port> <args...>
  local log=$1 port=$2 ip=$3; shift 3
  npx wrangler dev --local --port "$port" --inspector-port "$ip" "$@" >"$log" 2>&1 &
  PIDS+=($!)
}
up() { local i; for ((i = 0; i < 120; i++)); do curl -sf -o /dev/null "http://127.0.0.1:$1/" && return 0; sleep 1; done; return 1; }
# One at a time: two runtimes opening the same database at the same instant can die on SQLITE_BUSY. The first and third share one.
workers() {
  dev "$WORK/dev.log" "$PORT" "$IP1" --test-scheduled --config "$WORK/check.jsonc" --persist-to "$BOTLINE_PERSIST_TO"
  up "$PORT" || return 1
  dev "$WORK/ts.log" "$TS" "$IP2" --config "$WORK/check.jsonc" --persist-to "$WORK/ts" --var TURNSTILE_SITE_KEY:x --var TURNSTILE_SECRET:y --var OWNER_KEY:tooshort
  up "$TS" || return 1
  dev "$WORK/nf.log" "$NF" "$IP3" --test-scheduled --config "$WORK/nofiles/check.jsonc" --persist-to "$BOTLINE_PERSIST_TO" --var RETENTION_DAYS:off
  up "$NF"
}
step "three isolated Workers up" workers || { tail -n 20 "$WORK/dev.log" "$WORK/nf.log" >&2; report; }
d1file "$WORK/ts" schema.sql >/dev/null 2>&1

check() {
  BOTLINE_TURNSTILE_BASE=http://127.0.0.1:$TS BOTLINE_NOFILES_BASE=http://127.0.0.1:$NF \
    scripts/check.sh "http://127.0.0.1:$PORT" "$KC" "$KG" "$KM" | tee "$WORK/check.md"
  local rc=${PIPESTATUS[0]}
  grep -c '| PASS |' "$WORK/check.md"
  return "$rc"
}
export BOTLINE_DEV_LOG=$WORK/dev.log
selftest() { scripts/conformance-selftest.sh "http://127.0.0.1:$PORT" "$KC" "$KG" "$KM" | tee "$WORK/selftest.md"; return "${PIPESTATUS[0]}"; }
step "scripts/check.sh" check
step "scripts/conformance-selftest.sh" selftest
if [[ -x scripts/migration-test.sh ]]; then step "scripts/migration-test.sh" scripts/migration-test.sh; fi
if [[ -n ${CHECK_ARTIFACTS:-} ]]; then
  mkdir -p "$CHECK_ARTIFACTS"; cp "$WORK/check.md" "$WORK/selftest.md" "$CHECK_ARTIFACTS/" 2>/dev/null
fi
unchanged() { [[ "$(git status --porcelain)" == "$BEFORE" ]]; }
step "the checkout is unchanged by the run" unchanged
report

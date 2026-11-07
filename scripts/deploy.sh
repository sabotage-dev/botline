#!/usr/bin/env bash
# The one way to deploy a deployment with its own values.
#   scripts/deploy.sh [--dry-run] [--local] [--no-vars]      (also `npm run deploy [-- flags]`)
# wrangler.jsonc ships defaults, so a bare `wrangler deploy` puts every var back: the waitlist and every generic_webhook doorbell
# go off. This reads the deployment's values from a private file, BOTLINE_DEPLOY_ENV (default ~/.config/botline/deploy.env,
# mode 600), and passes EVERY NAME=value line in it as a var, so a line there is never silently dropped:
#   WAITLIST_FROM=botline <hello@your.domain>
#   REPO_URL=https://github.com/you/botline
#   WEBHOOK_ALLOWED_HOSTS=host.one,host.two
#   OWNER_ALERT_TO=you@your.domain
#   RETENTION_DAYS=off                   (any var in wrangler.jsonc)
# Secrets do not belong here (vars are not secret): a line naming one is refused. So is a database behind this code
# (migrate.mjs --check), and a generic_webhook doorbell whose host is not in WEBHOOK_ALLOWED_HOSTS, which would stop ringing it.
# --no-vars is for a deployment without its own values (a fresh install, or one that never needed any): no private file,
# no --var, so wrangler.jsonc's values apply. Every check still runs. It refuses if the private file exists, so a
# deployment that has one can never drop its values by accident; without it, a missing file is refused.
# The host check uses the allowlist the Worker will actually have: the file's WEBHOOK_ALLOWED_HOSTS line if it has one,
# else wrangler.jsonc's. BOTLINE_WRANGLER_CONFIG names another config (relative to the repo); it is then passed to wrangler.
# --dry-run stops after the checks and names the vars. --local checks a local database.
# This is the guarded path, not the only one: a hand-typed `npx wrangler deploy` still skips every check.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; MODE=--remote; NOVARS=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --local) MODE=--local ;; --no-vars) NOVARS=1 ;;
  *) echo "usage: scripts/deploy.sh [--dry-run] [--local] [--no-vars]" >&2; exit 2 ;; esac; done
CFG=${BOTLINE_WRANGLER_CONFIG:-wrangler.jsonc}
CFGARG=(); [[ -z ${BOTLINE_WRANGLER_CONFIG:-} ]] || CFGARG=(--config "$CFG")
[[ -r $CFG ]] || { echo "deploy.sh: no $CFG" >&2; exit 1; }
ENVF=${BOTLINE_DEPLOY_ENV:-$HOME/.config/botline/deploy.env}
if ((NOVARS)); then
  [[ ! -e $ENVF ]] || { echo "deploy.sh: --no-vars, but $ENVF exists: deploy with its values (drop --no-vars)" >&2; exit 1; }
else
  [[ -r $ENVF ]] || { echo "deploy.sh: no $ENVF (see the header of this script; a deployment without its own values: --no-vars)" >&2; exit 1; }
fi
VARS=(); NAMES=(); HOSTS=""; HAS_HOSTS=0; N=0
((NOVARS)) || while IFS= read -r line || [[ -n $line ]]; do
  N=$((N + 1))
  [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
  # The line number only: a malformed line may be a secret pasted the wrong way.
  [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || { echo "deploy.sh: line $N of $ENVF is not NAME=value" >&2; exit 1; }
  name=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
  case "$name" in OWNER_KEY | DOORBELL_MASTER_KEY | RESEND_API_KEY | TURNSTILE_SECRET | ECHO_SECRET)
    echo "deploy.sh: $name is a secret: wrangler secret put $name, not $ENVF" >&2; exit 1 ;; esac
  VARS+=(--var "$name:$value"); NAMES+=("$name")
  [[ $name != WEBHOOK_ALLOWED_HOSTS ]] || { HOSTS=$value; HAS_HOSTS=1; }
done <"$ENVF"
# No line in the file: the Worker keeps wrangler.jsonc's value, so that is the allowlist to check (comments stripped).
((HAS_HOSTS)) || HOSTS=$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8");
let o = "", q = false;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (q) { o += c; if (c === "\\") o += s[++i] ?? ""; else if (c === "\"") q = false; continue; }
  if (c === "\"") { q = true; o += c; continue; }
  if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; o += "\n"; continue; }
  if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
  o += c;
}
const v = JSON.parse(o.replace(/,(\s*[}\]])/g, "$1")).vars?.WEBHOOK_ALLOWED_HOSTS;
console.log(typeof v === "string" ? v : "");' "$CFG") || { echo "deploy.sh: cannot read vars from $CFG" >&2; exit 1; }

node scripts/migrate.mjs --check "$MODE" || { echo "deploy.sh: the database is behind this code: run schema.sql and migrate.mjs first" >&2; exit 1; }

PERSIST=(); [[ $MODE == --local && -n ${BOTLINE_PERSIST_TO:-} ]] && PERSIST=(--persist-to "$BOTLINE_PERSIST_TO")
NEED=$(npx wrangler d1 execute "${BOTLINE_DB:-botline-spike}" "$MODE" ${CFGARG[@]+"${CFGARG[@]}"} ${PERSIST[@]+"${PERSIST[@]}"} --yes --json \
  --command "SELECT doorbell_url AS u FROM agents WHERE doorbell_kind = 'generic_webhook' AND doorbell_url IS NOT NULL" 2>/dev/null \
  | sed -n '/^\[/,$p' | HOSTS=$HOSTS node -e '
const hosts = (process.env.HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).at(-1).results;
const need = [...new Set(rows.map((r) => { try { return new URL(r.u).hostname; } catch { return "(bad url)"; } }))];
console.log(need.filter((h) => !hosts.includes(h)).join(" "));') # hostnames only: a URL can carry a token
[[ -z $NEED ]] || { echo "deploy.sh: a generic_webhook doorbell rings a host not in WEBHOOK_ALLOWED_HOSTS: $NEED" >&2; exit 1; }

if ((DRY)); then echo "deploy.sh: checks passed ($MODE); vars: ${NAMES[*]:-none}" >&2; exit 0; fi
[[ $MODE == --remote ]] || { echo "deploy.sh: --local is for --dry-run" >&2; exit 2; }
exec npx wrangler deploy ${CFGARG[@]+"${CFGARG[@]}"} ${VARS[@]+"${VARS[@]}"}

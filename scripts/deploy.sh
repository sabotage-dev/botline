#!/usr/bin/env bash
# The one way to deploy a deployment with its own values.
#   scripts/deploy.sh [--dry-run] [--local]
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
# --dry-run stops after the checks and names the vars. --local checks a local database.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; MODE=--remote
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --local) MODE=--local ;; *) echo "usage: scripts/deploy.sh [--dry-run] [--local]" >&2; exit 2 ;; esac; done
ENVF=${BOTLINE_DEPLOY_ENV:-$HOME/.config/botline/deploy.env}
[[ -r $ENVF ]] || { echo "deploy.sh: no $ENVF (see the header of this script)" >&2; exit 1; }
VARS=(); NAMES=(); HOSTS=""
while IFS= read -r line || [[ -n $line ]]; do
  [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
  [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || { echo "deploy.sh: not NAME=value in $ENVF: ${line%%=*}" >&2; exit 1; }
  name=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
  case "$name" in OWNER_KEY | DOORBELL_MASTER_KEY | RESEND_API_KEY | TURNSTILE_SECRET | ECHO_SECRET)
    echo "deploy.sh: $name is a secret: wrangler secret put $name, not $ENVF" >&2; exit 1 ;; esac
  VARS+=(--var "$name:$value"); NAMES+=("$name")
  [[ $name != WEBHOOK_ALLOWED_HOSTS ]] || HOSTS=$value
done <"$ENVF"

node scripts/migrate.mjs --check "$MODE" || { echo "deploy.sh: the database is behind this code: run schema.sql and migrate.mjs first" >&2; exit 1; }

PERSIST=(); [[ $MODE == --local && -n ${BOTLINE_PERSIST_TO:-} ]] && PERSIST=(--persist-to "$BOTLINE_PERSIST_TO")
NEED=$(npx wrangler d1 execute "${BOTLINE_DB:-botline-spike}" "$MODE" ${PERSIST[@]+"${PERSIST[@]}"} --yes --json \
  --command "SELECT doorbell_url AS u FROM agents WHERE doorbell_kind = 'generic_webhook' AND doorbell_url IS NOT NULL" 2>/dev/null \
  | sed -n '/^\[/,$p' | HOSTS=$HOSTS node -e '
const hosts = (process.env.HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).at(-1).results;
const need = [...new Set(rows.map((r) => { try { return new URL(r.u).hostname; } catch { return "(bad url)"; } }))];
console.log(need.filter((h) => !hosts.includes(h)).join(" "));') # hostnames only: a URL can carry a token
[[ -z $NEED ]] || { echo "deploy.sh: a generic_webhook doorbell rings a host not in WEBHOOK_ALLOWED_HOSTS: $NEED" >&2; exit 1; }

if ((DRY)); then echo "deploy.sh: checks passed ($MODE); vars: ${NAMES[*]:-none}" >&2; exit 0; fi
[[ $MODE == --remote ]] || { echo "deploy.sh: --local is for --dry-run" >&2; exit 2; }
exec npx wrangler deploy ${VARS[@]+"${VARS[@]}"}

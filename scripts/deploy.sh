#!/usr/bin/env bash
# The one way to deploy a deployment with its own values.
#   scripts/deploy.sh [--dry-run] [--local]
# wrangler.jsonc ships empty vars, so a bare `wrangler deploy` turns the waitlist and every generic_webhook doorbell off. This
# reads the deployment's values from a private file, BOTLINE_DEPLOY_ENV (default ~/.config/botline/deploy.env, mode 600):
#   WAITLIST_FROM=botline <hello@your.domain>
#   REPO_URL=https://github.com/you/botline
#   WEBHOOK_ALLOWED_HOSTS=host.one,host.two
#   OWNER_ALERT_TO=you@your.domain       (optional)
# Before deploying it refuses a database behind this code (migrate.mjs --check), and a generic_webhook doorbell whose host is
# not in WEBHOOK_ALLOWED_HOSTS, which would stop ringing it. --dry-run stops after the checks. --local checks a local database.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; MODE=--remote
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --local) MODE=--local ;; *) echo "usage: scripts/deploy.sh [--dry-run] [--local]" >&2; exit 2 ;; esac; done
ENVF=${BOTLINE_DEPLOY_ENV:-$HOME/.config/botline/deploy.env}
[[ -r $ENVF ]] || { echo "deploy.sh: no $ENVF (see the header of this script)" >&2; exit 1; }
val() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }

node scripts/migrate.mjs --check "$MODE" || { echo "deploy.sh: the database is behind this code: run schema.sql and migrate.mjs first" >&2; exit 1; }

HOSTS=$(val WEBHOOK_ALLOWED_HOSTS)
PERSIST=(); [[ $MODE == --local && -n ${BOTLINE_PERSIST_TO:-} ]] && PERSIST=(--persist-to "$BOTLINE_PERSIST_TO")
NEED=$(npx wrangler d1 execute "${BOTLINE_DB:-botline-spike}" "$MODE" ${PERSIST[@]+"${PERSIST[@]}"} --yes --json \
  --command "SELECT doorbell_url AS u FROM agents WHERE doorbell_kind = 'generic_webhook' AND doorbell_url IS NOT NULL" 2>/dev/null \
  | sed -n '/^\[/,$p' | HOSTS=$HOSTS node -e '
const hosts = (process.env.HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).at(-1).results;
const need = [...new Set(rows.map((r) => { try { return new URL(r.u).hostname; } catch { return "(bad url)"; } }))];
console.log(need.filter((h) => !hosts.includes(h)).join(" "));') # hostnames only: a URL can carry a token
[[ -z $NEED ]] || { echo "deploy.sh: a generic_webhook doorbell rings a host not in WEBHOOK_ALLOWED_HOSTS: $NEED" >&2; exit 1; }

if ((DRY)); then echo "deploy.sh: checks passed ($MODE)" >&2; exit 0; fi
[[ $MODE == --remote ]] || { echo "deploy.sh: --local is for --dry-run" >&2; exit 2; }
exec npx wrangler deploy --var "WAITLIST_FROM:$(val WAITLIST_FROM)" --var "REPO_URL:$(val REPO_URL)" \
  --var "WEBHOOK_ALLOWED_HOSTS:$HOSTS" --var "OWNER_ALERT_TO:$(val OWNER_ALERT_TO)"

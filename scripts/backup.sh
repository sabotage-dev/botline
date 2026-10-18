#!/usr/bin/env bash
# Usage: scripts/backup.sh            (weekly; see README "Backups" for a launchd example)
# Exports the REMOTE D1 database to backups/<UTC date>.sql (mode 600, directory 700, gitignored) and, when
# BOTLINE_BACKUP_BUCKET is set, copies it to that R2 bucket as <UTC date>.sql. The dump holds the whole database:
# waitlist addresses, key hashes, encrypted doorbell secrets, message bodies and file metadata. Treat it like the
# database. It does NOT hold file bytes: those live only in the FILES R2 bucket; restoring a dump brings back file rows
# whose objects may be gone (they then answer 404 until the daily sweep removes the expired ones).
# Env: BOTLINE_DB (default botline-spike), BOTLINE_BACKUP_BUCKET (optional R2 bucket name). Needs `wrangler login`.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DB=${BOTLINE_DB:-botline-spike}
DATE=$(date -u +%Y-%m-%dT%H%MZ)
OUT="backups/$DATE.sql"
cd "$ROOT"
mkdir -p backups
chmod 700 backups
npx wrangler d1 export "$DB" --remote --output "$OUT" --skip-confirmation
chmod 600 "$OUT"
[[ -s $OUT ]] || { echo "backup: $OUT is empty" >&2; exit 1; }
echo "backup: $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)" >&2
if [[ -n ${BOTLINE_BACKUP_BUCKET:-} ]]; then
  npx wrangler r2 object put "$BOTLINE_BACKUP_BUCKET/$DATE.sql" --file "$OUT" --remote --content-type application/sql
  echo "backup: copied to r2://$BOTLINE_BACKUP_BUCKET/$DATE.sql" >&2
fi

#!/usr/bin/env bash

set -euo pipefail

readonly PROJECT_DIR="${PROJECT_DIR:-/opt/inspiration-wallet-server}"
readonly BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
readonly RETENTION_DAYS="${RETENTION_DAYS:-14}"
readonly TIMESTAMP="$(date '+%Y-%m-%d_%H%M%S')"
readonly OUTPUT="$BACKUP_DIR/inspiration_wallet_${TIMESTAMP}.sql.gz"
readonly TEMP_OUTPUT="${OUTPUT}.tmp"

fail() {
  printf '[backup] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or not in PATH.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose Plugin is not available.'
command -v gzip >/dev/null 2>&1 || fail 'gzip is not installed or not in PATH.'

cd "$PROJECT_DIR" || fail "Cannot enter $PROJECT_DIR."
[[ -f .env ]] || fail '.env is missing.'
mkdir -p "$BACKUP_DIR"

cleanup() {
  rm -f -- "$TEMP_OUTPUT"
}
trap cleanup EXIT

printf '[backup] Creating %s ...\n' "$OUTPUT"
docker compose exec -T postgres sh -c \
  'exec pg_dump --clean --if-exists --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  | gzip -9 > "$TEMP_OUTPUT"

[[ -s "$TEMP_OUTPUT" ]] || fail 'Backup output is empty.'
mv -- "$TEMP_OUTPUT" "$OUTPUT"
trap - EXIT

printf '[backup] Removing backup files older than %s days (the new backup is always preserved)...\n' "$RETENTION_DAYS"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'inspiration_wallet_*.sql.gz' \
  -mtime "+$RETENTION_DAYS" ! -path "$OUTPUT" -delete

printf '[backup] Backup completed: %s\n' "$OUTPUT"

#!/usr/bin/env bash

set -euo pipefail

readonly PROJECT_DIR="${PROJECT_DIR:-/opt/inspiration-wallet-server}"
readonly HEALTH_URL="${HEALTH_URL:-https://api.unmind.art/health}"
readonly PROMPT_SMOKE_URL="${PROMPT_SMOKE_URL:-https://api.unmind.art/v1/inspiration-space?kind=PROMPT&limit=1}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or not in PATH.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose Plugin is not available.'
command -v git >/dev/null 2>&1 || fail 'Git is not installed or not in PATH.'
command -v curl >/dev/null 2>&1 || fail 'curl is not installed or not in PATH.'

cd "$PROJECT_DIR" || fail "Cannot enter $PROJECT_DIR."
[[ -f .env ]] || fail '.env is missing. Copy .env.example to .env and replace all placeholders.'
[[ -f docker-compose.yml ]] || fail 'docker-compose.yml is missing.'
if grep -Eq '^[A-Z0-9_]+=.*CHANGE_ME' .env; then
  fail '.env still contains a CHANGE_ME placeholder.'
fi
storage_provider="$(grep -E '^[[:space:]]*STORAGE_PROVIDER[[:space:]]*=' .env | tr -d '\r' || true)"
if [[ "$storage_provider" != 'STORAGE_PROVIDER=tencent-cos' ]]; then
  fail 'Production storage must explicitly set STORAGE_PROVIDER=tencent-cos in .env.'
fi

if [[ -d .git ]] && git remote get-url origin >/dev/null 2>&1; then
  log 'Pulling the latest code with fast-forward only...'
  git pull --ff-only
else
  log 'No Git origin is configured; using the current working tree.'
fi

log 'Validating Docker Compose configuration...'
docker compose config --quiet

log 'Building the shared API/worker image...'
source_revision="$(git rev-parse HEAD 2>/dev/null || date +%s)"
docker compose build --build-arg "SOURCE_REV=$source_revision" api

log 'Ensuring immutable client engine archives are present and verified in object storage...'
if ! docker compose run --rm --no-deps api npm run client-assets:upload -- --download; then
  fail 'Client engine assets could not be verified in object storage. Deployment stopped before updating the running services.'
fi

log 'Starting PostgreSQL...'
docker compose up -d postgres

log 'Waiting for PostgreSQL health check...'
postgres_ready=false
for _ in $(seq 1 30); do
  if docker compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  sleep 2
done
if [[ "$postgres_ready" != true ]]; then
  docker compose logs --tail=100 postgres >&2 || true
  fail 'PostgreSQL did not become healthy within 60 seconds. Deployment stopped; no volume was removed.'
fi

log 'Applying pending Prisma migrations exactly once...'
if ! docker compose run --rm --no-deps api npm run prisma:migrate:deploy; then
  docker compose logs --tail=100 postgres >&2 || true
  fail 'Prisma migration failed. API and Caddy were not updated; database data and volumes were preserved.'
fi

log 'Starting or updating API, worker, and Caddy...'
docker compose up -d api worker caddy

log 'Reloading Caddy configuration...'
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

log 'Current service state:'
docker compose ps

log "Checking $HEALTH_URL ..."
if ! curl --fail --silent --show-error --retry 8 --retry-delay 3 --retry-all-errors "$HEALTH_URL"; then
  printf '\n' >&2
  docker compose logs --tail=150 api worker caddy >&2 || true
  fail 'Public health check failed. Inspect the logs above; no data or volume was deleted.'
fi
printf '\n'
log 'Checking prompt-sharing API support...'
if ! curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-all-errors "$PROMPT_SMOKE_URL" >/dev/null; then
  docker compose logs --tail=150 api caddy >&2 || true
  fail 'Prompt-sharing API smoke check failed. Confirm the PROMPT enum migration was applied.'
fi
log 'Deployment workflow completed and the public health check passed.'

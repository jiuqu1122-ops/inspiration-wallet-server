# Repository workflow instructions

## Trigger: “给我部署代码”

When the user says “给我部署代码” for this repository, treat it as a deployment handoff request, not a request for a ZIP archive.

1. Fetch `origin`, confirm the current branch is the latest `main`, and preserve unrelated working-tree changes.
2. Run the relevant typecheck, lint, tests, and build.
3. Commit only the requested files and push `main` to `origin`.
4. Wait for the GitHub Actions workflow `Build backend image` for that commit to succeed. The 2 GiB production server must pull the prebuilt immutable `sha-*` image and must never build the backend locally.
5. Do not SSH to or mutate production unless the user separately and explicitly asks for production deployment.
6. Do not provide deployment commands while the workflow is queued, running, or failed. A failed validation/build must be fixed and pushed first.
7. Return one directly executable root-server command block, adjusted only if the checked-in deployment scripts change:

```bash
set -euo pipefail
cd /opt/inspiration-wallet-server
git status --short
chmod +x scripts/deploy.sh scripts/backup-postgres.sh
./scripts/backup-postgres.sh
git pull --ff-only origin main
expected_sha="$(git rev-parse HEAD)"
PROJECT_DIR=/opt/inspiration-wallet-server ./scripts/deploy.sh
api_id="$(docker compose ps -q api)"
worker_id="$(docker compose ps -q worker)"
test "$(docker inspect --format '{{.Config.Image}}' "$api_id")" = "ghcr.io/jiuqu1122-ops/inspiration-wallet-server:sha-$expected_sha"
test "$(docker inspect --format '{{.Config.Image}}' "$worker_id")" = "ghcr.io/jiuqu1122-ops/inspiration-wallet-server:sha-$expected_sha"
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

The deployment script derives `BACKEND_IMAGE=ghcr.io/jiuqu1122-ops/inspiration-wallet-server:sha-<current Git SHA>` after pulling. It must export that value so an old `BACKEND_IMAGE` entry in production `.env` cannot select a stale or local image. Treat any `Building the shared API/worker image locally`, `npm run build`, or `tsc -p tsconfig.json` output on production as a deployment bug and stop it; on this 2 GiB host it caused memory pressure and monitoring data loss.

The production `.env` and its keys already live under `/opt/inspiration-wallet-server` for the root deployment. Never print, replace, upload, commit, or recreate that file. Preserve server-local files such as a modified `Caddyfile` or untracked `Caddyfile.bak`; do not reset or delete them. `git pull --ff-only` must stop safely if a local tracked edit overlaps an incoming change. Never run `docker compose build` on production. Never use `docker compose down -v`, `prisma migrate reset`, or `prisma db push` in this workflow.

When a release also changes `unmind-website`, deploy and verify this backend first, then deploy the website. Do not run both deployments concurrently on the 2 GiB server.

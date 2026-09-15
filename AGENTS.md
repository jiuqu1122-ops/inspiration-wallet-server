# Repository workflow instructions

## Trigger: “给我部署代码”

When the user says “给我部署代码” for this repository, treat it as a deployment handoff request, not a request for a ZIP archive.

1. Fetch `origin`, confirm the current branch is the latest `main`, and preserve unrelated working-tree changes.
2. Run the relevant typecheck, lint, tests, and build.
3. Commit only the requested files and push `main` to `origin`.
4. Do not SSH to or mutate production unless the user separately and explicitly asks for production deployment.
5. Return the following root-server command block, adjusted only if the checked-in deployment scripts change:

```bash
cd /opt/inspiration-wallet-server
git status --short
chmod +x scripts/deploy.sh scripts/backup-postgres.sh
./scripts/backup-postgres.sh
git pull --ff-only origin main
PROJECT_DIR=/opt/inspiration-wallet-server ./scripts/deploy.sh
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

The production `.env` and its keys already live under `/opt/inspiration-wallet-server` for the root deployment. Never print, replace, upload, commit, or recreate that file. Never use `docker compose down -v`, `prisma migrate reset`, or `prisma db push` in this workflow.

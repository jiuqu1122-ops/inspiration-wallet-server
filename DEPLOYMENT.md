# inspiration-wallet-server 生产部署手册

本文用于在 Ubuntu 24.04 LTS 上部署 `https://api.unmind.art`。生产服务由 `api`、`worker`、`postgres`、`caddy` 四个容器组成。PostgreSQL、API 和 worker 没有宿主机端口映射，公网只开放 SSH、HTTP 和 HTTPS。

本文不会修改 `www.unmind.art`。DNS 正确也不代表 HTTPS 已生效；Caddy 运行且公网 80/443 可达后，才会自动申请证书。

## 1. 上线前检查

确认域名解析到目标服务器公网 IPv4：

```bash
dig +short A api.unmind.art
# 未安装 dig 时：
nslookup api.unmind.art
curl -4 https://ifconfig.me
```

前两条得到的地址必须与服务器公网 IPv4 一致。若使用云厂商安全组，还要同时放行 TCP 22、80、443 和 UDP 443；不要放行 3000、5432。

## 2. 安装 Docker Engine、Compose Plugin 和 Git

以下采用 Docker 官方 APT 仓库，不使用面向开发环境的便捷安装脚本：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw dnsutils
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

注销并重新登录，让 `docker` 用户组生效，然后验证：

```bash
docker --version
docker compose version
docker run --rm hello-world
```

将用户加入 `docker` 组等同于授予高权限，只应加入可信的运维用户。

## 3. 防火墙

启用 UFW 前确认当前 SSH 端口确实是 22；如果不是，应先放行实际 SSH 端口，避免锁在服务器外。

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status verbose
```

Docker 发布端口可能绕过部分 UFW 规则，因此真正的保障是 Compose 根本不发布 3000/5432。部署后仍需用 `ss` 和外部端口扫描复核。

## 4. 克隆仓库

把 `<仓库地址>` 替换为真实 Git 地址：

```bash
sudo mkdir -p /opt/inspiration-wallet-server
sudo chown -R "$USER":"$USER" /opt/inspiration-wallet-server
git clone <仓库地址> /opt/inspiration-wallet-server
cd /opt/inspiration-wallet-server
```

若该目录不是空目录，应先人工确认内容，不要覆盖生产数据或现有配置。

## 5. 创建生产环境变量

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32        # 适合作为 POSTGRES_PASSWORD，也无需 URL 编码
openssl rand -base64 64     # 生成 JWT_ACCESS_SECRET
openssl rand -base64 64     # 再执行一次，生成不同的 JWT_REFRESH_SECRET
openssl rand -base64 32     # 生成渠道凭据加密主密钥，仅首次配置一次
nano .env
```

必须填写或核对：

- `NODE_ENV=production`
- `HOST=0.0.0.0`、`PORT=3000`
- `APP_BASE_URL=https://api.unmind.art`
- `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`
- `DATABASE_URL`：必须与上面三项一致，主机名保持 `postgres`。若密码不是十六进制安全字符，必须在 URL 中百分号编码。
- `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`：至少 32 字符、随机生成且彼此不同。
- `JWT_ACCESS_EXPIRES_IN=15m`、`JWT_REFRESH_EXPIRES_IN=30d`
- `LICENSE_SIGNING_PUBLIC_KEY`：当前灵感抽屉 License 签发方的 32 字节 Ed25519 公钥（Base64）。这是公开验证材料，不是私钥；轮换签发密钥时必须先安排兼容升级。
- `LICENSE_SIGNING_PRIVATE_KEY`：与上面公钥匹配的 32 字节 Ed25519 私钥种子（Base64），用于服务器签发邮箱账户的设备 License。只能保存在服务器权限为 `600` 的 `.env` 和离线密码库中，禁止写入 Git、数据库、日志或客户端。
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM`：用于发送邮箱验证码。`465` 通常对应 `SMTP_SECURE=true`，`587` 通常对应 `false`；以邮件服务商说明为准。生产上线前必须用真实邮箱完成一次收信测试。
- `EMAIL_CODE_TTL_MINUTES`：验证码有效分钟数，允许 5 到 30，默认 10。
- `AGENT_REQUEST_CREDITS`：每次钱包 Agent 请求的服务端预扣与结算额度，当前固定配置为 `10`；生产 `.env` 必须显式设置为 `10`，客户端无权覆盖。
- `IMAGE_REQUEST_CREDITS`：未列入内置价格表的模型所使用的每张默认额度，必须是正整数；Nano Banana Pro、Nano Banana 2、GPT Image 2 和 GPT Image 2 H 按代码中的模型与清晰度价格表计费。
- `VIDEO_REQUEST_CREDITS`：每个钱包视频任务的预扣与结算额度，必须是正整数；默认测试值为 `500`，请求数量大于 1 时按数量倍增。
- `AI_WORKER_CONCURRENCY`：单个 worker 同时执行的任务数，默认 2；可横向增加 worker 容器，数据库条件更新会防止重复领取。
- `AI_TASK_POLL_INTERVAL_MS`、`AI_TASK_HEARTBEAT_INTERVAL_MS`：worker 取任务与心跳间隔。
- `AI_TASK_STALE_AFTER_MS`、`AI_TASK_MAX_RUNTIME_MS`：失联 worker 判定和单任务总时限。前者必须明显大于心跳间隔。
- `AI_TASK_RETENTION_DAYS`：完成、失败和取消任务的保留天数。
- `AI_UPSTREAM_CONNECT_TIMEOUT_MS`、`AI_UPSTREAM_IDLE_TIMEOUT_MS`：上游连接建立与流读取空闲超时。
- `WORKER_HEALTH_FILE`：容器内 liveness 文件路径，通常保持默认值。
- `ADMIN_API_KEY_HASH`：私有运营工作台管理员密钥的 SHA-256 哈希；原始管理员密钥只放密码管理器。
- `PROVIDER_SECRETS_ENCRYPTION_KEY`：Base64 编码的 32 字节随机主密钥，用于 AES-256-GCM 加密上游渠道凭据。必须长期备份且不能随意轮换。
- `CORS_ALLOWED_ORIGINS`：逗号分隔的精确来源。未确认 Tauri 实际 Origin 前保持为空，浏览器跨域请求将被拒绝；原生无 Origin 请求仍可访问。
- `CADDY_ACME_EMAIL`：证书申请联系邮箱。

不要把 NewAPI、XAIS 的 API Key 写入 `.env`；部署完成后从私有授权工作台提交，由后端加密保存。确认 `.env` 未被 Git 跟踪：

```bash
git check-ignore -v .env
git status --short
```

## 6. 首次部署

先验证配置和镜像构建，再单独启动数据库、执行一次迁移，最后启动 API、worker 和 Caddy：

```bash
cd /opt/inspiration-wallet-server
docker compose config --quiet
docker compose build api
docker compose up -d postgres
docker compose ps

docker compose run --rm --no-deps api npm run prisma:migrate:deploy
docker compose up -d api worker caddy
docker compose ps
```

迁移失败时立即停止部署，保留错误输出；不要执行 `prisma migrate reset`、`prisma db push`、`docker compose down -v` 或删除 Volume。API 容器不会在每次启动时自动迁移，避免以后多个 API 副本并发迁移。

也可以在仓库已配置 Git remote 后运行标准脚本：

```bash
chmod +x scripts/deploy.sh scripts/backup-postgres.sh
PROJECT_DIR=/opt/inspiration-wallet-server ./scripts/deploy.sh
```

脚本使用 `git pull --ff-only`、构建镜像、等待数据库、单独迁移、更新服务并检查公网健康状态；失败不会删除数据库或 Volume。

## 7. 上线验证

```bash
docker compose ps
curl -i https://api.unmind.art/health
curl -i https://api.unmind.art/v1
curl -I http://api.unmind.art/health
openssl s_client -connect api.unmind.art:443 -servername api.unmind.art </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
sudo ss -lntup
```

预期健康检查为 HTTP 200，并返回：

```json
{"status":"ok","database":"ok"}
```

HTTP 请求应跳转到 HTTPS。`ss` 不应显示宿主机监听 `0.0.0.0:3000` 或 `0.0.0.0:5432`；只应看到预期的 22、80、443。还应从另一台机器扫描公网 IP，确认 3000/5432 无法连接。

检查镜像中没有 `.env`：

```bash
docker compose run --rm --no-deps api sh -c \
  'test ! -e /app/.env && echo ".env is not in the image"'
```

## 8. 日志与故障排查

```bash
docker compose logs -f --tail=200 api
docker compose logs -f --tail=200 worker
docker compose logs -f --tail=200 postgres
docker compose logs -f --tail=200 caddy
docker compose logs --since=30m api worker caddy
```

应用会脱敏 Authorization、Cookie、密码、Token、License、API Key 和数据库连接等字段；生产错误响应不返回堆栈。上线后仍需抽查日志，确认没有 JWT Secret、数据库密码、上游 Key、Authorization Header 或用户私密大请求体。

常见问题：

- Caddy 证书失败：检查 DNS、云安全组、UFW、80/443 占用和 Caddy 日志。
- `/health` 返回 503：检查 PostgreSQL 健康状态和 `DATABASE_URL`，不要重置数据库。
- API 启动失败：检查 Secret 长度、两个 Secret 是否相同、是否仍为 `CHANGE_ME`。
- 验证码发送返回 503：检查 SMTP 主机、端口、安全模式、授权码和发件人；不要把 SMTP 密码打印到日志或截图。
- Agent 返回 `provider_unavailable`：在运营工作台的“渠道管理”中确认至少有一个启用的 LLM 渠道，并填写默认 Agent 模型；留空时需确保上游 `/v1/models` 可访问。
- Agent 返回 `insufficient_credits`：检查用户钱包可用额度或生成并兑换额度兑换码，不要直接修改数据库余额。
- CORS 被拒绝：捕获客户端的真实 Origin，只把确认过的精确值加入 `CORS_ALLOWED_ORIGINS`。

## 9. 标准更新流程

更新前先备份数据库：

```bash
cd /opt/inspiration-wallet-server
./scripts/backup-postgres.sh
git status --short
git pull --ff-only
docker compose build api
docker compose up -d postgres
docker compose run --rm --no-deps api npm run prisma:migrate:deploy
docker compose up -d api worker caddy
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

也可直接使用 `./scripts/deploy.sh`。先构建再迁移可缩短停机；数据库结构变更仍应采用向后兼容的 expand/contract 迁移，确保新旧 API 在滚动窗口内都能工作。

## 10. 代码回滚

代码回滚前检查旧版是否兼容已经执行的数据库迁移，并先备份：

```bash
cd /opt/inspiration-wallet-server
./scripts/backup-postgres.sh
git log --oneline --decorate -20
git status --short
git switch --detach <稳定提交哈希>
docker compose build api
docker compose up -d api worker
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

恢复到主分支：

```bash
git switch main
```

Prisma 不会自动安全回滚已执行的生产迁移。不要自动运行反向 SQL。数据库结构回滚必须先审查迁移内容，再创建人工修复迁移；极端情况下从已验证备份恢复。

## 11. PostgreSQL 备份

手动执行：

```bash
cd /opt/inspiration-wallet-server
chmod +x scripts/backup-postgres.sh
./scripts/backup-postgres.sh
ls -lh backups/
gzip -t backups/inspiration_wallet_*.sql.gz
```

脚本使用 `pg_dump`，生成 `backups/inspiration_wallet_YYYY-MM-DD_HHMMSS.sql.gz`，成功创建新备份后删除超过 14 天的旧备份。建议把备份加密复制到独立对象存储，并定期在隔离数据库中演练恢复；仅存放在同一台服务器不算可靠灾备。

每天 03:20 自动备份的 cron 示例：

```bash
crontab -e
20 3 * * * PROJECT_DIR=/opt/inspiration-wallet-server /opt/inspiration-wallet-server/scripts/backup-postgres.sh >> /var/log/inspiration-wallet-backup.log 2>&1
```

## 12. PostgreSQL 恢复（仅人工执行）

**恢复会删除或覆盖目标数据库中的现有对象和数据。执行前必须再创建一份新备份，并确认恢复文件完整。不要把恢复写进自动部署脚本。**

```bash
cd /opt/inspiration-wallet-server
./scripts/backup-postgres.sh
gzip -t backups/<需要恢复的备份>.sql.gz

gunzip -c backups/<需要恢复的备份>.sql.gz \
  | docker compose exec -T postgres sh -c \
      'psql -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"'

docker compose up -d api worker caddy
curl --fail --show-error https://api.unmind.art/health
```

恢复前应停止写流量或进入维护窗口；恢复后检查业务数据、迁移表 `_prisma_migrations` 和 API 日志。

## 13. 长期维护建议

- 每周检查磁盘、容器重启次数、数据库连接与证书续期日志。
- 为 `/health` 和真实业务探针配置外部监控告警，但不要把健康响应扩展为内部配置泄露。
- 定期在测试环境升级 Node 22 patch、PostgreSQL 17 patch、Caddy 2.10 patch 和 npm 依赖，再部署生产。
- 每次结构变更提交 Prisma migration，生产只运行 `prisma migrate deploy`。
- 当前任务队列使用 PostgreSQL 并由独立 worker 执行；worker 可以单独扩容，但不能让任一副本自动执行 migration。任务吞吐量显著增长后再评估 Redis/BullMQ。
- 数据库凭据或 JWT Secret 泄露时立即轮换。轮换 JWT Secret 会使对应现有 Token 失效，应安排兼容窗口。

## 14. 邮箱账户升级与人工加额度

本次升级会增加邮箱账户、验证码挑战、统一高级版权益字段，并把数据库内旧 `TRIAL` / `PRO` License 标记升级为 `ENTERPRISE`。迁移不会删除现有钱包、流水或旧 License；部署前仍必须先备份：

```bash
cd /opt/inspiration-wallet-server
./scripts/backup-postgres.sh
git pull --ff-only
docker compose build api
docker compose up -d postgres
docker compose run --rm --no-deps api npm run prisma:migrate:deploy
docker compose up -d api worker caddy
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

不要重新生成服务器现有的 JWT Secret，否则现有会话会全部失效。也不要替换 `PROVIDER_SECRETS_ENCRYPTION_KEY`，否则已保存的上游凭据无法解密。`LICENSE_SIGNING_PRIVATE_KEY` 是邮箱账户设备授权签发所需的服务器 Secret；它必须与 `LICENSE_SIGNING_PUBLIC_KEY` 匹配，并且绝不能进入 Git 仓库、数据库、日志或客户端安装包。部署新版本前先补齐 SMTP 配置，否则客户端无法收到验证码。

用户完成一次 License 交换后，可以通过 `GET /v1/account` 得到用户 ID。管理员只在服务器上执行人工加额度：

```bash
docker compose run --rm --no-deps api \
  npm run credits:grant -- \
  --user=<用户ID> \
  --amount=10000 \
  --description="Initial grant"
```

命令成功会输出用户 ID、增加额度、最新余额和流水 ID，不输出任何凭据。加错额度时不要直接修改数据库；应新增经过审计的反向 `ADJUSTMENT` 工具后再处理。

Docker 安装命令依据 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)；Compose 使用官方推荐的 [Docker Compose Plugin](https://docs.docker.com/compose/install/linux/)。

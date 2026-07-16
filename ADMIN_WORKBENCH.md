# 授权与额度工作台接入

独立 Tauri 工作台通过 `https://api.unmind.art/v1/admin` 管理授权用户和钱包。管理员密钥只用于内部运营，不应发给客户，也不能写进 Git、Docker 镜像或前端代码。

## 1. 首次生成管理员密钥

在服务器交互式终端执行：

```bash
ADMIN_API_KEY="$(openssl rand -hex 32)"
ADMIN_API_KEY_HASH="$(printf '%s' "$ADMIN_API_KEY" | sha256sum | awk '{print $1}')"

printf '原始管理员密钥（只显示这一次，请存入密码管理器）：\n%s\n' "$ADMIN_API_KEY"
printf '写入服务器 .env 的哈希：\n%s\n' "$ADMIN_API_KEY_HASH"
```

把第二段哈希写入生产 `.env`：

```env
ADMIN_API_KEY_HASH=<64位小写SHA-256十六进制哈希>
```

原始 `ADMIN_API_KEY` 只保存到可信密码管理器，用于在工作台每次启动时临时登录。不要把原始值写入服务器 `.env`。退出当前终端前执行：

```bash
unset ADMIN_API_KEY ADMIN_API_KEY_HASH
```

## 2. 部署支持管理 API 的版本

先备份，再迁移和更新：

```bash
cd /opt/inspiration-wallet-server
./scripts/backup-postgres.sh
git pull --ff-only
docker compose build api
docker compose up -d postgres
docker compose run --rm --no-deps api npm run prisma:migrate:deploy
docker compose up -d api caddy
docker compose ps
curl --fail --show-error https://api.unmind.art/health
```

这次迁移新增：

- `License.customer`：仅供管理员按客户标签检索；
- `AdminOperation`：保存操作类型、幂等键、目标用户、额度、说明和结果快照；
- 不删除或重置既有用户、钱包、流水和会话。

## 3. 安全边界

- `ADMIN_API_KEY_HASH` 留空时，所有管理接口返回 `503 admin_api_disabled`。
- 原始密钥通过 `Authorization: Bearer ...` 提交，服务端仅做 SHA-256 后的常量时间比较。
- 日志配置会脱敏 Authorization Header，不记录管理员密钥。
- 管理接口有独立限流；额度发放需要唯一幂等键。
- 发放事务同时更新钱包、写 `WalletLedger` 并写 `AdminOperation`，任一步失败都会回滚。
- 工作台固定访问 `https://api.unmind.art`，不会接受用户指定的任意 URL。

## 4. 当前管理接口

```text
GET  /v1/admin/overview
GET  /v1/admin/users
GET  /v1/admin/users/:userId
POST /v1/admin/licenses/provision
POST /v1/admin/users/:userId/credits/grant
```

客户端不应调用这些接口；它们只供你的私有 Tauri 运营工作台使用。

## 5. 密钥轮换

生成一枚新的原始管理员密钥和哈希，更新生产 `.env` 后重新创建 API 容器：

```bash
docker compose up -d --force-recreate api
curl --fail --show-error https://api.unmind.art/health
```

旧工作台会话的后续请求立即失效。JWT Secret 和 License 签发密钥不需要随管理员密钥一起更换。

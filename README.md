# inspiration-wallet-server

灵感抽屉的统一账户与 AI 额度后端。当前版本已经实现与桌面端现有 Ed25519 License 格式兼容的登录、可轮换 JWT 会话、账户/钱包查询、额度流水查询，以及仅限服务器执行的人工加额度命令；真实 LLM、图片、视频渠道和支付仍未接入。

## 技术栈

- Node.js 22、TypeScript、Fastify
- Prisma 6、PostgreSQL 17
- Ed25519 License、JWT、Zod
- Docker Compose、Caddy

## 安全边界

- License 交换会验证 Ed25519 签名、产品名、机器 ID 和到期日。
- 数据库只保存 License 与机器 ID 的单向哈希，不保存 License 原文、客户字段或旧版 `ai_access.api_key`。
- Access Token 与 Refresh Token 使用不同密钥；Refresh Token 只以哈希形式保存，并在刷新时单次轮换。
- 所有受保护接口都会检查会话、用户与 License 当前状态。
- 钱包金额使用 `BigInt`，API 以十进制字符串返回，避免浮点误差。

## 本地开发

本地开发需要 Node.js 22 和可访问的 PostgreSQL。`.env.example` 中的主机名 `postgres` 用于 Docker；如果 PostgreSQL 运行在本机，请把本地 `.env` 的 `DATABASE_URL` 主机名改为 `localhost`。

```bash
nvm use
npm install
cp .env.example .env
# 编辑 .env，替换所有 CHANGE_ME，并配置本地 DATABASE_URL
npm run prisma:migrate:dev
npm run dev
```

常用检查：

```bash
npm run prisma:generate
npm test
npm run typecheck
npm run lint
npm run build
```

## API

### License 换取会话

`POST /v1/auth/license/exchange`

```json
{
  "license": "{\"payload\":\"...\",\"signature\":\"...\"}",
  "machineId": "64 位十六进制机器 ID",
  "appVersion": "1.0.0"
}
```

成功后返回 Access Token、Refresh Token 和安全的账户快照。`license` 是现有 `license.json` 的完整文本，不是文件路径。首次使用会原子创建用户和钱包；同一机器续签新 License 会继续使用原账户。

### 会话操作

- `POST /v1/auth/refresh`：请求体为 `{ "refreshToken": "..." }`，旧 Refresh Token 成功使用后立即失效。
- `POST /v1/auth/logout`：请求体同上，幂等撤销当前 Refresh Token，成功返回 `204`。
- `GET /v1/account`：请求头使用 `Authorization: Bearer <accessToken>`，返回当前用户、License 和钱包。

### 钱包

- `GET /v1/wallet/transactions?limit=50&cursor=...`：需要 Access Token，按游标分页返回额度流水。
- 钱包数值均返回字符串，例如 `"availableCredits": "10000"`。
- 客户端没有“直接扣款”或“直接加款”接口。后续 AI 接口必须由服务器计算价格并在事务中预扣/结算。

### 基础接口

- `GET /health`：真实探测数据库；正常返回 `200`，数据库不可用返回 `503`。
- `GET /v1`：服务信息。

## 服务器人工加额度

先从 `GET /v1/account` 获取用户 ID，再只在服务器项目目录执行：

```bash
docker compose run --rm --no-deps api \
  npm run credits:grant -- \
  --user=<用户ID> \
  --amount=10000 \
  --description="Initial grant"
```

该命令会在一个数据库事务中增加可用额度与累计赠送额度，并写入 `GRANT` 流水。`amount` 必须是正整数；不要把这个命令暴露成客户端 API。

生产部署、升级迁移、备份、恢复和回滚参见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

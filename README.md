# inspiration-wallet-server

灵感抽屉的统一账户与 AI 额度后端。当前版本已经实现与桌面端现有 Ed25519 License 格式兼容的登录、可轮换 JWT 会话、账户/钱包查询、额度流水查询、邮箱验证码注册，以及供私有 Tauri 运营工作台使用的注册用户管理、兑换码、幂等额度发放和 NewAPI/XAIS 加密渠道管理。Agent 钱包模式已经接入 LLM 代理；图片、视频计费代理和支付仍未接入。

## 技术栈

- Node.js 22、TypeScript、Fastify
- Prisma 6、PostgreSQL 17
- Ed25519 License、JWT、Zod
- Docker Compose、Caddy

## 安全边界

- License 交换会验证 Ed25519 签名、产品名、机器 ID 和到期日。
- 数据库只保存 License 与机器 ID 的单向哈希，不保存 License 原文或旧版 `ai_access.api_key`；运营工作台注册的授权会保存客户显示标签，便于管理员检索。
- Access Token 与 Refresh Token 使用不同密钥；Refresh Token 只以哈希形式保存，并在刷新时单次轮换。
- 所有受保护接口都会检查会话、用户与 License 当前状态。
- 钱包金额使用 `BigInt`，API 以十进制字符串返回，避免浮点误差。
- 上游渠道 API Key 与自定义 Header 使用独立主密钥做 AES-256-GCM 加密，接口只返回密钥末四位。
- 渠道 Base URL 默认使用公网 HTTPS；管理员可为确实没有 TLS 的单条渠道显式开启不安全 HTTP。连接测试前仍会解析 DNS 并拒绝本机和私网地址。

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

### 邮箱验证码注册 / 登录

先请求验证码：`POST /v1/auth/email/send-code`

```json
{
  "email": "designer@example.com"
}
```

再验证并登录：`POST /v1/auth/email/verify`

```json
{
  "email": "designer@example.com",
  "challengeId": "验证码挑战 ID",
  "code": "123456",
  "machineId": "64 位十六进制机器 ID",
  "displayName": "张三设计",
  "legacyLicense": "可选：本机旧版 License 完整文本",
  "appVersion": "4.6.13"
}
```

新邮箱首次验证会获得 30 天高级版，邮箱是账户身份；同一邮箱换设备时继承原账户到期时间，不会重新计算 30 天。机器 ID 只用于当前设备授权和识别本机旧授权。旧版试用版、专业版和高级版在新系统中统一按高级版处理。验证码只保存 HMAC 哈希且单次使用；邮件由通用 SMTP 配置发送。

服务器签发的设备 License 会在客户端启动时通过 `POST /v1/auth/email/sync` 同步管理员修改后的用户名、账户状态和到期日。网络暂时不可用时客户端继续验证本地签名 License；服务器明确返回停用或过期时会清除本机云端 License。

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
- `POST /v1/wallet/redeem`：需要 Access Token，提交一次性或多次可用的额度兑换码。
- 钱包数值均返回字符串，例如 `"availableCredits": "10000"`。
- 客户端没有“直接扣款”或“直接加款”接口。AI 接口由服务器计算价格并在事务中预扣、结算或释放。

### Agent 钱包模式

`POST /v1/ai/chat/completions` 需要 Access Token，接受 `clientRequestId`、`messages` 和可选 `tools`，服务器从已启用的 LLM 渠道中选择一个上游，按 `AGENT_REQUEST_CREDITS` 预扣 额度，成功后结算，失败自动释放。渠道可以在私有工作台中设置默认 Agent 模型；留空时服务器会从上游 `/v1/models` 自动选择首个模型。上游 API Key 永远不会返回给客户端。

### 基础接口

- `GET /health`：真实探测数据库；正常返回 `200`，数据库不可用返回 `503`。
- `GET /v1`：服务信息。

## 管理员额度工作台

`/v1/admin` 只供私有 Tauri 工作台使用。服务器仅保存管理员密钥的 SHA-256 哈希；工作台可以管理注册用户的显示名、状态、授权到期日和钱包，所有账户统一为高级版。工作台还可以生成额度兑换码、查看兑换记录，创建、更新、启停和测试 NewAPI/XAIS 渠道，并设置默认 Agent 模型；永远无法读取已保存的完整 API Key。

桌面端已有的本地 API 配置不会上传或迁移到服务器，仍由用户电脑本地保存并可用于查询本地 XAIS 余额。钱包 Agent 请求才会使用服务器渠道和云端额度；用户的上游密钥不会离开本机。

完整密钥生成、生产配置、迁移和轮换步骤见 [ADMIN_WORKBENCH.md](./ADMIN_WORKBENCH.md)。

## 服务器应急人工加额度

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

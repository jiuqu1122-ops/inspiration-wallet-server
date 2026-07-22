# inspiration-wallet-server

灵感抽屉的统一账户与 AI 额度后端。当前版本已经实现与桌面端现有 Ed25519 License 格式兼容的登录、可轮换 JWT 会话、账户/钱包查询、额度流水查询、邮箱验证码注册，以及供私有 Tauri 运营工作台使用的注册用户管理、兑换码、幂等额度发放和 NewAPI/XAIS 加密渠道管理。钱包模式已经接入 Agent LLM、图片生成和视频任务代理；支付仍未接入。

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
# 另开一个终端
npm run dev:worker
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

Agent 与灵感分析使用 PostgreSQL 持久化异步任务。`POST /v1/ai/tasks` 接受 `type`、`requestId` 和 `payload`，立即返回 HTTP 202 与 `taskId`；`GET /v1/ai/tasks/:taskId` 查询进度和最终结果，`DELETE /v1/ai/tasks/:taskId` 取消任务。相同用户、类型和 `requestId` 会返回原任务，桌面端断线或重启后可以继续查询。兼容入口 `POST /v1/ai/chat/completions` 和 `POST /v1/ai/inspirations/analyze` 也只负责入队，不再等待模型完成。

独立 `worker` 进程从数据库安全领取任务，持续更新心跳、阶段和进度。上游仍使用 `stream: true`，但由 worker 按分片增量解析 SSE 并聚合最终 JSON；桌面端每 2 秒轮询任务，成功后继续使用旧版 `content/toolCalls/finishReason` 处理逻辑。每次 Agent 请求由服务端按 `AGENT_REQUEST_CREDITS=10` 预扣，成功后结算，失败或取消后释放；客户端不提交也不能覆盖扣费额度。画布工具仍在桌面端执行，服务器不会执行或重放有副作用的工具调用。

生产必须同时启动 API 和 worker：

```bash
npm run start
npm run start:worker
```

`POST /v1/ai/images/generations` 需要 Access Token，接受客户端幂等 ID、渠道类型、模型、提示词、参考图、比例、分辨率、格式和数量。服务器只会选择已启用、声明 `IMAGE` 能力且未同时声明 `LLM` 能力的同类 NewAPI/XAIS 生图渠道；具体模型优先使用客户端节点本次选择的模型，管理器中的渠道默认模型只在客户端未指定时兜底。服务端会把主程序的 Nano Banana Pro、Nano Banana 2、GPT Image 2 显示名或旧别名归一化为标准 NewAPI 模型 ID，其他自定义模型保持原样。NewAPI 生图固定调用 `/v1/chat/completions`。生图按模型族与清晰度定价：Nano Banana Pro 2K/4K 为 18/20，Nano Banana 2 2K/4K 为 15/18，GPT Image 2 1K/2K/4K 为 10/15/18，GPT Image 2 H 2K/4K 为 30/35；未列入价格表的模型使用 `IMAGE_REQUEST_CREDITS`。服务按单价乘请求数量预扣，成功后按实际返回图片数结算，少返回的部分自动退回，失败则释放全部预扣额度。上游 API Key 只在服务器解密和使用。

`POST /v1/ai/videos` 与 `GET /v1/ai/videos/:taskId` 需要 Access Token。创建视频任务时服务器会选择已启用且声明 `VIDEO` 能力的 NewAPI/XAIS 渠道，按 `VIDEO_REQUEST_CREDITS × 请求数量` 预扣，创建上游任务成功后结算，创建失败自动释放；客户端轮询到上游明确失败状态时，服务端会按原请求 ID 一次性退款，重复轮询不会重复退款。客户端只轮询本服务，不接触上游地址或 API Key。

### 基础接口

- `GET /health`：真实探测数据库；正常返回 `200`，数据库不可用返回 `503`。
- `GET /v1`：服务信息。

## 管理员额度工作台

`/v1/admin` 只供私有 Tauri 工作台使用。服务器仅保存管理员密钥的 SHA-256 哈希；工作台可以管理注册用户的显示名、状态、授权到期日和钱包，所有账户统一为高级版。工作台还可以生成额度兑换码、查看兑换记录，创建、更新、启停和测试 NewAPI/XAIS 渠道，并设置默认 Agent 模型；永远无法读取已保存的完整 API Key。

桌面端已有的本地 API 配置不会上传或迁移到服务器，仍由用户电脑本地保存并可用于查询本地 XAIS 余额。登录云账户后，画布图片和视频默认通过服务器渠道和授权钱包；没有云账户时继续使用原有本地 API 模式。用户的上游密钥不会离开本机，服务器渠道密钥只保存在服务器的加密存储中。

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

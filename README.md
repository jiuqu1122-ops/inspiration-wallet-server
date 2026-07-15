# inspiration-wallet-server

灵感抽屉的统一后端基础项目。当前版本提供生产级服务骨架、PostgreSQL 数据模型、JWT 鉴权框架、健康检查，以及 Docker/Caddy 部署配置；尚未接入真实 License 验证、AI 渠道或支付。

## 技术栈

- Node.js 22、TypeScript、Fastify
- Prisma 6、PostgreSQL 17
- JWT、Zod
- Docker Compose、Caddy

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
npm run typecheck
npm run lint
npm run build
```

## 已有接口

- `GET /health`：真实探测数据库；正常返回 `200`，数据库不可用返回 `503`。
- `GET /v1`：服务信息。
- `POST /v1/auth/license/exchange`：限流接口骨架；验证规范接入前固定返回 `501`。
- `GET /v1/account`：需要 Access Token，返回用户和钱包安全字段。

生产部署、备份、恢复和回滚参见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

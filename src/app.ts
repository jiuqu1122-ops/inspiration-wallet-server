import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { env } from './config/env.js';
import { loggerOptions } from './config/logger.js';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { accountRoutes } from './modules/users/routes.js';
import { walletRoutes } from './modules/wallets/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { inspirationSpaceRoutes } from './modules/inspiration-space/routes.js';
import { mobileRoutes } from './modules/mobile/routes.js';
import { membershipRoutes, referralAliasRoutes } from './modules/membership/routes.js';
import { adminAuthPlugin } from './plugins/admin-auth.js';
import { jwtPlugin } from './plugins/jwt.js';
import { prismaPlugin } from './plugins/prisma.js';

export async function buildApp() {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024,
    requestTimeout: 5 * 60 * 1_000,
    // Image generation handlers can legitimately stay silent for minutes while
    // the upstream model works. Caddy and the client enforce bounded timeouts.
    connectionTimeout: 0,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    global: true,
  });

  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, env.corsAllowedOrigins.includes(origin));
    },
  });

  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    errorResponseBuilder: (_request, context) => {
      const error = new Error('Too many requests; try again later') as FastifyError & {
        code: string;
      };
      error.code = 'rate_limit_exceeded';
      error.statusCode = context.statusCode;
      return error;
    },
  });

  await app.register(prismaPlugin);
  await app.register(jwtPlugin);
  await app.register(adminAuthPlugin);
  await app.register(healthRoutes);

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ error: 'not_found', message: 'Route not found' });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error(
      {
        requestId: request.id,
        code: error.code ?? 'INTERNAL_ERROR',
        method: request.method,
        path: request.url,
      },
      'Request failed',
    );

    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: 'Too many requests; try again later',
      });
    }
    await reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
      message: statusCode >= 500 ? 'An unexpected error occurred' : error.message,
    });
  });

  await app.register(
    async (v1) => {
      v1.get('/', async () => ({
        name: 'inspiration-wallet-server',
        status: 'running',
      }));
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(accountRoutes);
      await v1.register(walletRoutes, { prefix: '/wallet' });
      await v1.register(aiRoutes, { prefix: '/ai' });
      await v1.register(inspirationSpaceRoutes, { prefix: '/inspiration-space' });
      await v1.register(mobileRoutes, { prefix: '/mobile' });
      await v1.register(membershipRoutes, { prefix: '/membership' });
      await v1.register(referralAliasRoutes, { prefix: '/referrals' });
      await v1.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/v1' },
  );

  return app;
}

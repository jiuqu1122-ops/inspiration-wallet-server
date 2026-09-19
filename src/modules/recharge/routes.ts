import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  consumeRechargeSession,
  createRechargeSession,
  RechargeSessionError,
} from './session.js';

const consumeSchema = z.object({
  session: z.string().trim().min(32).max(256),
}).strict();

export const rechargeRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/session',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 12, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const session = await createRechargeSession(app.prisma, {
        userId: request.user.sub,
        pageUrl: env.RECHARGE_PAGE_URL,
        ttlMinutes: env.RECHARGE_SESSION_TTL_MINUTES,
      });
      return reply.header('cache-control', 'no-store').send(session);
    },
  );

  app.post(
    '/session/consume',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = consumeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: '充值会话格式无效',
        });
      }
      try {
        return await consumeRechargeSession(app.prisma, { token: parsed.data.session });
      } catch (error) {
        if (error instanceof RechargeSessionError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
};

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { redeemCredits, RedemptionError } from './redemption.js';

const transactionsQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const usageQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

const redemptionSchema = z.object({
  code: z.string().trim().min(10).max(64),
}).strict();

export const walletRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/redeem',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = redemptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: '兑换码格式不正确',
        });
      }
      try {
        return await redeemCredits(app.prisma, {
          userId: request.user.sub,
          code: parsed.data.code,
        });
      } catch (error) {
        if (error instanceof RedemptionError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    '/transactions',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = transactionsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: 'Transaction query is invalid',
        });
      }

      const { cursor, limit } = parsed.data;
      const entries = await app.prisma.walletLedger.findMany({
        where: { userId: request.user.sub },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          requestId: true,
          type: true,
          amount: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
        },
      });

      const hasMore = entries.length > limit;
      const page = hasMore ? entries.slice(0, limit) : entries;
      return {
        items: page.map((entry) => ({
          ...entry,
          amount: entry.amount.toString(),
          balanceAfter: entry.balanceAfter.toString(),
        })),
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      };
    },
  );

  app.get(
    '/usage',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = usageQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: 'Usage query is invalid',
        });
      }

      const { cursor, limit } = parsed.data;
      const entries = await app.prisma.walletLedger.findMany({
        where: {
          userId: request.user.sub,
          type: 'CHARGE',
          amount: { not: 0n },
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          requestId: true,
          type: true,
          amount: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
        },
      });

      const hasMore = entries.length > limit;
      const page = hasMore ? entries.slice(0, limit) : entries;
      return {
        items: page.map((entry) => ({
          ...entry,
          amount: entry.amount.toString(),
          balanceAfter: entry.balanceAfter.toString(),
        })),
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      };
    },
  );
};

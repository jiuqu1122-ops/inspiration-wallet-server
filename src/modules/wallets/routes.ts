import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const transactionsQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const walletRoutes: FastifyPluginAsync = async (app) => {
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
};

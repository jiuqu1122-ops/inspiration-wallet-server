import type { FastifyPluginAsync } from 'fastify';
import { serializeWalletBalance } from '../wallets/serialization.js';

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/account',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.user.sub },
        select: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          wallet: {
            select: {
              availableCredits: true,
              reservedCredits: true,
              lifetimeGranted: true,
              lifetimeConsumed: true,
            },
          },
        },
      });

      if (!user) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'Account not found',
        });
      }

      return {
        ...user,
        wallet: user.wallet ? serializeWalletBalance(user.wallet) : null,
      };
    },
  );
};

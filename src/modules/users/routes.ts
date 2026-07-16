import type { FastifyPluginAsync } from 'fastify';
import { getAccountSnapshot } from './service.js';

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/account',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const account = await getAccountSnapshot(
        app.prisma,
        request.user.sub,
        request.user.licenseId,
      );
      if (!account) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'Account not found',
        });
      }
      return account;
    },
  );
};

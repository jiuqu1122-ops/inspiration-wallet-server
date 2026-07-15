import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      request.log.error({ requestId: request.id }, 'Health check database probe failed');
      return reply.code(503).send({
        status: 'error',
        database: 'unavailable',
      });
    }
  });
};

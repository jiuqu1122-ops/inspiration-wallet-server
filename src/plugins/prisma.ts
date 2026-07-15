import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';

export const prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient({
    log: app.initialConfig.disableRequestLogging
      ? ['error']
      : [{ emit: 'event', level: 'error' }],
  });

  app.decorate('prisma', prisma);

  prisma.$on('error', (event) => {
    app.log.error({ target: event.target }, 'Prisma database error');
  });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});

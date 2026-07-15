import type { PrismaClient } from '@prisma/client';
import '@fastify/jwt';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    authenticateAccessToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      tokenType: 'access' | 'refresh';
    };
    user: {
      sub: string;
      tokenType: 'access' | 'refresh';
    };
  }
}

export {};

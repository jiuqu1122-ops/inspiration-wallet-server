import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';

export const jwtPlugin = fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      algorithm: 'HS256',
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      iss: env.APP_BASE_URL,
      aud: 'inspiration-drawer',
    },
    verify: {
      allowedIss: env.APP_BASE_URL,
      allowedAud: 'inspiration-drawer',
      algorithms: ['HS256'],
    },
  });

  app.decorate('authenticateAccessToken', async (request, reply) => {
    try {
      await request.jwtVerify();
      if (request.user.tokenType !== 'access') {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'A valid access token is required',
        });
      }
    } catch {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'A valid access token is required',
      });
    }
  });
});

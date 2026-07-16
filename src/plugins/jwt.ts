import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { env } from '../config/env.js';

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  tokenType: z.literal('access'),
  sessionId: z.string().uuid(),
  licenseId: z.string().min(1),
});

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
    let claims: z.infer<typeof accessClaimsSchema>;
    try {
      await request.jwtVerify();
      claims = accessClaimsSchema.parse(request.user);
    } catch {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'A valid access token is required',
      });
    }

    const now = new Date();
    const session = await app.prisma.authSession.findUnique({
      where: { id: claims.sessionId },
      select: {
        userId: true,
        licenseId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { status: true } },
        license: { select: { status: true, expiresAt: true } },
      },
    });

    const invalidSession =
      !session ||
      session.userId !== claims.sub ||
      session.licenseId !== claims.licenseId ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE' ||
      session.license.status !== 'ACTIVE' ||
      (session.license.expiresAt !== null && session.license.expiresAt < now);

    if (invalidSession) {
      return reply.code(401).send({
        error: 'session_invalid',
        message: 'The session is no longer valid',
      });
    }
  });
});

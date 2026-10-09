import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { FastifyRequest } from 'fastify';

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  tokenType: z.literal('access'),
  sessionId: z.string().uuid(),
  licenseId: z.string().min(1).optional(),
});

function verificationRejection(error: unknown): string {
  if (error instanceof z.ZodError) return 'claims_invalid';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'FST_JWT_NO_AUTHORIZATION_IN_HEADER': return 'authorization_missing';
    case 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED': return 'token_expired';
    case 'FST_JWT_BAD_REQUEST': return 'authorization_format_invalid';
    case 'FST_JWT_AUTHORIZATION_TOKEN_INVALID': return 'token_verification_failed';
    case 'FST_JWT_AUTHORIZATION_TOKEN_UNTRUSTED': return 'token_untrusted';
    case 'FAST_JWT_MISSING_SIGNATURE': return 'token_unsigned';
    default: return 'verification_failed';
  }
}

function recordAuthRejection(request: FastifyRequest, category: string) {
  const version = request.headers['x-client-version'];
  request.log.warn({
    event: 'access_token_rejected', requestId: request.id, category,
    clientVersion: typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : null,
  }, 'Access token rejected');
}

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
    } catch (error) {
      recordAuthRejection(request, verificationRejection(error));
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
      (claims.licenseId !== undefined && session.licenseId !== claims.licenseId) ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE' ||
      (session.license !== null && (session.license.status !== 'ACTIVE' ||
        (session.license.expiresAt !== null && session.license.expiresAt < now)));

    if (invalidSession) {
      const category = !session ? 'session_missing'
        : session.userId !== claims.sub || (claims.licenseId !== undefined && session.licenseId !== claims.licenseId) ? 'session_identity_mismatch'
          : session.revokedAt !== null ? 'session_revoked'
            : session.expiresAt <= now ? 'session_expired'
              : session.user.status !== 'ACTIVE' ? 'account_inactive'
                : 'license_inactive_or_expired';
      recordAuthRejection(request, category);
      return reply.code(401).send({
        error: 'session_invalid',
        message: 'The session is no longer valid',
      });
    }
  });
});

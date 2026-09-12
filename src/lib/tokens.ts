import type { FastifyInstance } from 'fastify';
import { createSigner, createVerifier } from 'fast-jwt';
import { z } from 'zod';
import { env } from '../config/env.js';

const signRefreshToken = createSigner({
  key: env.JWT_REFRESH_SECRET,
  algorithm: 'HS256',
  expiresIn: durationToMilliseconds(env.JWT_REFRESH_EXPIRES_IN),
  iss: env.APP_BASE_URL,
  aud: 'inspiration-drawer',
});

const verifyRefreshJwt = createVerifier({
  key: env.JWT_REFRESH_SECRET,
  algorithms: ['HS256'],
  allowedIss: env.APP_BASE_URL,
  allowedAud: 'inspiration-drawer',
});

const refreshPayloadSchema = z.object({
  sub: z.string().min(1),
  tokenType: z.literal('refresh'),
  sessionId: z.string().uuid(),
  licenseId: z.string().min(1).optional(),
});

export function durationToMilliseconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error('Invalid token duration');
  }
  const amount = Number(match[1]);
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return amount * multipliers[match[2] as keyof typeof multipliers];
}

export function createTokenPair(
  app: FastifyInstance,
  userId: string,
  sessionId: string,
  licenseId?: string | null,
) {
  const claims = { sub: userId, sessionId, ...(licenseId ? { licenseId } : {}) };
  const accessToken = app.jwt.sign({ ...claims, tokenType: 'access' });
  const refreshToken = signRefreshToken({ ...claims, tokenType: 'refresh' });
  return { accessToken, refreshToken };
}

export function verifyRefreshToken(token: string) {
  return refreshPayloadSchema.parse(verifyRefreshJwt(token));
}

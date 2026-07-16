import { createHash, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';

export function adminKeyMatches(expectedHash: string, candidate: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || candidate.length < 32 || candidate.length > 512) {
    return false;
  }
  const actualHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedBytes = Buffer.from(expectedHash, 'hex');
  return expectedBytes.length === actualHash.length && timingSafeEqual(expectedBytes, actualHash);
}

export const adminAuthPlugin = fp(async (app) => {
  app.decorate('authenticateAdmin', async (request, reply) => {
    if (!env.ADMIN_API_KEY_HASH) {
      await reply.code(503).send({
        error: 'admin_api_disabled',
        message: 'Administrator API is not configured',
      });
      return;
    }

    const authorization = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const candidate = match?.[1]?.trim();
    if (!candidate || !adminKeyMatches(env.ADMIN_API_KEY_HASH, candidate)) {
      request.log.warn({ requestId: request.id }, 'Administrator authentication rejected');
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Administrator credential is invalid',
      });
    }
  });
});

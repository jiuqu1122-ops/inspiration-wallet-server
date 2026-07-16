import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LicenseVerificationError } from './license-verifier.js';
import {
  AuthFlowError,
  exchangeLicense,
  revokeRefreshToken,
  rotateRefreshToken,
} from './service.js';
import { requestEmailCode, syncEmailLicense, verifyEmailCode } from './email-auth.js';

const exchangeBodySchema = z
  .object({
    license: z.string().min(1).max(350_000),
    machineId: z.string().regex(/^[a-fA-F0-9]{64}$/),
    appVersion: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(1).max(16_384),
  })
  .strict();

const emailCodeRequestSchema = z
  .object({
    email: z.string().trim().email().max(254),
  })
  .strict();

const emailCodeVerifySchema = z
  .object({
    email: z.string().trim().email().max(254),
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
    machineId: z.string().regex(/^[a-fA-F0-9]{64}$/),
    displayName: z.string().trim().min(2).max(32).optional(),
    legacyLicense: z.string().min(1).max(350_000).optional(),
    appVersion: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

function invalidRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

function sendKnownAuthError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof LicenseVerificationError) {
    const statusCode = error.code === 'malformed_license' ? 400 : error.code === 'expired' ? 403 : 401;
    request.log.info({ code: error.code }, 'License exchange rejected');
    return reply.code(statusCode).send({ error: error.code, message: error.message });
  }
  if (error instanceof AuthFlowError) {
    request.log.info({ code: error.code }, 'Authentication request rejected');
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/email/send-code',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = emailCodeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A valid email address is required');
      }
      try {
        return await requestEmailCode(app, parsed.data.email);
      } catch (error) {
        return sendKnownAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/email/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = emailCodeVerifySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'Email verification data is invalid');
      }
      try {
        return await verifyEmailCode(app, parsed.data);
      } catch (error) {
        return sendKnownAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/email/sync',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = exchangeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A signed license and matching machineId are required');
      }
      try {
        return await syncEmailLicense(app, parsed.data);
      } catch (error) {
        return sendKnownAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/license/exchange',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = exchangeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A signed license and matching machineId are required');
      }
      try {
        return await exchangeLicense(app, parsed.data);
      } catch (error) {
        return sendKnownAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/refresh',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = refreshBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A refreshToken is required');
      }
      try {
        return await rotateRefreshToken(app, parsed.data.refreshToken);
      } catch (error) {
        return sendKnownAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/logout',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = refreshBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A refreshToken is required');
      }
      await revokeRefreshToken(app, parsed.data.refreshToken);
      return reply.code(204).send();
    },
  );
};

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LicenseVerificationError } from './license-verifier.js';
import {
  AuthFlowError,
  exchangeLicense,
  registerTrial,
  revokeRefreshToken,
  rotateRefreshToken,
} from './service.js';

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

const trialRegistrationBodySchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    machineId: z.string().regex(/^[a-fA-F0-9]{64}$/),
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
    '/trial/register',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const parsed = trialRegistrationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidRequest(reply, 'A 2-32 character displayName and valid machineId are required');
      }
      try {
        return await registerTrial(app, parsed.data);
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

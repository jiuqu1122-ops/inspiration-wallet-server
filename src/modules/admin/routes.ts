import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LicenseVerificationError } from '../auth/license-verifier.js';
import {
  AdminServiceError,
  getAdminOverview,
  getAdminUser,
  grantAdminCredits,
  listAdminUsers,
  provisionAdminLicense,
} from './service.js';
import { providerAdminRoutes } from '../providers/routes.js';

const listUsersSchema = z.object({
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const userParamsSchema = z.object({ userId: z.string().min(1).max(64) });
const operationKeySchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/);

const provisionSchema = z
  .object({
    license: z.string().min(1).max(350_000),
    idempotencyKey: operationKeySchema,
  })
  .strict();

const grantSchema = z
  .object({
    amount: z.string().regex(/^[1-9]\d{0,15}$/),
    description: z.string().trim().min(3).max(500),
    idempotencyKey: operationKeySchema,
  })
  .strict();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticateAdmin);

  await app.register(providerAdminRoutes, { prefix: '/providers' });

  app.get(
    '/overview',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => getAdminOverview(app.prisma),
  );

  app.get('/users', async (request, reply) => {
    const parsed = listUsersSchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, 'User query is invalid');
    return listAdminUsers(app.prisma, parsed.data);
  });

  app.get('/users/:userId', async (request, reply) => {
    const parsed = userParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'User ID is invalid');
    const user = await getAdminUser(app.prisma, parsed.data.userId);
    if (!user) return reply.code(404).send({ error: 'not_found', message: 'User not found' });
    return user;
  });

  app.post(
    '/licenses/provision',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = provisionSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, 'Signed license or idempotency key is invalid');
      try {
        return await provisionAdminLicense(app, parsed.data);
      } catch (error) {
        if (error instanceof LicenseVerificationError) {
          return reply.code(error.code === 'expired' ? 403 : 400).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    '/users/:userId/credits/grant',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = userParamsSchema.safeParse(request.params);
      const body = grantSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalid(reply, 'Credit grant is invalid');
      }
      try {
        return await grantAdminCredits(app.prisma, {
          userId: params.data.userId,
          amount: BigInt(body.data.amount),
          description: body.data.description,
          idempotencyKey: body.data.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof AdminServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
};

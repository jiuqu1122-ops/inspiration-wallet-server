import { usageDiagnosticsRoutes } from './usage-diagnostics-routes.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { LicenseVerificationError } from '../auth/license-verifier.js';
import {
  AdminServiceError,
  getAdminOverview,
  getAdminUsage,
  getAdminTodayUsage,
  getAdminUser,
  grantAdminCredits,
  listAdminUsers,
  provisionAdminLicense,
  updateAdminAuthorization,
} from './service.js';
import { providerAdminRoutes } from '../providers/routes.js';
import { createRedemptionCodes, listRedemptionCodes } from '../wallets/redemption.js';
import { inspirationSpaceAdminRoutes } from '../inspiration-space/admin-routes.js';
import { aiModelAdminRoutes } from '../ai/model-admin-routes.js';
import {
  createMembershipPlan,
  extendMembership,
  grantMembership,
  listMembershipPlansAdmin,
  listReferralRules,
  ReferralServiceError,
  revokeMembership,
  updateMembershipPlan,
  upsertReferralRule,
} from '../membership/service.js';

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

const authorizationUpdateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(32).optional(),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
    idempotencyKey: operationKeySchema,
  })
  .strict()
  .refine(
    (value) => value.displayName !== undefined || value.expiresAt !== undefined || value.status !== undefined,
  );

const createRedemptionCodesSchema = z.object({
  credits: z.string().regex(/^[1-9]\d{0,15}$/),
  quantity: z.number().int().min(1).max(100).default(1),
  maxRedemptions: z.number().int().min(1).max(10_000).default(1),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
}).strict();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticateAdmin);
  await app.register(usageDiagnosticsRoutes);

  await app.register(providerAdminRoutes, { prefix: '/providers' });
  await app.register(inspirationSpaceAdminRoutes, { prefix: '/inspiration-space' });
  await app.register(aiModelAdminRoutes, { prefix: '/ai-models' });

const membershipQuotaSchema = z.object({
  type: z.enum(['IMAGE_COUNT', 'LLM_TOKENS']),
  canonicalModelId: z.string().trim().min(1).max(64),
  period: z.enum(['DAILY', 'MONTHLY']),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const membershipFreeQuotaSchema = z.object({
  quotas: z.array(membershipQuotaSchema).max(100),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.quotas.forEach((quota, index) => {
    const key = `${quota.type}:${quota.canonicalModelId}:${quota.period}`;
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['quotas', index],
        message: 'Membership quota entries must be unique',
      });
    }
    seen.add(key);
  });
});

const membershipPlanCreateSchema = z.object({
  code: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  prices: z.record(z.string(), z.unknown()),
  freeQuota: membershipFreeQuotaSchema.nullable().optional(),
}).strict();
const membershipPlanUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  prices: z.record(z.string(), z.unknown()).optional(),
  freeQuota: membershipFreeQuotaSchema.nullable().optional(),
}).strict();
const membershipGrantSchema = z.object({
  planId: z.string().min(1).max(64),
  days: z.number().int().min(1).max(3650),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
const membershipExtendSchema = z.object({
  days: z.number().int().min(1).max(3650),
  planId: z.string().min(1).max(64).optional(),
}).strict();
const referralRuleSchema = z.object({
  eventType: z.string().trim().min(2).max(64),
  inviterCredits: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  inviteeCredits: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  minRecharge: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional(),
  active: z.boolean().optional(),
}).strict();

  app.get('/membership/plans', async () => ({ items: await listMembershipPlansAdmin(app.prisma) }));

  app.post('/membership/plans', async (request, reply) => {
    const parsed = membershipPlanCreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Membership plan data is invalid');
    try {
      const plan = await createMembershipPlan(app.prisma, {
        ...parsed.data,
        prices: parsed.data.prices as Prisma.InputJsonValue,
        freeQuota: parsed.data.freeQuota,
      });
      return reply.code(201).send(plan);
    } catch (error) {
      if (error instanceof ReferralServiceError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.patch('/membership/plans/:planId', async (request, reply) => {
    const params = z.object({ planId: z.string().min(1).max(64) }).safeParse(request.params);
    const parsed = membershipPlanUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply, 'Membership plan data is invalid');
    try {
      return await updateMembershipPlan(app.prisma, params.data.planId, {
        ...parsed.data,
        prices: parsed.data.prices as Prisma.InputJsonValue | undefined,
        freeQuota: parsed.data.freeQuota,
      });
    } catch (error) {
      if (error instanceof ReferralServiceError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.get('/referral-rules', async () => ({ items: await listReferralRules(app.prisma) }));
  app.patch('/referral-rules', async (request, reply) => {
    const parsed = referralRuleSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Referral rule data is invalid');
    return upsertReferralRule(app.prisma, parsed.data);
  });

  app.get('/redemption-codes', async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .safeParse(request.query);
    if (!parsed.success) return invalid(reply, 'Redemption code query is invalid');
    return { items: await listRedemptionCodes(app.prisma, parsed.data.limit) };
  });

  app.post(
    '/redemption-codes',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = createRedemptionCodesSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, 'Redemption code data is invalid');
      const codes = await createRedemptionCodes(app.prisma, {
        credits: BigInt(parsed.data.credits),
        quantity: parsed.data.quantity,
        maxRedemptions: parsed.data.maxRedemptions,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        note: parsed.data.note ?? null,
      });
      return reply.code(201).send({
        credits: parsed.data.credits,
        maxRedemptions: parsed.data.maxRedemptions,
        codes,
        warning: 'Plaintext codes are returned only in this response. Store them securely.',
      });
    },
  );

  app.get(
    '/overview',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => getAdminOverview(app.prisma),
  );

  app.get(
    '/usage/today',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => getAdminTodayUsage(app.prisma),
  );

  app.get(
    '/usage',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({
        days: z.coerce.number().int().min(1).max(30).default(1),
      }).strict().safeParse(request.query);
      if (!parsed.success) return invalid(reply, 'Usage range must be between 1 and 30 days');
      return getAdminUsage(app.prisma, parsed.data.days);
    },
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

  app.post('/users/:userId/membership/grant', async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    const body = membershipGrantSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Membership grant is invalid');
    try {
      return await grantMembership(app.prisma, { userId: params.data.userId, ...body.data });
    } catch (error) {
      if (error instanceof ReferralServiceError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post('/users/:userId/membership/extend', async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    const body = membershipExtendSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Membership extension is invalid');
    try {
      return await extendMembership(app.prisma, { userId: params.data.userId, ...body.data });
    } catch (error) {
      if (error instanceof ReferralServiceError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post('/users/:userId/membership/revoke', async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'User ID is invalid');
    return revokeMembership(app.prisma, params.data.userId);
  });

  app.patch(
    '/users/:userId/authorization',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = userParamsSchema.safeParse(request.params);
      const body = authorizationUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalid(reply, 'Authorization update is invalid');
      }
      try {
        return await updateAdminAuthorization(app.prisma, {
          userId: params.data.userId,
          ...body.data,
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

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
  updateAdminAuthorization,
} from './service.js';
import { providerAdminRoutes } from '../providers/routes.js';
import { createRedemptionCodes, listRedemptionCodes } from '../wallets/redemption.js';
import {
  aiPricingModelToken,
  getAiPricingConfig,
  updateAiPricingConfig,
} from '../ai/pricing.js';
import {
  chatPricingModelToken,
  getChatPricingConfig,
  updateChatPricingConfig,
} from '../ai/chat-pricing.js';
import { inspirationSpaceAdminRoutes } from '../inspiration-space/admin-routes.js';

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

const pricingCreditsSchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,6})$/)
  .refine((value) => BigInt(value) <= 1_000_000n, 'Credits must not exceed 1000000');
const imageModelPriceSchema = z.object({
  model: z.string().trim().min(1).max(200),
  credits1k: pricingCreditsSchema.optional(),
  credits2k: pricingCreditsSchema,
  credits4k: pricingCreditsSchema,
}).strict();
const videoModelPriceSchema = z.object({
  model: z.string().trim().min(1).max(200),
  credits: pricingCreditsSchema,
  creditsPerSecond: pricingCreditsSchema.optional(),
  creditsPerVideo: pricingCreditsSchema.optional(),
  creditsByDuration: z.record(z.string().trim().min(1).max(20), pricingCreditsSchema).optional(),
  creditsByResolution: z.record(z.string().trim().min(1).max(20), pricingCreditsSchema).optional(),
  creditsByCount: z.record(z.string().trim().min(1).max(20), pricingCreditsSchema).optional(),
  includedReferenceImages: z.number().int().min(0).max(100).optional(),
  creditsPerExtraReferenceImage: pricingCreditsSchema.optional(),
  creditsPerReferenceVideoSecond: pricingCreditsSchema.optional(),
  referenceVideoCreditsByResolution: z.record(z.string().trim().min(1).max(20), pricingCreditsSchema).optional(),
}).strict();
const pricingSchema = z.object({
  agentRequestCredits: pricingCreditsSchema,
  inspirationAnalysisCredits: pricingCreditsSchema,
  imageDefaultCredits: pricingCreditsSchema,
  videoDefaultCredits: pricingCreditsSchema,
  imageModels: z.array(imageModelPriceSchema).max(100),
  videoModels: z.array(videoModelPriceSchema).max(100),
}).strict().superRefine((value, context) => {
  for (const [path, models] of [
    ['imageModels', value.imageModels],
    ['videoModels', value.videoModels],
  ] as const) {
    const normalized = models.map((item) => aiPricingModelToken(item.model));
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: 'custom',
        path: [path],
        message: '模型积分配置包含重复模型',
      });
    }
  }
});

const chatTokenRatesSchema = z.object({
  inputCreditsPerMillion: pricingCreditsSchema,
  outputCreditsPerMillion: pricingCreditsSchema,
  cachedInputCreditsPerMillion: pricingCreditsSchema,
  cacheWriteCreditsPerMillion: pricingCreditsSchema,
}).strict();

const chatModelPriceSchema = z.discriminatedUnion('billingMode', [
  z.object({
    model: z.string().trim().min(1).max(200),
    billingMode: z.literal('token'),
    contextThresholdTokens: z.number().int().min(1).max(10_000_000),
    standard: chatTokenRatesSchema,
    extended: chatTokenRatesSchema,
  }).strict(),
  z.object({
    model: z.string().trim().min(1).max(200),
    billingMode: z.literal('request'),
    creditsPerRequest: pricingCreditsSchema,
  }).strict(),
]);

const chatPricingSchema = z.object({
  models: z.array(chatModelPriceSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const normalized = value.models.map(item => chatPricingModelToken(item.model));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({
      code: 'custom',
      path: ['models'],
      message: 'Chat 模型积分配置包含重复模型',
    });
  }
});

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticateAdmin);

  await app.register(providerAdminRoutes, { prefix: '/providers' });
  await app.register(inspirationSpaceAdminRoutes, { prefix: '/inspiration-space' });

  app.get('/pricing', async () => getAiPricingConfig(app.prisma));

  app.patch(
    '/pricing',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = pricingSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalid(reply, parsed.error.issues[0]?.message ?? 'AI pricing is invalid');
      }
      return updateAiPricingConfig(app.prisma, parsed.data);
    },
  );

  app.get('/chat-pricing', async () => getChatPricingConfig(app.prisma));

  app.patch(
    '/chat-pricing',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = chatPricingSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalid(reply, parsed.error.issues[0]?.message ?? 'Chat pricing is invalid');
      }
      return updateChatPricingConfig(app.prisma, parsed.data);
    },
  );

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

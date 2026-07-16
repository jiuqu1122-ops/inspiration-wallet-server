import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createProvider,
  getProviderBalance,
  listProviders,
  ProviderServiceError,
  recordProviderTestFailure,
  testProvider,
  updateProvider,
} from './service.js';

const providerIdSchema = z.object({ providerId: z.string().min(1).max(64) });
const operationKeySchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const kindSchema = z.enum(['NEW_API', 'XAIS']);
const capabilitySchema = z.enum(['LLM', 'IMAGE', 'VIDEO']);
const headersSchema = z.record(z.string().max(100), z.string().max(2_000)).refine(
  (headers) => Object.keys(headers).length <= 20,
  'Too many custom headers',
);
const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  kind: kindSchema,
  baseUrl: z.url().max(2_000),
  defaultModel: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().min(8).max(2_000),
  headers: headersSchema.default({}),
  allowInsecureHttp: z.boolean().default(false),
  capabilities: z.array(capabilitySchema).min(1).max(3).optional(),
  enabled: z.boolean().default(true),
  idempotencyKey: operationKeySchema,
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  baseUrl: z.url().max(2_000).optional(),
  defaultModel: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().min(8).max(2_000).optional(),
  headers: headersSchema.optional(),
  allowInsecureHttp: z.boolean().optional(),
  capabilities: z.array(capabilitySchema).min(1).max(3).optional(),
  enabled: z.boolean().optional(),
  idempotencyKey: operationKeySchema,
}).strict().refine(
  (input) => Object.keys(input).some((key) => key !== 'idempotencyKey'),
  'No provider changes were supplied',
);

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

function providerError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProviderServiceError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export const providerAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => listProviders(app.prisma));

  app.post(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'Provider is invalid');
      try {
        return await createProvider(app.prisma, parsed.data);
      } catch (error) {
        return providerError(reply, error);
      }
    },
  );

  app.patch('/:providerId', async (request, reply) => {
    const params = providerIdSchema.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Provider update is invalid');
    try {
      return await updateProvider(app.prisma, params.data.providerId, body.data);
    } catch (error) {
      return providerError(reply, error);
    }
  });

  app.post(
    '/:providerId/balance',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = providerIdSchema.safeParse(request.params);
      if (!params.success) return invalid(reply, 'Provider ID is invalid');
      try {
        return await getProviderBalance(app.prisma, params.data.providerId);
      } catch (error) {
        return providerError(reply, error);
      }
    },
  );

  app.post(
    '/:providerId/test',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = providerIdSchema.safeParse(request.params);
      if (!params.success) return invalid(reply, 'Provider ID is invalid');
      try {
        return await testProvider(app.prisma, params.data.providerId);
      } catch (error) {
        if (error instanceof ProviderServiceError) return providerError(reply, error);
        try {
          return await recordProviderTestFailure(app.prisma, params.data.providerId, error);
        } catch (recordedError) {
          return providerError(reply, recordedError);
        }
      }
    },
  );
};

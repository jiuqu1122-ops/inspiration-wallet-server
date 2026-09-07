import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ensureAiCatalogSeeded } from './catalog-seed.js';
import {
  createCanonicalFromDiscovery,
  getAdminAiModel,
  ignoreDiscovery,
  listAdminAiModels,
  listUnmappedModels,
  mapDiscoveryToCanonical,
  publishAdminPendingPrice,
  updateAdminAiModel,
  updateAdminAiRoute,
  updatePricingPolicy,
} from './model-admin.js';
import { setPendingPrice } from './pricing-center.js';
import { toInputJson } from './pricing-center.js';
import { syncUpstreamModels } from './upstream-sync.js';

const modalitySchema = z.enum(['chat', 'image', 'video']);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const modelKeySchema = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/);
const idSchema = z.string().trim().min(1).max(128);

const listSchema = z.object({
  modality: modalitySchema.optional(),
  status: z.string().trim().min(1).max(40).optional(),
}).strict();

const modelParamsSchema = z.object({ modelKey: modelKeySchema }).strict();
const routeParamsSchema = z.object({ routeId: idSchema }).strict();
const providerParamsSchema = z.object({ providerId: idSchema }).strict();
const discoveryParamsSchema = z.object({ discoveryId: idSchema }).strict();

const updateModelSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  routingMode: z.enum(['LEGACY', 'MANAGED']).optional(),
  capabilities: jsonObjectSchema.optional(),
  defaultRouteId: idSchema.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'No model changes were supplied');

const updateRouteSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100_000).optional(),
  healthStatus: z.string().trim().min(1).max(40).optional(),
  upstreamAvailable: z.boolean().optional(),
  costProfile: jsonObjectSchema.nullable().optional(),
  capabilitiesOverride: jsonObjectSchema.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'No route changes were supplied');

const createCanonicalSchema = z.object({
  canonicalModelKey: modelKeySchema.optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  modality: modalitySchema,
  billingType: z.enum([
    'token',
    'request',
    'image_resolution',
    'image_flat',
    'image_count',
    'video_second',
    'video_flat',
    'video_duration',
    'video_resolution_duration',
  ]),
  capabilities: jsonObjectSchema.optional(),
  pendingPrice: jsonObjectSchema.optional(),
}).strict();

const pricingPolicySchema = z.object({
  pricingMode: z.enum(['MANUAL', 'MARKUP']),
  markupMultiplier: z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/),
}).strict();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

async function adminOperation<T>(reply: FastifyReply, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI Model Center operation failed';
    const notFound = /not found/i.test(message);
    return reply.code(notFound ? 404 : 400).send({
      error: notFound ? 'not_found' : 'invalid_request',
      message,
    });
  }
}

export const aiModelAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async () => {
    await ensureAiCatalogSeeded(app.prisma);
  });

  app.get('/', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, 'AI model filters are invalid');
    return listAdminAiModels(app.prisma, parsed.data);
  });

  app.get('/unmapped', async () => ({ items: await listUnmappedModels(app.prisma) }));

  app.post(
    '/sync/:providerId',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = providerParamsSchema.safeParse(request.params);
      if (!parsed.success) return invalid(reply, 'Provider ID is invalid');
      return adminOperation(reply, () => syncUpstreamModels(app.prisma, parsed.data.providerId));
    },
  );

  app.post('/unmapped/:discoveryId/map', async (request, reply) => {
    const params = discoveryParamsSchema.safeParse(request.params);
    const body = z.object({ canonicalModelKey: modelKeySchema }).strict().safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Canonical mapping is invalid');
    return adminOperation(reply, () => mapDiscoveryToCanonical(
      app.prisma,
      params.data.discoveryId,
      body.data.canonicalModelKey,
    ));
  });

  app.post('/unmapped/:discoveryId/create', async (request, reply) => {
    const params = discoveryParamsSchema.safeParse(request.params);
    const body = createCanonicalSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Canonical model data is invalid');
    const input = {
      modality: body.data.modality,
      billingType: body.data.billingType,
      ...(body.data.canonicalModelKey ? { canonicalModelKey: body.data.canonicalModelKey } : {}),
      ...(body.data.displayName ? { displayName: body.data.displayName } : {}),
      ...(body.data.capabilities ? { capabilities: toInputJson(body.data.capabilities) } : {}),
      ...(body.data.pendingPrice ? { pendingPrice: toInputJson(body.data.pendingPrice) } : {}),
    };
    return adminOperation(reply, () => createCanonicalFromDiscovery(app.prisma, params.data.discoveryId, input));
  });

  app.post('/unmapped/:discoveryId/ignore', async (request, reply) => {
    const params = discoveryParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Discovery ID is invalid');
    return adminOperation(reply, () => ignoreDiscovery(app.prisma, params.data.discoveryId));
  });

  app.patch('/routes/:routeId', async (request, reply) => {
    const params = routeParamsSchema.safeParse(request.params);
    const body = updateRouteSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Route update is invalid');
    const input = {
      ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
      ...(body.data.priority !== undefined ? { priority: body.data.priority } : {}),
      ...(body.data.healthStatus !== undefined ? { healthStatus: body.data.healthStatus } : {}),
      ...(body.data.upstreamAvailable !== undefined ? { upstreamAvailable: body.data.upstreamAvailable } : {}),
      ...(body.data.costProfile !== undefined ? {
        costProfile: body.data.costProfile === null ? null : toInputJson(body.data.costProfile),
      } : {}),
      ...(body.data.capabilitiesOverride !== undefined ? {
        capabilitiesOverride: body.data.capabilitiesOverride === null ? null : toInputJson(body.data.capabilitiesOverride),
      } : {}),
    };
    return adminOperation(reply, () => updateAdminAiRoute(app.prisma, params.data.routeId, input));
  });

  app.put('/:modelKey/pricing/pending', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = jsonObjectSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Pending price is invalid');
    return adminOperation(reply, () => setPendingPrice(app.prisma, params.data.modelKey, toInputJson(body.data)));
  });

  app.patch('/:modelKey/pricing/policy', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = pricingPolicySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Pricing policy is invalid');
    return adminOperation(reply, () => updatePricingPolicy(app.prisma, params.data.modelKey, body.data));
  });

  app.post('/:modelKey/pricing/publish', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Model key is invalid');
    return adminOperation(reply, () => publishAdminPendingPrice(
      app.prisma,
      params.data.modelKey,
      'admin-api',
    ));
  });

  app.get('/:modelKey', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Model key is invalid');
    const model = await getAdminAiModel(app.prisma, params.data.modelKey);
    return model ?? reply.code(404).send({ error: 'not_found', message: 'Canonical model was not found' });
  });

  app.patch('/:modelKey', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = updateModelSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Model update is invalid');
    const input = {
      ...(body.data.displayName !== undefined ? { displayName: body.data.displayName } : {}),
      ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
      ...(body.data.visible !== undefined ? { visible: body.data.visible } : {}),
      ...(body.data.sortOrder !== undefined ? { sortOrder: body.data.sortOrder } : {}),
      ...(body.data.status !== undefined ? { status: body.data.status } : {}),
      ...(body.data.routingMode !== undefined ? { routingMode: body.data.routingMode } : {}),
      ...(body.data.capabilities !== undefined ? { capabilities: toInputJson(body.data.capabilities) } : {}),
      ...(body.data.defaultRouteId !== undefined ? { defaultRouteId: body.data.defaultRouteId } : {}),
    };
    return adminOperation(reply, () => updateAdminAiModel(app.prisma, params.data.modelKey, input));
  });
};

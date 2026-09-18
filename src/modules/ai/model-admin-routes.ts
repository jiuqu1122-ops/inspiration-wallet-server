import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensureAiCatalogSeeded } from './catalog-seed.js';
import {
  AiModelAdminError,
  clearAdminPendingPrice,
  createAdminAiModelAlias,
  createCanonicalFromDiscovery,
  deleteAdminAiModelAlias,
  deleteAdminAiModel,
  getAdminAiModel,
  ignoreDiscovery,
  listAdminAiModels,
  listUnmappedModels,
  mapDiscoveryToCanonical,
  publishAdminPendingPrice,
  remapAdminAiRoute,
  setAdminPendingPrice,
  unmapAdminAiRoute,
  updateAdminAiModel,
  updateAdminAiRoute,
  updatePricingPolicy,
} from './model-admin.js';
import { toInputJson } from './pricing-center.js';
import { syncAllUpstreamModels, syncUpstreamModels } from './upstream-sync.js';
import {
  AI_USAGE_MODEL_KEYS,
  listAdminUsageModelBindings,
  updateAdminUsageModelBinding,
} from './usage-model-binding.js';
import { IMAGE_ADAPTER_KEYS } from './image-adapters/registry.js';

const modalitySchema = z.enum(['chat', 'image', 'video']);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const adapterEndpointSchema = z.string().trim().min(1).max(240).regex(/^\/(?!\/)/);
const adapterConfigSchema = z.object({
  resolutionParameter: z.enum(['none', 'size', 'resolution']).optional(),
  resolutionValueMode: z.enum(['label', 'exact']).optional(),
  aspectRatioParameter: z.enum(['none', 'aspect_ratio']).optional(),
  async: z.union([z.literal('inherit'), z.boolean()]).optional(),
  generationEndpoint: adapterEndpointSchema.optional(),
  editEndpoint: adapterEndpointSchema.optional(),
  exactDimensions: z.record(
    z.string().trim().min(1).max(32),
    z.record(z.string().trim().min(1).max(32), z.string().trim().regex(/^\d+x\d+$/i)),
  ).optional(),
  referenceSerializer: z.enum(['json_image', 'json_images']).optional(),
}).strict();
const videoAdapterKeys = [
  'LEGACY_VIDEO',
  'MINIMAX_NATIVE_VIDEO',
  'SEEDANCE_VIDEO',
  'VEO_VIDEO',
  'KLING_VIDEO',
  'GENERIC_ASYNC_VIDEO',
  'OPENAI_COMPATIBLE_VIDEO',
] as const;
const adapterKeySchema = z.union([
  z.enum(IMAGE_ADAPTER_KEYS),
  z.enum(videoAdapterKeys),
]);
const modelKeySchema = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/);
const idSchema = z.string().trim().min(1).max(128);

const listSchema = z.object({
  modality: modalitySchema.optional(),
  status: z.string().trim().min(1).max(40).optional(),
}).strict();

const modelParamsSchema = z.object({ modelKey: modelKeySchema }).strict();
const deleteModelSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
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
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'No model changes were supplied');

const updateRouteSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100_000).optional(),
  healthStatus: z.string().trim().min(1).max(40).optional(),
  upstreamAvailable: z.boolean().optional(),
  costProfile: jsonObjectSchema.nullable().optional(),
  capabilitiesOverride: jsonObjectSchema.nullable().optional(),
  adapterKey: adapterKeySchema.nullable().optional(),
  adapterConfig: z.union([adapterConfigSchema, jsonObjectSchema]).nullable().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
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
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const remapRouteSchema = z.object({
  canonicalModelKey: modelKeySchema,
  currentCanonicalModelId: idSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const unmapRouteSchema = z.object({
  currentCanonicalModelId: idSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const aliasSchema = z.object({
  alias: z.string().trim().min(1).max(200),
}).strict();

const aliasParamsSchema = z.object({
  modelKey: modelKeySchema,
  aliasId: idSchema,
}).strict();

const pricingPolicySchema = z.object({
  pricingMode: z.enum(['MANUAL', 'MARKUP']),
  markupMultiplier: z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/),
}).strict();
const usageBindingParamsSchema = z.object({ key: z.enum(AI_USAGE_MODEL_KEYS) }).strict();
const fixedCreditsSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const updateUsageBindingSchema = z.object({
  canonicalModelId: idSchema,
  fixedCredits: fixedCreditsSchema,
}).strict();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

async function adminOperation<T>(reply: FastifyReply, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI Model Center operation failed';
    const status = error instanceof AiModelAdminError
      ? error.statusCode
      : /not found/i.test(message) ? 404 : 400;
    return reply.code(status).send({
      error: status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid_request',
      message,
    });
  }
}

const mutationContext = (request: FastifyRequest) => ({
  actor: 'admin-api',
  requestId: request.id,
});

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

  app.get('/usage-model-bindings', async () => listAdminUsageModelBindings(app.prisma));

  app.patch('/usage-model-bindings/:key', async (request, reply) => {
    const params = usageBindingParamsSchema.safeParse(request.params);
    const body = updateUsageBindingSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Usage model binding update is invalid');
    return adminOperation(reply, () => updateAdminUsageModelBinding(
      app.prisma,
      params.data.key,
      body.data,
      mutationContext(request),
    ));
  });

  app.post(
    '/sync',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (_request, reply) => adminOperation(reply, () => syncAllUpstreamModels(app.prisma)),
  );

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
    const body = z.object({
      canonicalModelKey: modelKeySchema,
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Canonical mapping is invalid');
    return adminOperation(reply, () => mapDiscoveryToCanonical(
      app.prisma,
      params.data.discoveryId,
      body.data.canonicalModelKey,
      body.data.expectedUpdatedAt,
      mutationContext(request),
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
      ...(body.data.visible !== undefined ? { visible: body.data.visible } : {}),
      ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
      ...(body.data.expectedUpdatedAt ? { expectedUpdatedAt: body.data.expectedUpdatedAt } : {}),
    };
    return adminOperation(reply, () => createCanonicalFromDiscovery(
      app.prisma,
      params.data.discoveryId,
      input,
      mutationContext(request),
    ));
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
      ...(body.data.adapterKey !== undefined ? { adapterKey: body.data.adapterKey } : {}),
      ...(body.data.adapterConfig !== undefined ? {
        adapterConfig: body.data.adapterConfig === null ? null : toInputJson(body.data.adapterConfig),
      } : {}),
      ...(body.data.expectedUpdatedAt ? { expectedUpdatedAt: body.data.expectedUpdatedAt } : {}),
    };
    return adminOperation(reply, () => updateAdminAiRoute(
      app.prisma,
      params.data.routeId,
      input,
      mutationContext(request),
    ));
  });

  app.post('/routes/:routeId/remap', async (request, reply) => {
    const params = routeParamsSchema.safeParse(request.params);
    const body = remapRouteSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Route remap is invalid');
    return adminOperation(reply, () => remapAdminAiRoute(
      app.prisma,
      params.data.routeId,
      body.data,
      mutationContext(request),
    ));
  });

  app.post('/routes/:routeId/unmap', async (request, reply) => {
    const params = routeParamsSchema.safeParse(request.params);
    const body = unmapRouteSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Route unmap is invalid');
    return adminOperation(reply, () => unmapAdminAiRoute(
      app.prisma,
      params.data.routeId,
      body.data,
      mutationContext(request),
    ));
  });

  app.put('/:modelKey/pricing/pending', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = jsonObjectSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Pending price is invalid');
    return adminOperation(reply, () => setAdminPendingPrice(
      app.prisma,
      params.data.modelKey,
      toInputJson(body.data),
      mutationContext(request),
    ));
  });

  app.delete('/:modelKey/pricing/pending', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Model key is invalid');
    return adminOperation(reply, () => clearAdminPendingPrice(
      app.prisma,
      params.data.modelKey,
      mutationContext(request),
    ));
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
      mutationContext(request),
    ));
  });

  app.post('/:modelKey/aliases', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = aliasSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Alias data is invalid');
    return adminOperation(reply, () => createAdminAiModelAlias(
      app.prisma,
      params.data.modelKey,
      body.data.alias,
      mutationContext(request),
    ));
  });

  app.delete('/:modelKey/aliases/:aliasId', async (request, reply) => {
    const params = aliasParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Alias data is invalid');
    return adminOperation(reply, () => deleteAdminAiModelAlias(
      app.prisma,
      params.data.modelKey,
      params.data.aliasId,
      mutationContext(request),
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
      ...(body.data.expectedUpdatedAt ? { expectedUpdatedAt: body.data.expectedUpdatedAt } : {}),
    };
    return adminOperation(reply, () => updateAdminAiModel(
      app.prisma,
      params.data.modelKey,
      input,
      mutationContext(request),
    ));
  });

  app.delete('/:modelKey', async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    const body = deleteModelSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply, 'Model deletion request is invalid');
    return adminOperation(reply, () => deleteAdminAiModel(
      app.prisma,
      params.data.modelKey,
      body.data.expectedUpdatedAt,
      mutationContext(request),
    ));
  });
};

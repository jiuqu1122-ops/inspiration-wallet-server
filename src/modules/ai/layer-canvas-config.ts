import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { serializeCredit } from '../wallets/credit-amount.js';

export const layerModes = ['split', 'edit'] as const;
export type LayerMode = typeof layerModes[number];
export const layerCapability = { split: 'supportsLayerSplit', edit: 'supportsInteractiveEdit' } as const;
const layerTaskKeys = { split: 'CANVAS_LAYER_SPLIT', edit: 'CANVAS_LAYER_EDIT' } as const;
export const layerCreditsSchema = z.string().trim().regex(/^\d{1,8}(?:\.\d{1,6})?$/);
const layerRouteFields = {
  enabled: z.boolean(),
  endpoint: z.string().trim().max(240).regex(/^\/(?!\/)[a-zA-Z0-9/_%.~-]+$/)
    .refine(value => !value.includes('%') && !value.split('/').some(part => part === '..' || part === '.')),
  adapter: z.enum(['canvas-json', 'pixel-json', 'images-api-edit', 'volcengine-ark']),
  maxMegapixels: z.number().int().min(1).max(64),
  maxLayers: z.number().int().min(1).max(64),
};
export const layerRouteSchema = z.union([
  z.strictObject({ ...layerRouteFields, creditsPerRequest: layerCreditsSchema }),
  z.strictObject({ ...layerRouteFields, baseCredits: layerCreditsSchema, perMegapixelCredits: layerCreditsSchema })
    .transform(({ baseCredits, enabled, endpoint, adapter, maxMegapixels, maxLayers }) =>
      ({ enabled, endpoint, adapter, maxMegapixels, maxLayers, creditsPerRequest: baseCredits })),
]);
export type LayerRoute = z.infer<typeof layerRouteSchema>;
export const jsonRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function layerRouteConfig(metadata: unknown, mode: LayerMode) {
  const parsed = layerRouteSchema.safeParse(jsonRecord(jsonRecord(metadata).canvasLayers)[mode]);
  return parsed.success ? parsed.data : null;
}

const layerTaskPreferred = (metadata: unknown, mode: LayerMode) =>
  jsonRecord(jsonRecord(metadata).canvasLayerTaskPreferred)[mode] === true;

async function layerTaskBinding(prisma: PrismaClient, mode: LayerMode) {
  return prisma.aiUsageModelBinding?.findUnique?.({
    where: { key: layerTaskKeys[mode] },
    select: { canonicalModelId: true, canonicalModel: { select: { canonicalModelKey: true, displayName: true } } },
  });
}

export async function isLayerTaskModel(prisma: PrismaClient, canonicalModelId: string) {
  return Boolean(await prisma.aiUsageModelBinding.findFirst({
    where: { canonicalModelId, key: { in: Object.values(layerTaskKeys) } },
    select: { key: true },
  }));
}

export async function layerCandidates(prisma: PrismaClient, mode: LayerMode, modelKey?: string) {
  return findLayerCandidates(prisma, mode, await layerTaskBinding(prisma, mode), modelKey);
}

async function findLayerCandidates(
  prisma: PrismaClient, mode: LayerMode, binding: Awaited<ReturnType<typeof layerTaskBinding>>, modelKey?: string,
) {
  const routes = await prisma.aiModelRoute.findMany({
    where: {
      enabled: true, upstreamAvailable: true,
      metadata: { path: ['canvasLayers', mode, 'enabled'], equals: true },
      channel: { status: 'ACTIVE', capabilities: { has: 'IMAGE' } },
      canonicalModel: { modality: 'image', status: 'PUBLISHED', enabled: true,
        ...(binding ? { id: binding.canonicalModelId } : {
          visible: true,
          capabilities: { path: [layerCapability[mode]], equals: true },
          ...(modelKey ? { canonicalModelKey: modelKey } : {}),
        }) },
    },
    include: { channel: true, canonicalModel: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });
  const candidates = routes.flatMap(route => {
    const config = layerRouteConfig(route.metadata, mode);
    return config?.enabled && route.channel && route.canonicalModel
      && (mode !== 'split' || config.adapter !== 'images-api-edit')
      ? [{ route, provider: route.channel, model: route.canonicalModel, config }] : [];
  });
  const rank = ({ route, model }: typeof candidates[number]) => {
    if (binding && layerTaskPreferred(route.metadata, mode)) return 2;
    return Number(route.id === model.defaultRouteId);
  };
  // Ties keep the database's priority ordering.
  return candidates.sort((a, b) => rank(b) - rank(a));
}

export async function getAdminLayerTasks(prisma: PrismaClient) {
  const [models, tasks] = await Promise.all([
    prisma.aiModel.findMany({
      where: { modality: 'image', status: 'PUBLISHED', enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
      select: {
        canonicalModelKey: true, displayName: true, defaultRouteId: true,
        routes: {
          where: { channel: { capabilities: { has: 'IMAGE' } } },
          orderBy: [{ priority: 'asc' }, { id: 'asc' }],
          select: {
            id: true, upstreamModelId: true, enabled: true, upstreamAvailable: true, metadata: true,
            channel: { select: { name: true, kind: true, status: true } },
          },
        },
      },
    }),
    Promise.all(layerModes.map(async mode => {
      const binding = await layerTaskBinding(prisma, mode);
      const [current] = await findLayerCandidates(prisma, mode, binding);
      return [mode, {
        modelKey: binding?.canonicalModel.canonicalModelKey ?? current?.model.canonicalModelKey ?? null,
        modelName: binding?.canonicalModel.displayName ?? current?.model.displayName ?? null,
        currentRoute: current ? {
          id: current.route.id, channelName: current.provider.name, upstreamModelId: current.route.upstreamModelId,
          creditsPerRequest: serializeCredit(current.config.creditsPerRequest),
        } : null,
      }] as const;
    })),
  ]);
  return {
    items: Object.fromEntries(tasks),
    models: models.flatMap(({ routes, ...model }) => {
      const channels = routes.flatMap(({ channel, metadata, ...route }) => channel ? [{
        ...route, channel,
        configs: { split: layerRouteConfig(metadata, 'split'), edit: layerRouteConfig(metadata, 'edit') },
      }] : []);
      return channels.length ? [{ ...model, routes: channels }] : [];
    }),
  };
}

export async function getLayerCatalog(prisma: PrismaClient) {
  if (!prisma.aiModelRoute?.findMany) return { split: [], edit: [] };
  const entries = await Promise.all(layerModes.map(async mode => {
    const candidates = await layerCandidates(prisma, mode);
    const models = new Map<string, {
      id: string; name: string; creditsPerRequest: string;
      baseCredits: string; perMegapixelCredits: string; maxCredits: string;
    }>();
    for (const { config, model } of candidates) {
      if (models.has(model.canonicalModelKey)) continue;
      const creditsPerRequest = serializeCredit(config.creditsPerRequest);
      models.set(model.canonicalModelKey, {
        id: model.canonicalModelKey, name: model.displayName, creditsPerRequest,
        // Older clients still read these keys from the catalog.
        baseCredits: creditsPerRequest, perMegapixelCredits: '0', maxCredits: creditsPerRequest,
      });
    }
    return [mode, [...models.values()]] as const;
  }));
  return Object.fromEntries(entries);
}

export async function updateLayerRoute(
  prisma: PrismaClient, modelKey: string, routeId: string, mode: LayerMode, config: LayerRoute | null,
  selectForTask = false,
) {
  if (mode === 'split' && config?.adapter === 'images-api-edit') throw new Error('Images API edit only supports interactive edit');
  await prisma.$transaction(async tx => {
    const route = await tx.aiModelRoute.findFirst({
      where: { id: routeId, canonicalModel: { canonicalModelKey: modelKey, modality: 'image' } },
      include: { canonicalModel: true, channel: true },
    });
    if (!route) throw new Error('Image model route not found');
    if (!route.channelId) throw new Error('Select a route with an AI provider channel');
    const metadata = jsonRecord(route.metadata);
    const canvasLayers = { ...jsonRecord(metadata.canvasLayers) };
    if (config) canvasLayers[mode] = config;
    else delete canvasLayers[mode];
    const preferred = { ...jsonRecord(metadata.canvasLayerTaskPreferred) };
    if (!config?.enabled) delete preferred[mode];
    if (selectForTask && config?.enabled) {
      const model = route.canonicalModel;
      if (!model?.enabled || model.status !== 'PUBLISHED' || !route.enabled || !route.upstreamAvailable
        || route.channel?.status !== 'ACTIVE' || !route.channel.capabilities.includes('IMAGE')) {
        throw new Error('所选模型或渠道当前不可用，请检查模型发布状态和渠道路由');
      }
      const otherPreferredRoutes = await tx.aiModelRoute.findMany({
        where: { canonicalModelId: model.id, id: { not: route.id }, metadata: { path: ['canvasLayerTaskPreferred', mode], equals: true } },
        select: { id: true, metadata: true },
      });
      for (const other of otherPreferredRoutes) {
        const otherMetadata = jsonRecord(other.metadata);
        const otherPreferred = { ...jsonRecord(otherMetadata.canvasLayerTaskPreferred) };
        delete otherPreferred[mode];
        await tx.aiModelRoute.update({ where: { id: other.id }, data: {
          metadata: { ...otherMetadata, canvasLayerTaskPreferred: otherPreferred } as Prisma.InputJsonObject,
        } });
      }
      preferred[mode] = true;
      const key = layerTaskKeys[mode];
      await tx.aiUsageModelBinding.upsert({
        where: { key }, create: { key, canonicalModelId: model.id }, update: { canonicalModelId: model.id },
      });
    }
    await tx.aiModelRoute.update({ where: { id: route.id }, data: {
      metadata: { ...metadata, canvasLayers, canvasLayerTaskPreferred: preferred } as Prisma.InputJsonObject,
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

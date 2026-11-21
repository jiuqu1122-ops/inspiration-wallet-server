import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { serializeCredit } from '../wallets/credit-amount.js';

export const layerModes = ['split', 'edit'] as const;
export type LayerMode = typeof layerModes[number];
export const layerCapability = { split: 'supportsLayerSplit', edit: 'supportsInteractiveEdit' } as const;
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
export async function layerCandidates(prisma: PrismaClient, mode: LayerMode, modelKey?: string) {
  const routes = await prisma.aiModelRoute.findMany({
    where: {
      enabled: true, upstreamAvailable: true,
      metadata: { path: ['canvasLayers', mode, 'enabled'], equals: true },
      channel: { status: 'ACTIVE', capabilities: { has: 'IMAGE' } },
      canonicalModel: { modality: 'image', status: 'PUBLISHED', enabled: true, visible: true,
        capabilities: { path: [layerCapability[mode]], equals: true },
        ...(modelKey ? { canonicalModelKey: modelKey } : {}) },
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
  // Keep the database's priority ordering among routes with the same default status.
  return candidates.sort((a, b) =>
    Number(b.route.id === b.model.defaultRouteId) - Number(a.route.id === a.model.defaultRouteId));
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

export async function updateLayerRoute(prisma: PrismaClient, modelKey: string, routeId: string, mode: LayerMode, config: LayerRoute | null) {
  if (mode === 'split' && config?.adapter === 'images-api-edit') throw new Error('Images API edit only supports interactive edit');
  await prisma.$transaction(async tx => {
    const route = await tx.aiModelRoute.findFirst({ where: { id: routeId, canonicalModel: { canonicalModelKey: modelKey, modality: 'image' } } });
    if (!route) throw new Error('Image model route not found');
    if (!route.channelId) throw new Error('Select a route with an AI provider channel');
    const metadata = jsonRecord(route.metadata);
    const canvasLayers = { ...jsonRecord(metadata.canvasLayers) };
    if (config) canvasLayers[mode] = config;
    else delete canvasLayers[mode];
    await tx.aiModelRoute.update({ where: { id: route.id }, data: { metadata: { ...metadata, canvasLayers } as Prisma.InputJsonObject } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

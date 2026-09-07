import { Prisma, type PrismaClient } from '@prisma/client';
import {
  canonicalDisplayName,
  catalogAliasKey,
  defaultModelCapabilities,
  safeCanonicalModelKey,
  type AiModality,
} from './model-catalog.js';
import {
  roundSuggestedPoints,
  setPendingPrice,
  publishPendingPriceAndSyncLegacy,
  toInputJson,
  validatePricingProfile,
  type CatalogPricingProfile,
} from './pricing-center.js';

export async function listAdminAiModels(
  prisma: PrismaClient,
  filters: { modality?: AiModality | undefined; status?: string | undefined },
) {
  const models = await prisma.aiModel.findMany({
    where: {
      ...(filters.modality ? { modality: filters.modality } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      routes: { include: { channel: { select: { id: true, name: true, kind: true, status: true } } }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] },
      pricing: { include: { currentVersion: true } },
    },
    orderBy: [{ modality: 'asc' }, { sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
  });
  return {
    items: models.map(model => {
      const costs = model.routes.filter(route => route.costProfile).map(route => route.costProfile);
      return {
        id: model.id,
        canonicalModelKey: model.canonicalModelKey,
        displayName: model.displayName,
        modality: model.modality,
        enabled: model.enabled,
        visible: model.visible,
        sortOrder: model.sortOrder,
        billingType: model.billingType,
        routingMode: model.routingMode,
        capabilities: model.capabilities,
        status: model.status,
        defaultRouteId: model.defaultRouteId,
        currentRoute: model.routes.find(route => route.id === model.defaultRouteId) ?? model.routes.find(route => route.enabled) ?? null,
        routes: model.routes,
        currentPrice: model.pricing?.currentVersion?.pricing ?? null,
        pendingPrice: model.pricing?.pendingPrice ?? null,
        suggestedPrice: model.pricing?.suggestedPrice ?? null,
        pricingMode: model.pricing?.pricingMode ?? 'MANUAL',
        markupMultiplier: model.pricing?.markupMultiplier.toString() ?? '1.320000',
        priceVersion: model.pricing?.currentVersion?.version ?? null,
        upstreamCosts: costs,
        lastSync: model.routes.reduce<Date | null>((latest, route) => (
          route.lastSyncedAt && (!latest || route.lastSyncedAt > latest) ? route.lastSyncedAt : latest
        ), null),
      };
    }),
  };
}

export async function getAdminAiModel(prisma: PrismaClient, canonicalModelKey: string) {
  return prisma.aiModel.findUnique({
    where: { canonicalModelKey },
    include: {
      aliases: { orderBy: { createdAt: 'asc' } },
      routes: {
        include: { channel: { select: { id: true, name: true, kind: true, status: true } }, costHistory: { orderBy: { observedAt: 'desc' }, take: 20 } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      },
      pricing: { include: { currentVersion: true } },
      priceVersions: { orderBy: { version: 'desc' }, take: 50 },
    },
  });
}

export async function updateAdminAiModel(
  prisma: PrismaClient,
  canonicalModelKey: string,
  input: {
    displayName?: string | undefined;
    enabled?: boolean | undefined;
    visible?: boolean | undefined;
    sortOrder?: number | undefined;
    status?: string | undefined;
    routingMode?: 'LEGACY' | 'MANAGED' | undefined;
    capabilities?: Prisma.InputJsonValue | undefined;
    defaultRouteId?: string | null | undefined;
  },
) {
  const current = await prisma.aiModel.findUnique({ where: { canonicalModelKey } });
  if (!current) throw new Error('Canonical model was not found');
  if (input.defaultRouteId) {
    const route = await prisma.aiModelRoute.findFirst({ where: { id: input.defaultRouteId, canonicalModelId: current.id } });
    if (!route) throw new Error('Default route does not belong to the canonical model');
  }
  const data: Prisma.AiModelUpdateInput = {};
  if (input.displayName !== undefined) data.displayName = input.displayName;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.visible !== undefined) data.visible = input.visible;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.status !== undefined) data.status = input.status;
  if (input.routingMode !== undefined) data.routingMode = input.routingMode;
  if (input.capabilities !== undefined) data.capabilities = input.capabilities;
  if (input.defaultRouteId !== undefined) data.defaultRoute = input.defaultRouteId === null
    ? { disconnect: true }
    : { connect: { id: input.defaultRouteId } };
  return prisma.aiModel.update({
    where: { canonicalModelKey },
    data,
  });
}

export async function updateAdminAiRoute(
  prisma: PrismaClient,
  routeId: string,
  input: {
    enabled?: boolean | undefined;
    priority?: number | undefined;
    healthStatus?: string | undefined;
    upstreamAvailable?: boolean | undefined;
    costProfile?: Prisma.InputJsonValue | null | undefined;
    capabilitiesOverride?: Prisma.InputJsonValue | null | undefined;
  },
) {
  const current = await prisma.aiModelRoute.findUnique({ where: { id: routeId } });
  if (!current) throw new Error('Model route was not found');
  const costChanged = input.costProfile !== undefined
    && JSON.stringify(current.costProfile) !== JSON.stringify(input.costProfile);
  const data: Prisma.AiModelRouteUpdateInput = {};
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.healthStatus !== undefined) data.healthStatus = input.healthStatus;
  if (input.upstreamAvailable !== undefined) data.upstreamAvailable = input.upstreamAvailable;
  if (input.capabilitiesOverride !== undefined) {
    data.capabilitiesOverride = input.capabilitiesOverride === null ? Prisma.JsonNull : input.capabilitiesOverride;
  }
  if (input.costProfile !== undefined) {
    data.costProfile = input.costProfile === null ? Prisma.JsonNull : input.costProfile;
    data.costUpdatedAt = new Date();
    data.pricingSyncStatus = input.costProfile === null ? 'WARNING_COST_UNAVAILABLE' : 'MANUAL';
  }
  const route = await prisma.aiModelRoute.update({
    where: { id: routeId },
    data,
  });
  if (input.enabled === true) {
    await prisma.aiModel.update({
      where: { id: current.canonicalModelId },
      data: { routingMode: 'MANAGED' },
    });
  }
  if (costChanged && input.costProfile) {
    await prisma.aiRouteCostHistory.create({
      data: { routeId, costProfile: input.costProfile, pricingSyncStatus: 'MANUAL' },
    });
    await refreshSuggestedPriceForModel(prisma, current.canonicalModelId);
  }
  return route;
}

export async function listUnmappedModels(prisma: PrismaClient) {
  return prisma.aiUpstreamDiscovery.findMany({
    where: { status: 'UNMAPPED' },
    include: { channel: { select: { id: true, name: true, kind: true, status: true } } },
    orderBy: [{ lastSyncedAt: 'desc' }, { provider: 'asc' }, { upstreamModelId: 'asc' }],
  });
}

export async function mapDiscoveryToCanonical(
  prisma: PrismaClient,
  discoveryId: string,
  canonicalModelKey: string,
) {
  const route = await prisma.$transaction(async (transaction) => {
    const [discovery, model] = await Promise.all([
      transaction.aiUpstreamDiscovery.findUnique({ where: { id: discoveryId }, include: { channel: true } }),
      transaction.aiModel.findUnique({ where: { canonicalModelKey } }),
    ]);
    if (!discovery) throw new Error('Upstream discovery was not found');
    if (!model) throw new Error('Canonical model was not found');
    if (discovery.suggestedModality && discovery.suggestedModality !== model.modality) {
      throw new Error('Discovery modality does not match the canonical model');
    }
    const route = await transaction.aiModelRoute.upsert({
      where: {
        provider_channelId_upstreamModelId: {
          provider: discovery.provider,
          channelId: discovery.channelId,
          upstreamModelId: discovery.upstreamModelId,
        },
      },
      create: {
        canonicalModelId: model.id,
        provider: discovery.provider,
        channelId: discovery.channelId,
        upstreamModelId: discovery.upstreamModelId,
        enabled: false,
        priority: discovery.channel.priority,
        healthStatus: discovery.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'HEALTHY',
        upstreamAvailable: discovery.availability !== 'UNAVAILABLE',
        lastSyncedAt: discovery.lastSyncedAt,
        ...(discovery.discoveredCost ? { costProfile: discovery.discoveredCost } : {}),
        ...(discovery.capabilities ? { capabilitiesOverride: discovery.capabilities } : {}),
        ...(discovery.metadata ? { metadata: discovery.metadata } : {}),
        pricingSyncStatus: discovery.discoveredCost ? 'OK' : 'WARNING_COST_UNAVAILABLE',
        ...(discovery.discoveredCost ? { costUpdatedAt: new Date() } : {}),
      },
      update: { canonicalModelId: model.id },
    });
    const aliasKey = catalogAliasKey(discovery.upstreamModelId);
    await transaction.aiModelAlias.upsert({
      where: { modality_aliasKey: { modality: model.modality, aliasKey } },
      create: {
        canonicalModelId: model.id,
        modality: model.modality,
        alias: discovery.upstreamModelId,
        aliasKey,
        source: 'ADMIN_MAPPING',
        confirmed: true,
      },
      update: { canonicalModelId: model.id, alias: discovery.upstreamModelId, source: 'ADMIN_MAPPING', confirmed: true },
    });
    await transaction.aiUpstreamDiscovery.update({
      where: { id: discovery.id },
      data: { status: 'MAPPED', suggestedModelId: model.id },
    });
    return route;
  });
  await refreshSuggestedPriceForModel(prisma, route.canonicalModelId);
  return route;
}

export async function createCanonicalFromDiscovery(
  prisma: PrismaClient,
  discoveryId: string,
  input: {
    canonicalModelKey?: string | undefined;
    displayName?: string | undefined;
    modality: AiModality;
    billingType: string;
    capabilities?: Prisma.InputJsonValue | undefined;
    pendingPrice?: Prisma.InputJsonValue | undefined;
  },
) {
  const discovery = await prisma.aiUpstreamDiscovery.findUnique({ where: { id: discoveryId } });
  if (!discovery) throw new Error('Upstream discovery was not found');
  if (discovery.suggestedModality && discovery.suggestedModality !== input.modality) {
    throw new Error('Discovery modality does not match the requested canonical model');
  }
  const canonicalModelKey = input.canonicalModelKey?.trim().toLowerCase()
    || safeCanonicalModelKey(discovery.upstreamModelId, input.modality);
  const model = await prisma.aiModel.create({
    data: {
      canonicalModelKey,
      displayName: input.displayName?.trim() || canonicalDisplayName(canonicalModelKey, discovery.upstreamModelId),
      modality: input.modality,
      billingType: input.billingType,
      routingMode: 'MANAGED',
      capabilities: input.capabilities ?? defaultModelCapabilities(canonicalModelKey, input.modality),
      // New upstream products stay hidden and disabled until explicitly published.
      visible: false,
      enabled: false,
      status: 'DRAFT',
    },
  });
  if (input.pendingPrice) await setPendingPrice(prisma, canonicalModelKey, input.pendingPrice);
  await mapDiscoveryToCanonical(prisma, discoveryId, canonicalModelKey);
  return model;
}

export async function ignoreDiscovery(prisma: PrismaClient, discoveryId: string) {
  return prisma.aiUpstreamDiscovery.update({ where: { id: discoveryId }, data: { status: 'IGNORED' } });
}

function costProfileToSuggestedPrice(
  modality: AiModality,
  costProfile: Record<string, unknown>,
  markupMultiplier: number,
): CatalogPricingProfile | null {
  const points = (value: unknown) => {
    const cny = Number(value);
    return Number.isFinite(cny) && cny >= 0
      ? roundSuggestedPoints(cny * 100 * markupMultiplier)
      : null;
  };
  if (modality === 'chat') {
    const convertTier = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const tier = value as Record<string, unknown>;
      const converted = {
        inputCreditsPerMillion: points(tier.upstreamInputCnyPer1m),
        outputCreditsPerMillion: points(tier.upstreamOutputCnyPer1m),
        cachedInputCreditsPerMillion: points(tier.upstreamCacheReadCnyPer1m),
        cacheWriteCreditsPerMillion: points(tier.upstreamCacheWriteCnyPer1m),
      };
      return Object.values(converted).every(Boolean) ? converted : null;
    };
    const standard = convertTier(costProfile.standard);
    const extended = convertTier(costProfile.extended);
    if (!standard || !extended) return null;
    return {
      billingType: 'token',
      contextThresholdTokens: Number(costProfile.contextThresholdTokens) || 272000,
      standard,
      extended,
    };
  }
  if (modality === 'image') {
    const costs = costProfile.cnyPerImageByResolution;
    if (!costs || typeof costs !== 'object' || Array.isArray(costs)) return null;
    const prices = Object.fromEntries(Object.entries(costs).flatMap(([resolution, cost]) => {
      const suggested = points(cost);
      return suggested ? [[resolution.toLowerCase(), suggested]] : [];
    }));
    return prices['2k'] && prices['4k']
      ? { billingType: 'image_resolution', creditsPerImageByResolution: prices }
      : null;
  }
  const perSecond = points(costProfile.cnyPerSecond);
  return perSecond ? { billingType: 'video_second', credits: perSecond, creditsPerSecond: perSecond } : null;
}

export async function refreshSuggestedPriceForModel(
  prisma: PrismaClient,
  canonicalModelId: string,
) {
  const model = await prisma.aiModel.findUnique({
    where: { id: canonicalModelId },
    include: {
      pricing: true,
      routes: {
        where: { costProfile: { not: Prisma.JsonNull } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!model?.pricing || model.pricing.pricingMode !== 'MARKUP') return null;
  const multiplier = Number(model.pricing.markupMultiplier);
  const routes = [
    ...model.routes.filter(route => route.enabled),
    ...model.routes.filter(route => !route.enabled),
  ];
  let suggestedPrice: CatalogPricingProfile | null = null;
  for (const route of routes) {
    if (!route.costProfile || typeof route.costProfile !== 'object' || Array.isArray(route.costProfile)) continue;
    suggestedPrice = costProfileToSuggestedPrice(
      model.modality as AiModality,
      route.costProfile,
      multiplier,
    );
    if (suggestedPrice) break;
  }
  await prisma.aiModelPricing.update({
    where: { canonicalModelId },
    data: { suggestedPrice: suggestedPrice === null ? Prisma.JsonNull : toInputJson(suggestedPrice) },
  });
  return suggestedPrice;
}

export async function updatePricingPolicy(
  prisma: PrismaClient,
  canonicalModelKey: string,
  input: { pricingMode: 'MANUAL' | 'MARKUP'; markupMultiplier: string },
) {
  const model = await prisma.aiModel.findUnique({
    where: { canonicalModelKey },
    include: { routes: { where: { costProfile: { not: Prisma.JsonNull } }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
  });
  if (!model) throw new Error('Canonical model was not found');
  const multiplier = Number(input.markupMultiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) throw new Error('Markup multiplier is invalid');
  let suggestedPrice: CatalogPricingProfile | null = null;
  if (input.pricingMode === 'MARKUP') {
    for (const route of model.routes) {
      if (!route.costProfile || typeof route.costProfile !== 'object' || Array.isArray(route.costProfile)) continue;
      suggestedPrice = costProfileToSuggestedPrice(
        model.modality as AiModality,
        route.costProfile,
        multiplier,
      );
      if (suggestedPrice) break;
    }
  }
  return prisma.aiModelPricing.upsert({
    where: { canonicalModelId: model.id },
    create: {
      canonicalModelId: model.id,
      pricingMode: input.pricingMode,
      markupMultiplier: input.markupMultiplier,
      ...(suggestedPrice ? { suggestedPrice: toInputJson(suggestedPrice) } : {}),
    },
    update: {
      pricingMode: input.pricingMode,
      markupMultiplier: input.markupMultiplier,
      suggestedPrice: suggestedPrice === null ? Prisma.JsonNull : toInputJson(suggestedPrice),
    },
    include: { currentVersion: true },
  });
}

export async function publishAdminPendingPrice(
  prisma: PrismaClient,
  canonicalModelKey: string,
  publishedBy?: string,
) {
  return publishPendingPriceAndSyncLegacy(prisma, canonicalModelKey, publishedBy);
}

export { validatePricingProfile };

import { randomUUID } from 'node:crypto';
import { AdminOperationType, Prisma, type PrismaClient } from '@prisma/client';
import {
  canonicalDisplayName,
  catalogAliasKey,
  defaultModelCapabilities,
  isGptImage2CatalogIdentity,
  normalizeModelCapabilities,
  safeCanonicalModelKey,
  withGptImage2DimensionCapabilities,
  type AiModality,
} from './model-catalog.js';
import {
  roundSuggestedPoints,
  setPendingPrice,
  publishPendingPrice,
  toInputJson,
  validatePricingProfile,
  type CatalogPricingProfile,
} from './pricing-center.js';
import { validateGenericAsyncVideoConfig } from './video-adapters/generic-async-video.js';
import { assertVideoCapabilitiesSubset } from './video-capabilities.js';

export type AdminMutationContext = {
  actor: string;
  requestId: string;
};

export class AiModelAdminError extends Error {
  constructor(
    public readonly code: 'CONFLICT' | 'INVALID_REQUEST' | 'NOT_FOUND',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'AiModelAdminError';
  }
}

const routeAliasSources = new Set(['ADMIN_MAPPING', 'ROUTE_MAPPING']);

const operationKey = (context: AdminMutationContext, type: AdminOperationType) => (
  `ai-model:${type.toLowerCase()}:${context.requestId}:${randomUUID()}`
);

export async function recordAdminOperation(
  transaction: Prisma.TransactionClient,
  type: AdminOperationType,
  context: AdminMutationContext,
  result: Prisma.InputJsonValue,
) {
  await transaction.adminOperation.create({
    data: {
      idempotencyKey: operationKey(context, type),
      type,
      description: `${context.actor} · AI Model Center`,
      result,
    },
  });
}

const asIso = (value: Date | string) => (
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
);

const jsonObject = (value: unknown): Record<string, Prisma.JsonValue> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {}
);

async function bestEnabledRouteId(
  transaction: Prisma.TransactionClient,
  canonicalModelId: string,
  excludedRouteId?: string,
) {
  const replacement = await transaction.aiModelRoute.findFirst({
    where: {
      canonicalModelId,
      enabled: true,
      ...(excludedRouteId ? { id: { not: excludedRouteId } } : {}),
    },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return replacement?.id ?? null;
}

async function repairDefaultRoute(
  transaction: Prisma.TransactionClient,
  canonicalModelId: string,
  movedOrDisabledRouteId: string,
  context: AdminMutationContext,
) {
  const model = await transaction.aiModel.findUnique({
    where: { id: canonicalModelId },
    select: { id: true, canonicalModelKey: true, defaultRouteId: true },
  });
  if (!model || model.defaultRouteId !== movedOrDisabledRouteId) return null;
  const replacementId = await bestEnabledRouteId(transaction, canonicalModelId, movedOrDisabledRouteId);
  await transaction.aiModel.update({
    where: { id: canonicalModelId },
    data: replacementId
      ? { defaultRoute: { connect: { id: replacementId } } }
      : { defaultRoute: { disconnect: true } },
  });
  await recordAdminOperation(transaction, AdminOperationType.DEFAULT_ROUTE_CHANGED, context, {
    schemaVersion: 1,
    modelId: model.id,
    modelKey: model.canonicalModelKey,
    before: movedOrDisabledRouteId,
    after: replacementId,
  });
  return replacementId;
}

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
        updatedAt: model.updatedAt,
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
      _count: { select: { routes: true, priceVersions: true, requests: true, billingSettlements: true, usageBindings: true } },
    },
  });
}

export async function deleteAdminAiModel(
  prisma: PrismaClient,
  canonicalModelKey: string,
  expectedUpdatedAt: string | undefined,
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  return prisma.$transaction(async (transaction) => {
    const model = await transaction.aiModel.findUnique({
      where: { canonicalModelKey },
      include: {
        _count: { select: { routes: true, priceVersions: true, requests: true, billingSettlements: true, usageBindings: true } },
      },
    });
    if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    if (expectedUpdatedAt && asIso(model.updatedAt) !== asIso(expectedUpdatedAt)) {
      throw new AiModelAdminError('CONFLICT', 'Model configuration was modified by another administrator', 409);
    }
    if (model.status !== 'DRAFT' || model.enabled || model.visible) {
      throw new AiModelAdminError(
        'INVALID_REQUEST',
        'Only a hidden, disabled draft model can be deleted',
        400,
      );
    }
    if (model._count.routes > 0) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Remove all upstream route mappings before deleting this model', 400);
    }
    if (model._count.priceVersions > 0) {
      throw new AiModelAdminError('INVALID_REQUEST', 'A model with published price history cannot be deleted', 400);
    }
    if (model._count.requests > 0 || model._count.billingSettlements > 0) {
      throw new AiModelAdminError('INVALID_REQUEST', 'A model with request or billing history cannot be deleted', 400);
    }
    if (model._count.usageBindings > 0) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Move internal usage bindings before deleting this model', 400);
    }
    const deleted = await transaction.aiModel.deleteMany({
      where: { id: model.id, updatedAt: model.updatedAt },
    });
    if (deleted.count !== 1) {
      throw new AiModelAdminError('CONFLICT', 'Model configuration was modified by another administrator', 409);
    }
    await recordAdminOperation(transaction, AdminOperationType.MODEL_DELETED, context, {
      schemaVersion: 1,
      modelId: model.id,
      modelKey: model.canonicalModelKey,
      displayName: model.displayName,
      modality: model.modality,
    });
    return { deleted: true, modelKey: model.canonicalModelKey };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
    expectedUpdatedAt?: string | undefined;
  },
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.aiModel.findUnique({ where: { canonicalModelKey } });
    if (!current) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    if (input.expectedUpdatedAt && asIso(current.updatedAt) !== asIso(input.expectedUpdatedAt)) {
      throw new AiModelAdminError('CONFLICT', 'Model configuration was modified by another administrator', 409);
    }
    if (input.defaultRouteId) {
      const route = await transaction.aiModelRoute.findFirst({
        where: { id: input.defaultRouteId, canonicalModelId: current.id, enabled: true },
      });
      if (!route) throw new AiModelAdminError(
        'INVALID_REQUEST',
        'Default route must be an enabled route owned by the canonical model',
        400,
      );
    }
    const data: Prisma.AiModelUncheckedUpdateManyInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.visible !== undefined) data.visible = input.visible;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.status !== undefined) data.status = input.status;
    if (input.routingMode !== undefined) data.routingMode = input.routingMode;
    const nextDisplayName = input.displayName ?? current.displayName;
    if (input.capabilities !== undefined
      || (current.modality === 'image'
        && isGptImage2CatalogIdentity(current.canonicalModelKey, nextDisplayName))) {
      data.capabilities = normalizeModelCapabilities((current.modality === 'image'
        ? withGptImage2DimensionCapabilities(
          input.capabilities ?? current.capabilities,
          current.canonicalModelKey,
          nextDisplayName,
        )
        : input.capabilities) as Prisma.InputJsonValue);
    }
    if (input.defaultRouteId !== undefined) data.defaultRouteId = input.defaultRouteId;
    const updated = await transaction.aiModel.updateMany({
      where: { id: current.id, updatedAt: current.updatedAt },
      data,
    });
    if (updated.count !== 1) {
      throw new AiModelAdminError('CONFLICT', 'Model configuration was modified by another administrator', 409);
    }
    if (input.visible !== undefined && input.visible !== current.visible) {
      await recordAdminOperation(transaction, AdminOperationType.MODEL_VISIBILITY_CHANGED, context, {
        schemaVersion: 1,
        modelId: current.id,
        modelKey: current.canonicalModelKey,
        before: current.visible,
        after: input.visible,
      });
    }
    if (input.enabled !== undefined && input.enabled !== current.enabled) {
      await recordAdminOperation(transaction, AdminOperationType.MODEL_ENABLED_CHANGED, context, {
        schemaVersion: 1,
        modelId: current.id,
        modelKey: current.canonicalModelKey,
        before: current.enabled,
        after: input.enabled,
      });
    }
    if (input.defaultRouteId !== undefined && input.defaultRouteId !== current.defaultRouteId) {
      await recordAdminOperation(transaction, AdminOperationType.DEFAULT_ROUTE_CHANGED, context, {
        schemaVersion: 1,
        modelId: current.id,
        modelKey: current.canonicalModelKey,
        before: current.defaultRouteId,
        after: input.defaultRouteId,
      });
    }
    return transaction.aiModel.findUniqueOrThrow({ where: { id: current.id } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
    adapterKey?: string | null | undefined;
    adapterConfig?: Prisma.InputJsonValue | null | undefined;
    expectedUpdatedAt?: string | undefined;
  },
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.aiModelRoute.findUnique({
      where: { id: routeId },
      include: { canonicalModel: { select: { modality: true, capabilities: true } } },
    });
    if (!current) throw new AiModelAdminError('NOT_FOUND', 'Model route was not found', 404);
    if (input.expectedUpdatedAt && asIso(current.updatedAt) !== asIso(input.expectedUpdatedAt)) {
      throw new AiModelAdminError('CONFLICT', 'Route configuration was modified by another administrator', 409);
    }
    if (input.enabled === true && !current.canonicalModelId) {
      throw new AiModelAdminError('INVALID_REQUEST', 'An unmapped route cannot be enabled', 400);
    }
    if ((input.adapterKey !== undefined && input.adapterKey !== null
      || input.adapterConfig !== undefined && input.adapterConfig !== null)
      && current.canonicalModel?.modality === 'chat') {
      throw new AiModelAdminError('INVALID_REQUEST', 'Media adapters may only be configured on image or video model routes', 400);
    }
    const costChanged = input.costProfile !== undefined
      && JSON.stringify(current.costProfile) !== JSON.stringify(input.costProfile);
    const data: Prisma.AiModelRouteUpdateManyMutationInput = {};
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.healthStatus !== undefined) data.healthStatus = input.healthStatus;
    if (input.upstreamAvailable !== undefined) data.upstreamAvailable = input.upstreamAvailable;
    if (input.capabilitiesOverride !== undefined) {
      if (input.capabilitiesOverride !== null
        && current.canonicalModel?.modality === 'video') {
        assertVideoCapabilitiesSubset(current.canonicalModel.capabilities, input.capabilitiesOverride);
      }
      data.capabilitiesOverride = input.capabilitiesOverride === null
        ? Prisma.JsonNull
        : normalizeModelCapabilities(input.capabilitiesOverride);
      data.metadata = {
        ...jsonObject(current.metadata),
        capabilitiesOverrideSource: input.capabilitiesOverride === null ? 'INHERIT' : 'MANUAL',
      };
    }
    if (input.adapterKey !== undefined) data.adapterKey = input.adapterKey;
    if (input.adapterConfig !== undefined) {
      const nextAdapterKey = input.adapterKey === undefined ? current.adapterKey : input.adapterKey;
      data.adapterConfig = input.adapterConfig === null
        ? Prisma.DbNull
        : nextAdapterKey === 'GENERIC_ASYNC_VIDEO' || nextAdapterKey === 'AI_MEDIA_VIDEOS_API'
          ? toInputJson(validateGenericAsyncVideoConfig(input.adapterConfig))
          : input.adapterConfig;
    }
    if (input.costProfile !== undefined) {
      data.costProfile = input.costProfile === null ? Prisma.JsonNull : input.costProfile;
      data.costUpdatedAt = new Date();
      data.pricingSyncStatus = input.costProfile === null ? 'WARNING_COST_UNAVAILABLE' : 'MANUAL';
    }
    const updated = await transaction.aiModelRoute.updateMany({
      where: { id: routeId, updatedAt: current.updatedAt },
      data,
    });
    if (updated.count !== 1) {
      throw new AiModelAdminError('CONFLICT', 'Route configuration was modified by another administrator', 409);
    }
    if (input.enabled === true && current.canonicalModelId) {
      await transaction.aiModel.update({
        where: { id: current.canonicalModelId },
        data: { routingMode: 'MANAGED' },
      });
    }
    if (input.enabled === false && current.enabled && current.canonicalModelId) {
      await recordAdminOperation(transaction, AdminOperationType.ROUTE_DISABLED, context, {
        schemaVersion: 1,
        routeId,
        modelId: current.canonicalModelId,
        before: true,
        after: false,
      });
      await repairDefaultRoute(transaction, current.canonicalModelId, routeId, context);
    }
    if (costChanged && input.costProfile) {
      await transaction.aiRouteCostHistory.create({
        data: { routeId, costProfile: input.costProfile, pricingSyncStatus: 'MANUAL' },
      });
      if (current.canonicalModelId) {
        await refreshSuggestedPriceForModel(transaction as unknown as PrismaClient, current.canonicalModelId);
      }
    }
    return transaction.aiModelRoute.findUniqueOrThrow({ where: { id: routeId } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listUnmappedModels(prisma: PrismaClient) {
  return prisma.aiUpstreamDiscovery.findMany({
    where: { status: 'UNMAPPED' },
    include: { channel: { select: { id: true, name: true, kind: true, status: true } } },
    orderBy: [{ lastSyncedAt: 'desc' }, { provider: 'asc' }, { upstreamModelId: 'asc' }],
  });
}

async function updateRouteGeneratedAlias(
  transaction: Prisma.TransactionClient,
  route: { id: string; upstreamModelId: string },
  sourceModel: { id: string; modality: string },
  targetModel: { id: string; modality: string } | null,
) {
  const aliasKey = catalogAliasKey(route.upstreamModelId);
  if (!aliasKey) return;
  const alias = await transaction.aiModelAlias.findUnique({
    where: { modality_aliasKey: { modality: sourceModel.modality, aliasKey } },
  });
  if (alias && routeAliasSources.has(alias.source)) {
    if (alias.canonicalModelId !== sourceModel.id) {
      throw new AiModelAdminError('CONFLICT', 'The route alias belongs to a different model', 409);
    }
    if (targetModel) {
      await transaction.aiModelAlias.update({
        where: { id: alias.id },
        data: {
          canonicalModelId: targetModel.id,
          modality: targetModel.modality,
          alias: route.upstreamModelId,
          aliasKey,
          source: 'ROUTE_MAPPING',
          confirmed: true,
        },
      });
    } else {
      await transaction.aiModelAlias.delete({ where: { id: alias.id } });
    }
    return;
  }
  if (alias && targetModel && alias.canonicalModelId !== targetModel.id) {
    throw new AiModelAdminError(
      'CONFLICT',
      'A manually managed alias conflicts with this route mapping',
      409,
    );
  }
  // Manual aliases are intentionally retained when a route is unmapped.
  if (alias || !targetModel) return;
  await transaction.aiModelAlias.create({
    data: {
      canonicalModelId: targetModel.id,
      modality: targetModel.modality,
      alias: route.upstreamModelId,
      aliasKey,
      source: 'ROUTE_MAPPING',
      confirmed: true,
    },
  });
}

export async function remapAdminAiRoute(
  prisma: PrismaClient,
  routeId: string,
  input: {
    canonicalModelKey: string;
    currentCanonicalModelId: string;
    expectedUpdatedAt: string;
  },
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const [route, targetModel] = await Promise.all([
      transaction.aiModelRoute.findUnique({
        where: { id: routeId },
        include: { canonicalModel: true },
      }),
      transaction.aiModel.findUnique({ where: { canonicalModelKey: input.canonicalModelKey } }),
    ]);
    if (!route?.canonicalModel) throw new AiModelAdminError('NOT_FOUND', 'Mapped route was not found', 404);
    if (!targetModel) throw new AiModelAdminError('NOT_FOUND', 'Target canonical model was not found', 404);
    if (route.canonicalModelId !== input.currentCanonicalModelId
      || asIso(route.updatedAt) !== asIso(input.expectedUpdatedAt)) {
      throw new AiModelAdminError('CONFLICT', 'Route mapping was modified by another administrator', 409);
    }
    if (route.canonicalModel.modality !== targetModel.modality) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Route modality does not match the target canonical model', 400);
    }
    if (route.canonicalModelId === targetModel.id) {
      return { route, previousModelId: route.canonicalModelId, replacementDefaultRouteId: null };
    }
    await updateRouteGeneratedAlias(transaction, route, route.canonicalModel, targetModel);
    const moved = await transaction.aiModelRoute.updateMany({
      where: {
        id: route.id,
        canonicalModelId: route.canonicalModelId,
        updatedAt: route.updatedAt,
      },
      data: { canonicalModelId: targetModel.id },
    });
    if (moved.count !== 1) {
      throw new AiModelAdminError('CONFLICT', 'Route mapping was modified by another administrator', 409);
    }
    const replacementDefaultRouteId = await repairDefaultRoute(
      transaction,
      route.canonicalModelId,
      route.id,
      context,
    );
    if (route.channelId) {
      await transaction.aiUpstreamDiscovery.updateMany({
        where: { channelId: route.channelId, upstreamModelId: route.upstreamModelId },
        data: { status: 'MAPPED', suggestedModelId: targetModel.id },
      });
    }
    await recordAdminOperation(transaction, AdminOperationType.ROUTE_REMAPPED, context, {
      schemaVersion: 1,
      routeId: route.id,
      upstreamModelId: route.upstreamModelId,
      provider: route.provider,
      before: { canonicalModelId: route.canonicalModelId, canonicalModelKey: route.canonicalModel.canonicalModelKey },
      after: { canonicalModelId: targetModel.id, canonicalModelKey: targetModel.canonicalModelKey },
      preserved: { priority: route.priority, enabled: route.enabled, costProfile: route.costProfile },
    });
    await refreshSuggestedPriceForModel(transaction as unknown as PrismaClient, route.canonicalModelId);
    await refreshSuggestedPriceForModel(transaction as unknown as PrismaClient, targetModel.id);
    return {
      route: await transaction.aiModelRoute.findUniqueOrThrow({ where: { id: route.id } }),
      previousModelId: route.canonicalModelId,
      replacementDefaultRouteId,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function unmapAdminAiRoute(
  prisma: PrismaClient,
  routeId: string,
  input: { currentCanonicalModelId: string; expectedUpdatedAt: string },
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const route = await transaction.aiModelRoute.findUnique({
      where: { id: routeId },
      include: { canonicalModel: true, channel: true },
    });
    if (!route?.canonicalModel) throw new AiModelAdminError('NOT_FOUND', 'Mapped route was not found', 404);
    if (!route.channelId || !route.channel) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Legacy routes without a channel cannot enter the upstream review queue', 400);
    }
    if (route.canonicalModelId !== input.currentCanonicalModelId
      || asIso(route.updatedAt) !== asIso(input.expectedUpdatedAt)) {
      throw new AiModelAdminError('CONFLICT', 'Route mapping was modified by another administrator', 409);
    }
    await updateRouteGeneratedAlias(transaction, route, route.canonicalModel, null);
    const unmapped = await transaction.aiModelRoute.updateMany({
      where: {
        id: route.id,
        canonicalModelId: route.canonicalModelId,
        updatedAt: route.updatedAt,
      },
      data: { canonicalModelId: null, enabled: false },
    });
    if (unmapped.count !== 1) {
      throw new AiModelAdminError('CONFLICT', 'Route mapping was modified by another administrator', 409);
    }
    const replacementDefaultRouteId = await repairDefaultRoute(
      transaction,
      route.canonicalModelId,
      route.id,
      context,
    );
    const discovery = await transaction.aiUpstreamDiscovery.upsert({
      where: {
        channelId_upstreamModelId: {
          channelId: route.channelId,
          upstreamModelId: route.upstreamModelId,
        },
      },
      create: {
        provider: route.provider,
        channelId: route.channelId,
        upstreamModelId: route.upstreamModelId,
        suggestedModality: route.canonicalModel.modality,
        availability: route.upstreamAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        ...(route.capabilitiesOverride ? { capabilities: route.capabilitiesOverride } : {}),
        ...(route.costProfile ? { discoveredCost: route.costProfile } : {}),
        ...(route.metadata ? { metadata: route.metadata } : {}),
        status: 'UNMAPPED',
        lastSyncedAt: route.lastSyncedAt ?? new Date(),
      },
      update: {
        provider: route.provider,
        suggestedModality: route.canonicalModel.modality,
        availability: route.upstreamAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        ...(route.capabilitiesOverride ? { capabilities: route.capabilitiesOverride } : {}),
        ...(route.costProfile ? { discoveredCost: route.costProfile } : {}),
        ...(route.metadata ? { metadata: route.metadata } : {}),
        status: 'UNMAPPED',
        suggestedModelId: null,
        ...(route.lastSyncedAt ? { lastSyncedAt: route.lastSyncedAt } : {}),
      },
    });
    await recordAdminOperation(transaction, AdminOperationType.ROUTE_UNMAPPED, context, {
      schemaVersion: 1,
      routeId: route.id,
      provider: route.provider,
      upstreamModelId: route.upstreamModelId,
      before: { canonicalModelId: route.canonicalModelId, canonicalModelKey: route.canonicalModel.canonicalModelKey },
      after: { canonicalModelId: null, discoveryId: discovery.id, status: 'UNMAPPED' },
      preserved: {
        priority: route.priority,
        costProfile: route.costProfile,
        lastSyncedAt: route.lastSyncedAt,
        metadata: route.metadata,
      },
    });
    await refreshSuggestedPriceForModel(transaction as unknown as PrismaClient, route.canonicalModelId);
    return {
      route: await transaction.aiModelRoute.findUniqueOrThrow({ where: { id: route.id } }),
      discovery,
      previousModelId: route.canonicalModelId,
      replacementDefaultRouteId,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function mapDiscoveryToCanonicalTransaction(
  transaction: Prisma.TransactionClient,
  discoveryId: string,
  canonicalModelKey: string,
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  const [discovery, model] = await Promise.all([
    transaction.aiUpstreamDiscovery.findUnique({ where: { id: discoveryId }, include: { channel: true } }),
    transaction.aiModel.findUnique({ where: { canonicalModelKey } }),
  ]);
  if (!discovery) throw new AiModelAdminError('NOT_FOUND', 'Upstream discovery was not found', 404);
  if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
  if (discovery.status !== 'UNMAPPED') {
    throw new AiModelAdminError('CONFLICT', 'Upstream mapping was modified by another administrator', 409);
  }
  if (discovery.suggestedModality && discovery.suggestedModality !== model.modality) {
    throw new AiModelAdminError('INVALID_REQUEST', 'Discovery modality does not match the canonical model', 400);
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
    update: { canonicalModelId: model.id, enabled: false },
  });
  const aliasKey = catalogAliasKey(discovery.upstreamModelId);
  const existingAlias = await transaction.aiModelAlias.findUnique({
    where: { modality_aliasKey: { modality: model.modality, aliasKey } },
  });
  if (existingAlias && existingAlias.canonicalModelId !== model.id && !routeAliasSources.has(existingAlias.source)) {
    throw new AiModelAdminError('CONFLICT', 'A manually managed alias conflicts with this route mapping', 409);
  }
  if (existingAlias && existingAlias.canonicalModelId !== model.id) {
    await transaction.aiModelAlias.update({
      where: { id: existingAlias.id },
      data: { canonicalModelId: model.id, alias: discovery.upstreamModelId, source: 'ROUTE_MAPPING' },
    });
  } else if (!existingAlias) {
    await transaction.aiModelAlias.create({
      data: {
        canonicalModelId: model.id,
        modality: model.modality,
        alias: discovery.upstreamModelId,
        aliasKey,
        source: 'ROUTE_MAPPING',
        confirmed: true,
      },
    });
  }
  const discoveryUpdate = await transaction.aiUpstreamDiscovery.updateMany({
    where: { id: discovery.id, status: 'UNMAPPED' },
    data: { status: 'MAPPED', suggestedModelId: model.id },
  });
  if (discoveryUpdate.count !== 1) {
    throw new AiModelAdminError('CONFLICT', 'Upstream mapping was modified by another administrator', 409);
  }
  await recordAdminOperation(transaction, AdminOperationType.ROUTE_REMAPPED, context, {
    schemaVersion: 1,
    routeId: route.id,
    provider: route.provider,
    upstreamModelId: route.upstreamModelId,
    before: { canonicalModelId: null, discoveryId: discovery.id },
    after: { canonicalModelId: model.id, canonicalModelKey: model.canonicalModelKey },
  });
  await refreshSuggestedPriceForModel(transaction as unknown as PrismaClient, model.id);
  return route;
}

export async function mapDiscoveryToCanonical(
  prisma: PrismaClient,
  discoveryId: string,
  canonicalModelKey: string,
  expectedUpdatedAt?: string,
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  // Retained for compatibility with older callers. Discovery timestamps are
  // synchronization state and must not participate in the mapping CAS.
  void expectedUpdatedAt;
  return prisma.$transaction(
    transaction => mapDiscoveryToCanonicalTransaction(
      transaction,
      discoveryId,
      canonicalModelKey,
      context,
    ),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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
    visible?: boolean | undefined;
    enabled?: boolean | undefined;
    expectedUpdatedAt?: string | undefined;
  },
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  return prisma.$transaction(async (transaction) => {
    const discovery = await transaction.aiUpstreamDiscovery.findUnique({ where: { id: discoveryId } });
    if (!discovery) throw new AiModelAdminError('NOT_FOUND', 'Upstream discovery was not found', 404);
    if (discovery.status !== 'UNMAPPED') {
      throw new AiModelAdminError('CONFLICT', 'Upstream mapping was modified by another administrator', 409);
    }
    if (discovery.suggestedModality && discovery.suggestedModality !== input.modality) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Discovery modality does not match the requested canonical model', 400);
    }
    const canonicalModelKey = input.canonicalModelKey?.trim().toLowerCase()
      || safeCanonicalModelKey(discovery.upstreamModelId, input.modality);
    const displayName = input.displayName?.trim()
      || canonicalDisplayName(canonicalModelKey, discovery.upstreamModelId);
    const initialCapabilities = input.capabilities
      ?? defaultModelCapabilities(canonicalModelKey, input.modality);
    const capabilities = normalizeModelCapabilities((input.modality === 'image'
      ? withGptImage2DimensionCapabilities(
        initialCapabilities,
        canonicalModelKey,
        displayName,
        discovery.upstreamModelId,
      )
      : initialCapabilities) as Prisma.InputJsonValue);
    const model = await transaction.aiModel.create({
      data: {
        canonicalModelKey,
        displayName,
        modality: input.modality,
        billingType: input.billingType,
        routingMode: 'MANAGED',
        capabilities,
        // New upstream products stay hidden and disabled until explicitly published.
        visible: input.visible ?? false,
        enabled: input.enabled ?? false,
        status: 'DRAFT',
      },
    });
    if (input.pendingPrice) {
      await setPendingPrice(transaction as unknown as PrismaClient, canonicalModelKey, input.pendingPrice);
    }
    await mapDiscoveryToCanonicalTransaction(
      transaction,
      discoveryId,
      canonicalModelKey,
      context,
    );
    return model;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function ignoreDiscovery(prisma: PrismaClient, discoveryId: string) {
  return prisma.aiUpstreamDiscovery.update({ where: { id: discoveryId }, data: { status: 'IGNORED' } });
}

export async function createAdminAiModelAlias(
  prisma: PrismaClient,
  canonicalModelKey: string,
  aliasValue: string,
  context: AdminMutationContext,
) {
  const alias = aliasValue.trim();
  const aliasKey = catalogAliasKey(alias);
  if (!aliasKey) throw new AiModelAdminError('INVALID_REQUEST', 'Alias is invalid', 400);
  return prisma.$transaction(async (transaction) => {
    const model = await transaction.aiModel.findUnique({ where: { canonicalModelKey } });
    if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    const existing = await transaction.aiModelAlias.findUnique({
      where: { modality_aliasKey: { modality: model.modality, aliasKey } },
    });
    if (existing) {
      if (existing.canonicalModelId !== model.id) {
        throw new AiModelAdminError('CONFLICT', 'Alias is already assigned to another model', 409);
      }
      return existing;
    }
    const created = await transaction.aiModelAlias.create({
      data: {
        canonicalModelId: model.id,
        modality: model.modality,
        alias,
        aliasKey,
        source: 'ADMIN',
        confirmed: true,
      },
    });
    await recordAdminOperation(transaction, AdminOperationType.MODEL_ALIAS_CREATED, context, {
      schemaVersion: 1,
      modelId: model.id,
      modelKey: model.canonicalModelKey,
      aliasId: created.id,
      alias,
    });
    return created;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function deleteAdminAiModelAlias(
  prisma: PrismaClient,
  canonicalModelKey: string,
  aliasId: string,
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const alias = await transaction.aiModelAlias.findUnique({
      where: { id: aliasId },
      include: { canonicalModel: true },
    });
    if (!alias || alias.canonicalModel.canonicalModelKey !== canonicalModelKey) {
      throw new AiModelAdminError('NOT_FOUND', 'Alias was not found', 404);
    }
    if (routeAliasSources.has(alias.source)) {
      throw new AiModelAdminError('INVALID_REQUEST', 'Aliases maintained by route mappings cannot be removed manually', 400);
    }
    await transaction.aiModelAlias.delete({ where: { id: alias.id } });
    await recordAdminOperation(transaction, AdminOperationType.MODEL_ALIAS_DELETED, context, {
      schemaVersion: 1,
      modelId: alias.canonicalModelId,
      modelKey: canonicalModelKey,
      aliasId: alias.id,
      alias: alias.alias,
    });
    return { deleted: true, aliasId: alias.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function setAdminPendingPrice(
  prisma: PrismaClient,
  canonicalModelKey: string,
  pricing: Prisma.InputJsonValue,
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const before = await transaction.aiModel.findUnique({
      where: { canonicalModelKey },
      include: { pricing: true },
    });
    if (!before) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    const updated = await setPendingPrice(transaction as unknown as PrismaClient, canonicalModelKey, pricing);
    await recordAdminOperation(transaction, AdminOperationType.PRICING_PENDING_UPDATED, context, {
      schemaVersion: 1,
      modelId: before.id,
      modelKey: canonicalModelKey,
      before: before.pricing?.pendingPrice ?? null,
      after: pricing,
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function clearAdminPendingPrice(
  prisma: PrismaClient,
  canonicalModelKey: string,
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const model = await transaction.aiModel.findUnique({
      where: { canonicalModelKey },
      include: { pricing: true },
    });
    if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    const updated = await transaction.aiModelPricing.update({
      where: { canonicalModelId: model.id },
      data: { pendingPrice: Prisma.JsonNull },
      include: { currentVersion: true },
    });
    await recordAdminOperation(transaction, AdminOperationType.PRICING_PENDING_UPDATED, context, {
      schemaVersion: 1,
      modelId: model.id,
      modelKey: canonicalModelKey,
      before: model.pricing?.pendingPrice ?? null,
      after: null,
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
  context: AdminMutationContext = { actor: 'admin-api', requestId: randomUUID() },
) {
  const model = await prisma.aiModel.findUnique({
    where: { canonicalModelKey },
    include: { pricing: { include: { currentVersion: true } } },
  });
  if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
  const beforeVersion = model.pricing?.currentVersion?.version ?? null;
  return publishPendingPrice(
    prisma,
    canonicalModelKey,
    publishedBy,
    async (transaction, result) => {
      await recordAdminOperation(transaction, AdminOperationType.PRICING_PUBLISHED, context, {
        schemaVersion: 1,
        modelId: model.id,
        modelKey: canonicalModelKey,
        beforeVersion,
        afterVersion: result.version,
        pricing: result.pricing,
      });
    },
  );
}

export { validatePricingProfile };

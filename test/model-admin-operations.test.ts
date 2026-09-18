import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import {
  AiModelAdminError,
  createCanonicalFromDiscovery,
  deleteAdminAiModel,
  mapDiscoveryToCanonical,
  remapAdminAiRoute,
  unmapAdminAiRoute,
  updateAdminAiModel,
  updateAdminAiRoute,
  updateDiscoveryModalityOverride,
} from '../src/modules/ai/model-admin.js';
import { syncUpstreamModels } from '../src/modules/ai/upstream-sync.js';

const context = { actor: 'admin-api', requestId: 'request-test' };
const updatedAt = new Date('2026-09-09T08:00:00.000Z');

function withTransaction<T extends object>(transaction: T) {
  return {
    $transaction: vi.fn(async (callback: (client: T) => unknown) => callback(transaction)),
  } as unknown as PrismaClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI Model Center route operations', () => {
  it('preserves administrator-selected GPT Image 2.5 resolutions', async () => {
    const model = {
      id: 'model-gpt-image-2-5',
      canonicalModelKey: 'gpt-image-2.5-flare',
      displayName: 'GPT Image 2.5 Flare',
      modality: 'image',
      capabilities: { supportedResolutions: ['1k', '2k', '4k'] },
      enabled: true,
      visible: true,
      defaultRouteId: 'route-gpt-image-2-5',
      updatedAt,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      aiModel: {
        findUnique: vi.fn(async () => model),
        updateMany,
        findUniqueOrThrow: vi.fn(async () => ({
          ...model,
          capabilities: { supportedResolutions: ['1k'] },
        })),
      },
    };

    await updateAdminAiModel(withTransaction(transaction), model.canonicalModelKey, {
      capabilities: { supportedResolutions: ['1k'] },
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        capabilities: expect.objectContaining({
          supportedResolutions: ['1k'],
        }),
      }),
    }));
  });

  it('marks route capability overrides as manual configuration', async () => {
    const route = {
      id: 'route-capabilities',
      canonicalModelId: 'model-image',
      enabled: true,
      costProfile: null,
      metadata: { upstreamLabel: 'Future Image' },
      updatedAt,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => route),
        updateMany,
        findUniqueOrThrow: vi.fn(async () => route),
      },
    };

    await updateAdminAiRoute(withTransaction(transaction), route.id, {
      capabilitiesOverride: { supportedResolutions: ['8k'] },
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        capabilitiesOverride: { supportedResolutions: ['8k'] },
        metadata: {
          upstreamLabel: 'Future Image',
          capabilitiesOverrideSource: 'MANUAL',
        },
      }),
    }));
  });

  it('updates image adapter fields only when an administrator supplies them', async () => {
    const route = {
      id: 'route-seedream',
      canonicalModelId: 'model-seedream',
      canonicalModel: { modality: 'image' },
      enabled: false,
      costProfile: null,
      metadata: null,
      adapterKey: null,
      adapterConfig: null,
      updatedAt,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => route),
        updateMany,
        findUniqueOrThrow: vi.fn(async () => route),
      },
    };

    await updateAdminAiRoute(withTransaction(transaction), route.id, {
      priority: 20,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);
    expect(updateMany.mock.calls[0]?.[0].data).toEqual({ priority: 20 });

    updateMany.mockClear();
    await updateAdminAiRoute(withTransaction(transaction), route.id, {
      adapterKey: 'SEEDREAM_IMAGES_API',
      adapterConfig: {
        resolutionParameter: 'size',
        resolutionValueMode: 'label',
        aspectRatioParameter: 'aspect_ratio',
        async: true,
      },
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);
    expect(updateMany.mock.calls[0]?.[0].data).toEqual({
      adapterKey: 'SEEDREAM_IMAGES_API',
      adapterConfig: {
        resolutionParameter: 'size',
        resolutionValueMode: 'label',
        aspectRatioParameter: 'aspect_ratio',
        async: true,
      },
    });
  });

  it('deletes only an unused hidden draft model and records the operation', async () => {
    const model = {
      id: 'model-unused',
      canonicalModelKey: 'gpt-image-2-5-1k',
      displayName: 'GPT Image 2.5 1K',
      modality: 'image',
      status: 'DRAFT',
      enabled: false,
      visible: false,
      updatedAt,
      _count: { routes: 0, priceVersions: 0, requests: 0, billingSettlements: 0 },
    };
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({}));
    const transaction = {
      aiModel: {
        findUnique: vi.fn(async () => model),
        deleteMany,
      },
      adminOperation: { create: auditCreate },
    };

    await expect(deleteAdminAiModel(
      withTransaction(transaction),
      model.canonicalModelKey,
      updatedAt.toISOString(),
      context,
    )).resolves.toEqual({ deleted: true, modelKey: model.canonicalModelKey });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: model.id, updatedAt } });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'MODEL_DELETED' }),
    }));
  });

  it('refuses to delete a model that still owns an upstream route', async () => {
    const transaction = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-linked',
          canonicalModelKey: 'linked-image',
          displayName: 'Linked Image',
          modality: 'image',
          status: 'DRAFT',
          enabled: false,
          visible: false,
          updatedAt,
          _count: { routes: 1, priceVersions: 0, requests: 0, billingSettlements: 0 },
        })),
        deleteMany: vi.fn(),
      },
      adminOperation: { create: vi.fn() },
    };

    await expect(deleteAdminAiModel(
      withTransaction(transaction),
      'linked-image',
      updatedAt.toISOString(),
      context,
    )).rejects.toMatchObject<AiModelAdminError>({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(transaction.aiModel.deleteMany).not.toHaveBeenCalled();
    expect(transaction.adminOperation.create).not.toHaveBeenCalled();
  });

  it('creates a canonical model using the manual discovery modality override', async () => {
    const discovery = {
      id: 'discovery-create',
      status: 'UNMAPPED',
      updatedAt,
      provider: 'NEW_API',
      channelId: 'channel-create',
      upstreamModelId: 'vendor/new-image',
      suggestedModality: 'video',
      modalityOverride: 'image',
      availability: 'AVAILABLE',
      lastSyncedAt: updatedAt,
      channel: { priority: 6 },
    };
    const model = {
      id: 'model-created',
      canonicalModelKey: 'new-image',
      displayName: 'New Image',
      modality: 'image',
    };
    const modelCreate = vi.fn(async () => model);
    const routeUpsert = vi.fn(async () => ({
      id: 'route-created',
      canonicalModelId: model.id,
      provider: discovery.provider,
      upstreamModelId: discovery.upstreamModelId,
    }));
    const discoveryUpdate = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        updateMany: discoveryUpdate,
      },
      aiModel: {
        create: modelCreate,
        findUnique: vi.fn(async ({ where, include }: { where: { canonicalModelKey?: string }; include?: object }) => (
          include ? { ...model, pricing: null, routes: [] } : where.canonicalModelKey === model.canonicalModelKey ? model : null
        )),
      },
      aiModelRoute: { upsert: routeUpsert },
      aiModelAlias: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
      adminOperation: { create: vi.fn(async () => ({})) },
    };
    const transactionRunner = vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction));
    const prisma = { $transaction: transactionRunner } as unknown as PrismaClient;

    const result = await createCanonicalFromDiscovery(prisma, discovery.id, {
      canonicalModelKey: model.canonicalModelKey,
      displayName: model.displayName,
      modality: 'image',
      billingType: 'image_resolution',
      expectedUpdatedAt: '2026-09-09T07:59:59.000Z',
    }, context);

    expect(transactionRunner).toHaveBeenCalledTimes(1);
    expect(modelCreate).toHaveBeenCalledOnce();
    expect(routeUpsert).toHaveBeenCalledOnce();
    expect(discoveryUpdate).toHaveBeenCalledWith({
      where: { id: discovery.id, status: 'UNMAPPED' },
      data: { status: 'MAPPED', suggestedModelId: model.id },
    });
    expect(result).toEqual(model);
  });

  it('requires an effective discovery modality before creating a canonical model', async () => {
    const modelCreate = vi.fn();
    const transaction = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => ({
          id: 'discovery-unknown',
          status: 'UNMAPPED',
          suggestedModality: null,
          modalityOverride: null,
        })),
      },
      aiModel: { create: modelCreate },
    };

    await expect(createCanonicalFromDiscovery(
      withTransaction(transaction),
      'discovery-unknown',
      { modality: 'image', billingType: 'image_flat' },
      context,
    )).rejects.toMatchObject<AiModelAdminError>({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(modelCreate).not.toHaveBeenCalled();
  });

  it('persists a manual discovery modality separately from the automatic suggestion', async () => {
    const discovery = {
      id: 'discovery-override',
      status: 'UNMAPPED',
      suggestedModality: 'video',
      modalityOverride: null,
    };
    const update = vi.fn(async ({ data }: { data: { modalityOverride: string | null } }) => ({
      ...discovery,
      ...data,
      channel: { id: 'channel-override', name: 'Provider', kind: 'USELG', status: 'ACTIVE' },
    }));
    const prisma = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        update,
      },
    } as unknown as PrismaClient;

    await expect(updateDiscoveryModalityOverride(prisma, discovery.id, 'image')).resolves.toMatchObject({
      suggestedModality: 'video',
      modalityOverride: 'image',
      effectiveModality: 'image',
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: discovery.id },
      data: { modalityOverride: 'image' },
    }));
  });

  it('remaps only the route owner while preserving cost, priority, enabled state, and price history', async () => {
    const route = {
      id: 'route-1',
      canonicalModelId: 'model-source',
      canonicalModel: {
        id: 'model-source',
        canonicalModelKey: 'source-image',
        modality: 'image',
      },
      channelId: 'channel-1',
      provider: 'NEW_API',
      upstreamModelId: 'vendor/image-v2',
      enabled: true,
      priority: 7,
      costProfile: { cnyPerImageByResolution: { '2k': 0.18, '4k': 0.32 } },
      updatedAt,
    };
    const target = { id: 'model-target', canonicalModelKey: 'target-image', modality: 'image' };
    const routeUpdate = vi.fn(async () => ({ count: 1 }));
    const modelUpdate = vi.fn(async () => ({}));
    const aliasUpdate = vi.fn(async () => ({}));
    const auditCreate = vi.fn(async () => ({}));
    const priceUpdate = vi.fn();
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => route),
        updateMany: routeUpdate,
        findFirst: vi.fn(async () => ({ id: 'route-backup' })),
        findUniqueOrThrow: vi.fn(async () => ({ ...route, canonicalModelId: target.id })),
      },
      aiModel: {
        findUnique: vi.fn(async ({ where, include }: { where: { id?: string; canonicalModelKey?: string }; include?: object }) => {
          if (where.canonicalModelKey === target.canonicalModelKey) return target;
          if (where.id === 'model-source' && !include) {
            return { id: 'model-source', canonicalModelKey: 'source-image', defaultRouteId: route.id };
          }
          return { id: where.id, pricing: null, routes: [] };
        }),
        update: modelUpdate,
      },
      aiModelAlias: {
        findUnique: vi.fn(async () => ({
          id: 'alias-route',
          canonicalModelId: 'model-source',
          source: 'ROUTE_MAPPING',
        })),
        update: aliasUpdate,
      },
      aiUpstreamDiscovery: { updateMany: vi.fn(async () => ({ count: 1 })) },
      aiModelPricing: { update: priceUpdate },
      adminOperation: { create: auditCreate },
    };

    const result = await remapAdminAiRoute(withTransaction(transaction), route.id, {
      canonicalModelKey: target.canonicalModelKey,
      currentCanonicalModelId: route.canonicalModelId,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(routeUpdate).toHaveBeenCalledWith({
      where: { id: route.id, canonicalModelId: route.canonicalModelId, updatedAt },
      data: { canonicalModelId: target.id },
    });
    expect(aliasUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ canonicalModelId: target.id, source: 'ROUTE_MAPPING' }),
    }));
    expect(modelUpdate).toHaveBeenCalledWith({
      where: { id: 'model-source' },
      data: { defaultRoute: { connect: { id: 'route-backup' } } },
    });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'ROUTE_REMAPPED' }),
    }));
    expect(priceUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ previousModelId: 'model-source', replacementDefaultRouteId: 'route-backup' });
  });

  it('unmaps a route without deleting its identity, cost, or discovery history', async () => {
    const route = {
      id: 'route-2',
      canonicalModelId: 'model-video',
      canonicalModel: {
        id: 'model-video',
        canonicalModelKey: 'video-model',
        modality: 'video',
      },
      channelId: 'channel-video',
      channel: { id: 'channel-video', priority: 4 },
      provider: 'NEW_API',
      upstreamModelId: 'vendor/video-v3',
      enabled: true,
      priority: 4,
      upstreamAvailable: true,
      capabilitiesOverride: { durations: [5, 10] },
      costProfile: { cnyPerSecond: 0.42 },
      metadata: { upstreamLabel: 'Video V3' },
      lastSyncedAt: new Date('2026-09-09T07:30:00.000Z'),
      updatedAt,
    };
    const routeUpdate = vi.fn(async () => ({ count: 1 }));
    const routeDelete = vi.fn();
    const aliasDelete = vi.fn(async () => ({}));
    const discoveryUpsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'discovery-1', ...create }));
    const auditCreate = vi.fn(async () => ({}));
    const modelUpdate = vi.fn(async () => ({}));
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => route),
        updateMany: routeUpdate,
        findFirst: vi.fn(async () => null),
        findUniqueOrThrow: vi.fn(async () => ({ ...route, canonicalModelId: null, enabled: false })),
        delete: routeDelete,
      },
      aiModel: {
        findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: object }) => (
          include
            ? { id: where.id, pricing: null, routes: [] }
            : { id: where.id, canonicalModelKey: 'video-model', defaultRouteId: route.id }
        )),
        update: modelUpdate,
      },
      aiModelAlias: {
        findUnique: vi.fn(async () => ({
          id: 'alias-route-2',
          canonicalModelId: 'model-video',
          source: 'ADMIN_MAPPING',
        })),
        delete: aliasDelete,
      },
      aiUpstreamDiscovery: { upsert: discoveryUpsert },
      adminOperation: { create: auditCreate },
    };

    const result = await unmapAdminAiRoute(withTransaction(transaction), route.id, {
      currentCanonicalModelId: route.canonicalModelId,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(routeUpdate).toHaveBeenCalledWith({
      where: { id: route.id, canonicalModelId: route.canonicalModelId, updatedAt },
      data: { canonicalModelId: null, enabled: false },
    });
    expect(routeDelete).not.toHaveBeenCalled();
    expect(aliasDelete).toHaveBeenCalledWith({ where: { id: 'alias-route-2' } });
    expect(modelUpdate).toHaveBeenCalledWith({
      where: { id: 'model-video' },
      data: { defaultRoute: { disconnect: true } },
    });
    expect(discoveryUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        status: 'UNMAPPED',
        upstreamModelId: route.upstreamModelId,
        discoveredCost: route.costProfile,
        metadata: route.metadata,
      }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'ROUTE_UNMAPPED' }),
    }));
    expect(result.route).toMatchObject({ id: route.id, canonicalModelId: null, enabled: false });
  });

  it('rejects a stale remap before changing aliases or route ownership', async () => {
    const routeUpdate = vi.fn();
    const aliasUpdate = vi.fn();
    const auditCreate = vi.fn();
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => ({
          id: 'route-stale',
          canonicalModelId: 'model-old',
          canonicalModel: { id: 'model-old', canonicalModelKey: 'old-image', modality: 'image' },
          updatedAt,
        })),
        updateMany: routeUpdate,
      },
      aiModel: { findUnique: vi.fn(async () => ({ id: 'model-new', canonicalModelKey: 'new-image', modality: 'image' })) },
      aiModelAlias: { update: aliasUpdate },
      adminOperation: { create: auditCreate },
    };

    await expect(remapAdminAiRoute(withTransaction(transaction), 'route-stale', {
      canonicalModelKey: 'new-image',
      currentCanonicalModelId: 'model-old',
      expectedUpdatedAt: '2026-09-09T07:59:59.000Z',
    }, context)).rejects.toMatchObject<AiModelAdminError>({ code: 'CONFLICT', statusCode: 409 });
    expect(routeUpdate).not.toHaveBeenCalled();
    expect(aliasUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('rejects remapping a route to a different modality', async () => {
    const routeUpdate = vi.fn();
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => ({
          id: 'route-image',
          canonicalModelId: 'model-image',
          canonicalModel: { id: 'model-image', canonicalModelKey: 'image-model', modality: 'image' },
          updatedAt,
        })),
        updateMany: routeUpdate,
      },
      aiModel: {
        findUnique: vi.fn(async () => ({ id: 'model-chat', canonicalModelKey: 'chat-model', modality: 'chat' })),
      },
    };

    await expect(remapAdminAiRoute(withTransaction(transaction), 'route-image', {
      canonicalModelKey: 'chat-model',
      currentCanonicalModelId: 'model-image',
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context)).rejects.toMatchObject<AiModelAdminError>({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(routeUpdate).not.toHaveBeenCalled();
  });

  it('preserves a conflicting manual alias when mapping a discovery', async () => {
    const routeUpsert = vi.fn(async () => ({
      id: 'route-new',
      canonicalModelId: 'model-target',
      provider: 'NEW_API',
      upstreamModelId: 'vendor/model',
    }));
    const aliasUpdate = vi.fn();
    const aliasDelete = vi.fn();
    const transaction = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => ({
          id: 'discovery-new',
          status: 'UNMAPPED',
          updatedAt,
          provider: 'NEW_API',
          channelId: 'channel-new',
          upstreamModelId: 'vendor/model',
          suggestedModality: 'image',
          availability: 'AVAILABLE',
          lastSyncedAt: updatedAt,
          channel: { priority: 5 },
        })),
      },
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-target',
          canonicalModelKey: 'target-image',
          modality: 'image',
        })),
      },
      aiModelRoute: { upsert: routeUpsert },
      aiModelAlias: {
        findUnique: vi.fn(async () => ({
          id: 'manual-alias',
          canonicalModelId: 'model-other',
          source: 'ADMIN',
        })),
        update: aliasUpdate,
        delete: aliasDelete,
      },
    };

    await expect(mapDiscoveryToCanonical(
      withTransaction(transaction),
      'discovery-new',
      'target-image',
      updatedAt.toISOString(),
      context,
    )).rejects.toMatchObject<AiModelAdminError>({ code: 'CONFLICT', statusCode: 409 });
    expect(routeUpsert).toHaveBeenCalled();
    expect(aliasUpdate).not.toHaveBeenCalled();
    expect(aliasDelete).not.toHaveBeenCalled();
  });

  it('unmaps, syncs, and remaps the same route after discovery synchronization changes its timestamp', async () => {
    const sourceModel = {
      id: 'model-round-trip-source',
      canonicalModelKey: 'round-trip-source',
      displayName: 'Round Trip Source',
      modality: 'image',
      defaultRouteId: null,
    };
    const targetModel = {
      id: 'model-round-trip-target',
      canonicalModelKey: 'round-trip-target',
      displayName: 'Round Trip Target',
      modality: 'image',
      defaultRouteId: null,
    };
    let route = {
      id: 'route-round-trip',
      canonicalModelId: sourceModel.id as string | null,
      canonicalModel: sourceModel,
      channelId: 'channel-round-trip',
      channel: { id: 'channel-round-trip', priority: 17 },
      provider: 'NEW_API',
      upstreamModelId: 'vendor/image-round-trip',
      enabled: true,
      priority: 17,
      upstreamAvailable: true,
      healthStatus: 'HEALTHY',
      capabilitiesOverride: { supportedResolutions: ['2k', '4k'] },
      costProfile: { cnyPerImageByResolution: { '2k': 0.18, '4k': 0.32 } },
      metadata: { upstreamLabel: 'Round Trip Image' },
      lastSyncedAt: new Date('2026-09-09T07:30:00.000Z'),
      updatedAt,
    };
    const original = {
      id: route.id,
      upstreamModelId: route.upstreamModelId,
      channelId: route.channelId,
      costProfile: route.costProfile,
      priority: route.priority,
    };
    let discovery: Record<string, unknown> | null = null;
    let alias: Record<string, unknown> | null = {
      id: 'alias-round-trip',
      canonicalModelId: sourceModel.id,
      source: 'ROUTE_MAPPING',
    };
    const discoveryUpdate = vi.fn(async ({ where, data }: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      if (!discovery || discovery.id !== where.id || discovery.status !== where.status) return { count: 0 };
      discovery = { ...discovery, ...data, updatedAt: new Date('2026-09-09T08:10:00.000Z') };
      return { count: 1 };
    });
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => route),
        updateMany: vi.fn(async ({ where, data }: {
          where: { id: string; canonicalModelId: string; updatedAt: Date };
          data: { canonicalModelId: null; enabled: false };
        }) => {
          if (where.id !== route.id
            || where.canonicalModelId !== route.canonicalModelId
            || where.updatedAt !== route.updatedAt) return { count: 0 };
          route = {
            ...route,
            ...data,
            canonicalModel: sourceModel,
            updatedAt: new Date('2026-09-09T08:01:00.000Z'),
          };
          return { count: 1 };
        }),
        findFirst: vi.fn(async () => null),
        findUniqueOrThrow: vi.fn(async () => route),
        upsert: vi.fn(async ({ update }: { update: { canonicalModelId: string; enabled: false } }) => {
          route = {
            ...route,
            ...update,
            canonicalModel: targetModel,
            updatedAt: new Date('2026-09-09T08:10:00.000Z'),
          };
          return route;
        }),
      },
      aiModel: {
        findUnique: vi.fn(async ({ where, include }: {
          where: { id?: string; canonicalModelKey?: string };
          include?: object;
        }) => {
          const model = where.canonicalModelKey === targetModel.canonicalModelKey || where.id === targetModel.id
            ? targetModel
            : where.id === sourceModel.id ? sourceModel : null;
          return model && include ? { ...model, pricing: null, routes: [] } : model;
        }),
        update: vi.fn(async () => ({})),
      },
      aiModelAlias: {
        findUnique: vi.fn(async () => alias),
        delete: vi.fn(async () => { alias = null; }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          alias = { id: 'alias-round-trip-remapped', ...data };
          return alias;
        }),
      },
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery && { ...discovery, channel: route.channel }),
        upsert: vi.fn(async ({ create, update }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          discovery = discovery
            ? { ...discovery, ...update, updatedAt: new Date('2026-09-09T08:01:00.000Z') }
            : { id: 'discovery-round-trip', ...create, updatedAt: new Date('2026-09-09T08:01:00.000Z') };
          return discovery;
        }),
        updateMany: discoveryUpdate,
      },
      adminOperation: { create: vi.fn(async () => ({})) },
    };
    const prisma = withTransaction(transaction);

    await unmapAdminAiRoute(prisma, route.id, {
      currentCanonicalModelId: sourceModel.id,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(route).toMatchObject({ id: original.id, canonicalModelId: null, enabled: false });
    expect(discovery).toMatchObject({ status: 'UNMAPPED' });
    const pageUpdatedAt = (discovery as { updatedAt: Date }).updatedAt;
    const syncedAt = new Date('2026-09-09T08:05:00.000Z');
    discovery = {
      ...discovery,
      updatedAt: syncedAt,
      lastSyncedAt: syncedAt,
      metadata: { upstreamLabel: 'Round Trip Image', syncRevision: 2 },
    };

    await expect(mapDiscoveryToCanonical(
      prisma,
      (discovery as { id: string }).id,
      targetModel.canonicalModelKey,
      pageUpdatedAt.toISOString(),
      context,
    )).resolves.toMatchObject({ id: original.id, canonicalModelId: targetModel.id });

    expect(route).toMatchObject({
      id: original.id,
      upstreamModelId: original.upstreamModelId,
      channelId: original.channelId,
      costProfile: original.costProfile,
      priority: original.priority,
      canonicalModelId: targetModel.id,
      enabled: false,
    });
    expect(discovery).toMatchObject({
      status: 'MAPPED',
      suggestedModelId: targetModel.id,
      lastSyncedAt: syncedAt,
      metadata: { upstreamLabel: 'Round Trip Image', syncRevision: 2 },
    });
    expect(discoveryUpdate).toHaveBeenCalledWith({
      where: { id: 'discovery-round-trip', status: 'UNMAPPED' },
      data: { status: 'MAPPED', suggestedModelId: targetModel.id },
    });
  });

  it('allows only one of two concurrent mappings to claim an unmapped discovery', async () => {
    const models = [{ id: 'model-concurrent-a', canonicalModelKey: 'concurrent-a', modality: 'image' }, {
      id: 'model-concurrent-b', canonicalModelKey: 'concurrent-b', modality: 'image',
    }];
    let discoveryStatus = 'UNMAPPED';
    let discoveryReads = 0;
    let releaseReads!: () => void;
    const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve; });
    const discoveryUpdate = vi.fn(async ({ where, data }: {
      where: { id: string; status: string };
      data: { status: string };
    }) => {
      if (where.id !== 'discovery-concurrent' || discoveryStatus !== where.status) return { count: 0 };
      discoveryStatus = data.status;
      return { count: 1 };
    });
    const transaction = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => {
          discoveryReads += 1;
          if (discoveryReads === 2) releaseReads();
          await bothReadsStarted;
          return {
            id: 'discovery-concurrent',
            status: 'UNMAPPED',
            updatedAt,
            provider: 'NEW_API',
            channelId: 'channel-concurrent',
            upstreamModelId: 'vendor/concurrent-image',
            suggestedModality: 'image',
            availability: 'AVAILABLE',
            lastSyncedAt: updatedAt,
            channel: { priority: 9 },
          };
        }),
        updateMany: discoveryUpdate,
      },
      aiModel: {
        findUnique: vi.fn(async ({ where, include }: {
          where: { id?: string; canonicalModelKey?: string };
          include?: object;
        }) => {
          const model = models.find(item => item.id === where.id || item.canonicalModelKey === where.canonicalModelKey) ?? null;
          return model && include ? { ...model, pricing: null, routes: [] } : model;
        }),
      },
      aiModelRoute: {
        upsert: vi.fn(async ({ update }: { update: { canonicalModelId: string } }) => ({
          id: 'route-concurrent',
          canonicalModelId: update.canonicalModelId,
          provider: 'NEW_API',
          upstreamModelId: 'vendor/concurrent-image',
        })),
      },
      aiModelAlias: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
      adminOperation: { create: vi.fn(async () => ({})) },
    };
    const prisma = withTransaction(transaction);

    const results = await Promise.allSettled(models.map((model, index) => mapDiscoveryToCanonical(
      prisma,
      'discovery-concurrent',
      model.canonicalModelKey,
      updatedAt.toISOString(),
      { actor: 'admin-api', requestId: `concurrent-${index}` },
    )));

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CONFLICT', statusCode: 409 }),
    });
    expect(discoveryStatus).toBe('MAPPED');
    expect(discoveryUpdate).toHaveBeenCalledTimes(2);
    for (const [call] of discoveryUpdate.mock.calls) {
      expect(call.where).toEqual({ id: 'discovery-concurrent', status: 'UNMAPPED' });
    }
  });

  it('does not let a late sync downgrade a discovery after its route was remapped', async () => {
    const provider = {
      id: 'provider-sync-race',
      name: 'provider-sync-race',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.8.8',
      defaultModel: null,
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['IMAGE'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'vendor/sync-race-image' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const staleRoute = {
      id: 'route-sync-race',
      canonicalModelId: null,
      upstreamAvailable: true,
      healthStatus: 'HEALTHY',
      costProfile: null,
      metadata: null,
    };
    const discovery = { id: 'discovery-sync-race', status: 'MAPPED', suggestedModelId: 'model-remapped' };
    const discoveryUpsert = vi.fn();
    const routeRecheck = vi.fn(async () => ({ canonicalModelId: 'model-remapped' }));
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: {
        findFirst: vi.fn(async () => staleRoute),
        findUnique: routeRecheck,
        update: vi.fn(async () => ({})),
      },
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        upsert: discoveryUpsert,
      },
    } as unknown as PrismaClient;

    await expect(syncUpstreamModels(prisma, provider.id)).resolves.toMatchObject({ mapped: 1, unmapped: 0 });

    expect(routeRecheck).toHaveBeenCalledWith({
      where: { id: staleRoute.id },
      select: { canonicalModelId: true },
    });
    expect(discoveryUpsert).not.toHaveBeenCalled();
    expect(discovery).toEqual({
      id: 'discovery-sync-race',
      status: 'MAPPED',
      suggestedModelId: 'model-remapped',
    });
  });
});

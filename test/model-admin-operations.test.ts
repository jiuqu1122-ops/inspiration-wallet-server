import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  AiModelAdminError,
  createCanonicalFromDiscovery,
  deleteAdminAiModel,
  mapDiscoveryToCanonical,
  remapAdminAiRoute,
  unmapAdminAiRoute,
} from '../src/modules/ai/model-admin.js';

const context = { actor: 'admin-api', requestId: 'request-test' };
const updatedAt = new Date('2026-09-09T08:00:00.000Z');

function withTransaction<T extends object>(transaction: T) {
  return {
    $transaction: vi.fn(async (callback: (client: T) => unknown) => callback(transaction)),
  } as unknown as PrismaClient;
}

describe('AI Model Center route operations', () => {
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

  it('creates a canonical model and maps its discovery in one transaction', async () => {
    const discovery = {
      id: 'discovery-create',
      status: 'UNMAPPED',
      updatedAt,
      provider: 'NEW_API',
      channelId: 'channel-create',
      upstreamModelId: 'vendor/new-image',
      suggestedModality: 'image',
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
    const transaction = {
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        updateMany: vi.fn(async () => ({ count: 1 })),
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
      expectedUpdatedAt: updatedAt.toISOString(),
    }, context);

    expect(transactionRunner).toHaveBeenCalledTimes(1);
    expect(modelCreate).toHaveBeenCalledOnce();
    expect(routeUpsert).toHaveBeenCalledOnce();
    expect(result).toEqual(model);
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
});

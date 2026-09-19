import { Prisma, type AiProviderChannel, type PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import {
  ModelCatalogError,
  assertCanonicalModelIdentity,
  defaultModelCapabilities,
  explicitCanonicalModelKey,
  getPublicAiCatalog,
  normalizeModelCapabilities,
  resolveAutomaticChatModel,
  resolveCatalogModel,
} from '../src/modules/ai/model-catalog.js';
import {
  buildClientPricingProjection,
  catalogProfileToImagePrice,
  calculateSnapshotCharge,
  capturePricingSnapshot,
  estimateSnapshotCredits,
  publishPendingPrice,
  resolveMembershipContextCredits,
  setPendingPrice,
  validatePricingCapabilities,
  validatePricingProfile,
  type CatalogPricingProfile,
  type PricingSnapshot,
} from '../src/modules/ai/pricing-center.js';
import { syncUpstreamModels } from '../src/modules/ai/upstream-sync.js';
import { updateAdminAiRoute, updatePricingPolicy } from '../src/modules/ai/model-admin.js';
import {
  executeWalletAgentChat,
  getAgentRequestCredits,
  listWalletAgentModels,
} from '../src/modules/ai/service.js';
import { listWalletImageModels } from '../src/modules/ai/image-service.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';
import { ensureAiCatalogSeeded } from '../src/modules/ai/catalog-seed.js';

const snapshot = (
  modality: 'chat' | 'image' | 'video',
  pricing: CatalogPricingProfile,
  request: PricingSnapshot['request'],
  overrides: Partial<PricingSnapshot> = {},
): PricingSnapshot => ({
  schemaVersion: 1,
  canonicalModelId: 'model-1',
  canonicalModelKey: `${modality}-model`,
  modality,
  routeId: 'route-a',
  priceVersionId: 'price-10',
  priceVersion: 10,
  billingType: pricing.billingType,
  pricing,
  request,
  capturedAt: '2026-09-07T00:00:00.000Z',
  ...overrides,
});

const astraPricing = {
  billingType: 'token',
  contextThresholdTokens: 272_000,
  standard: {
    inputCreditsPerMillion: '300',
    outputCreditsPerMillion: '1500',
    cachedInputCreditsPerMillion: '30',
    cacheWriteCreditsPerMillion: '375',
  },
  extended: {
    inputCreditsPerMillion: '600',
    outputCreditsPerMillion: '2250',
    cachedInputCreditsPerMillion: '60',
    cacheWriteCreditsPerMillion: '750',
  },
} satisfies CatalogPricingProfile;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canonical model mapping', () => {
  it('stops dispatch when an explicit canonical identity changes during resolution', () => {
    expect(() => assertCanonicalModelIdentity('chat-model-a', 'chat-model-b')).toThrow(expect.objectContaining({
      code: 'MODEL_IDENTITY_MISMATCH',
      statusCode: 409,
    }));
    expect(() => assertCanonicalModelIdentity('Chat-Model-A', 'chat-model-a')).not.toThrow();
  });

  it('gives administrator-created GPT Image 2.5 variants exact pixel dimensions', () => {
    expect(defaultModelCapabilities('gpt-image-2.5-high', 'image')).toMatchObject({
      supportedResolutions: ['1k', '2k', '4k'],
      supportedAspectRatiosByResolution: {
        '1k': expect.arrayContaining(['1024x1024', '1280x720', '720x1280']),
        '2k': expect.arrayContaining(['2048x1152', '2064x1376']),
        '4k': expect.arrayContaining(['3840x2160', '3520x2352']),
      },
    });
  });

  it('maps explicitly confirmed provider aliases to one canonical image SKU', () => {
    expect(explicitCanonicalModelKey('image', 'gemini-3.1-pro-image-preview')).toBe('nano-banana-pro');
    expect(explicitCanonicalModelKey('image', 'xais-nano-pro')).toBe('nano-banana-pro');
    expect(explicitCanonicalModelKey('image', 'nano-banana-pro')).toBe('nano-banana-pro');
  });

  it('keeps fast and standard products as separate canonical SKUs', () => {
    expect(explicitCanonicalModelKey('image', 'nano-banana-pro-fast')).toBe('nano-banana-pro-fast');
    expect(explicitCanonicalModelKey('image', 'nano-banana-pro')).toBe('nano-banana-pro');
    expect(explicitCanonicalModelKey(
      'image',
      'gemini-3.1-pro-image-preview',
      ['IMAGE_NANO_BANANA_PRO_FAST'],
    )).toBe('nano-banana-pro-fast');
  });

  it('does not turn a normalized near-match into an implicit mapping', () => {
    expect(explicitCanonicalModelKey('image', 'unreviewed-product-preview')).toBeNull();
    expect(explicitCanonicalModelKey('image', 'unreviewed-product')).toBeNull();
  });

  it('rejects disabled models and ignores stale managed provider-channel hints', async () => {
    const disabledPrisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-1',
          canonicalModelKey: 'disabled-model',
          modality: 'image',
          enabled: false,
          routes: [],
        })),
      },
    } as unknown as PrismaClient;
    await expect(resolveCatalogModel(disabledPrisma, 'disabled-model', 'image'))
      .rejects.toMatchObject<ModelCatalogError>({ code: 'MODEL_NOT_AVAILABLE' });

    const channelA = { id: 'channel-a', status: 'ACTIVE' };
    const routedPrisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-1',
          canonicalModelKey: 'routed-model',
          modality: 'image',
          enabled: true,
          routingMode: 'MANAGED',
          defaultRouteId: 'route-a',
          routes: [{
            id: 'route-a',
            channelId: 'channel-a',
            enabled: true,
            upstreamAvailable: true,
            healthStatus: 'HEALTHY',
            channel: channelA,
          }],
        })),
      },
    } as unknown as PrismaClient;
    await expect(resolveCatalogModel(routedPrisma, 'routed-model', 'image', {
      providerChannelId: 'channel-not-mapped',
    })).resolves.toMatchObject({ route: { id: 'route-a' } });
  });

  it('auto selection skips a model whose recorded operational routes are all disabled', async () => {
    const activeChannel = { id: 'channel-b', status: 'ACTIVE' };
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [
          {
            id: 'model-a',
            canonicalModelKey: 'chat-a',
            routingMode: 'MANAGED',
            defaultRouteId: null,
            routes: [{
              id: 'route-disabled',
              channelId: 'channel-a',
              enabled: false,
              upstreamAvailable: true,
              healthStatus: 'HEALTHY',
              channel: { id: 'channel-a', status: 'ACTIVE' },
            }],
          },
          {
            id: 'model-b',
            canonicalModelKey: 'chat-b',
            routingMode: 'MANAGED',
            defaultRouteId: 'route-b',
            routes: [{
              id: 'route-b',
              channelId: 'channel-b',
              enabled: true,
              upstreamAvailable: true,
              healthStatus: 'HEALTHY',
              channel: activeChannel,
            }],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const resolved = await resolveAutomaticChatModel(prisma);
    expect(resolved?.model.canonicalModelKey).toBe('chat-b');
    expect(resolved?.route?.id).toBe('route-b');
  });

  it('keeps legacy provider fallback available when synced routes are still disabled', async () => {
    const prisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-legacy',
          canonicalModelKey: 'legacy-image',
          modality: 'image',
          enabled: true,
          routingMode: 'LEGACY',
          defaultRouteId: null,
          routes: [{
            id: 'route-disabled',
            channelId: 'channel-a',
            enabled: false,
            upstreamAvailable: true,
            healthStatus: 'HEALTHY',
            channel: { id: 'channel-a', status: 'ACTIVE' },
          }],
        })),
      },
    } as unknown as PrismaClient;

    const resolved = await resolveCatalogModel(prisma, 'legacy-image', 'image');
    expect(resolved?.route).toBeNull();
    expect(resolved?.enabledRoutes).toEqual([]);
  });

  it('blocks managed models when every upstream route is disabled', async () => {
    const prisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-managed',
          canonicalModelKey: 'managed-image',
          modality: 'image',
          enabled: true,
          routingMode: 'MANAGED',
          defaultRouteId: null,
          routes: [{
            id: 'route-disabled',
            channelId: 'channel-a',
            enabled: false,
            upstreamAvailable: true,
            healthStatus: 'HEALTHY',
            channel: { id: 'channel-a', status: 'ACTIVE' },
          }],
        })),
      },
    } as unknown as PrismaClient;

    await expect(resolveCatalogModel(prisma, 'managed-image', 'image'))
      .rejects.toMatchObject<ModelCatalogError>({ code: 'MODEL_ROUTE_NOT_AVAILABLE' });
  });

  it('switches a model to managed routing when an admin enables a route', async () => {
    const updatedAt = new Date('2026-09-09T00:00:00.000Z');
    const updateRoute = vi.fn(async () => ({ count: 1 }));
    const updateModel = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'model-a',
      ...data,
    }));
    const transaction = {
      aiModelRoute: {
        findUnique: vi.fn(async () => ({
          id: 'route-a',
          canonicalModelId: 'model-a',
          costProfile: null,
          enabled: false,
          updatedAt,
        })),
        updateMany: updateRoute,
        findUniqueOrThrow: vi.fn(async () => ({ id: 'route-a', canonicalModelId: 'model-a', enabled: true })),
      },
      aiModel: { update: updateModel },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;

    await updateAdminAiRoute(prisma, 'route-a', { enabled: true });
    expect(updateRoute).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'route-a', updatedAt },
      data: { enabled: true },
    }));
    expect(updateModel).toHaveBeenCalledWith({
      where: { id: 'model-a' },
      data: { routingMode: 'MANAGED' },
    });
  });
});

describe('versioned server-side pricing', () => {
  it.each(['canvas_text_agent', 'prompt_optimization', 'workflow'])(
    'charges %s at the CANVAS_TEXT fixed per-request price',
    usageContext => {
      const fixed = calculateSnapshotCharge(snapshot('chat', astraPricing, {
        usageContext,
        fallbackCredits: '10',
        fixedUsageCredits: '1.000000',
      }), {
        usage: {
          inputTokens: 500_000n,
          cachedInputTokens: 0n,
          cacheWriteTokens: 0n,
          outputTokens: 500_000n,
        },
      });
      expect(fixed.billingType).toBe('request_fixed');
      expect(fixed.totalCredits).toBe('1.000000');
      expect(fixed.details.usage).toEqual({
        inputTokens: '500000',
        normalInputTokens: '500000',
        cachedInputTokens: '0',
        cacheWriteTokens: '0',
        outputTokens: '500000',
      });
    },
  );

  it('uses the CANVAS_TEXT fixed price for workflow billing', () => {
    const fixed = calculateSnapshotCharge(snapshot('chat', astraPricing, {
      usageContext: 'workflow',
      fallbackCredits: '10',
      fixedUsageCredits: '1.000000',
    }), {
      usage: {
        inputTokens: 500_000n,
        cachedInputTokens: 0n,
        cacheWriteTokens: 0n,
        outputTokens: 500_000n,
      },
    });
    expect(fixed.billingType).toBe('request_fixed');
    expect(fixed.totalCredits).toBe('1.000000');
  });

  it('keeps ordinary chat on token billing', () => {
    const token = calculateSnapshotCharge(snapshot('chat', astraPricing, {
      usageContext: 'chat',
      fallbackCredits: '3',
    }), {
      usage: {
        inputTokens: 500_000n,
        cachedInputTokens: 0n,
        cacheWriteTokens: 0n,
        outputTokens: 500_000n,
      },
    });
    expect(token.billingType).toBe('token');
    expect(token.totalCredits).not.toBe('3.000000');
  });

  it('does not reserve the fixed fallback for post-billed token chat', () => {
    const token = snapshot('chat', astraPricing, {
      usageContext: 'chat',
      fallbackCredits: '10',
    });
    expect(estimateSnapshotCredits(token)).toBe('0.000001');
  });

  it.each(['canvas_text_agent', 'prompt_optimization', 'workflow'])(
    'reserves the fixed price for token-backed %s requests',
    usageContext => {
      const token = snapshot('chat', astraPricing, {
        usageContext,
        fallbackCredits: '1.000000',
      });
      expect(estimateSnapshotCredits(token)).toBe('1.000000');
    },
  );

  it('applies the membership Chat fold to token rates at settlement time', async () => {
    const prisma = {
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: { id: 'price-chat-fold', version: 1, pricing: astraPricing },
        })),
      },
      userMembership: {
        findFirst: vi.fn(async () => ({
          plan: { versions: [{ prices: { agentRequest: '100', discounts: { chat: '5' } } }] },
        })),
      },
    } as unknown as PrismaClient;
    const captured = await capturePricingSnapshot(prisma, {
      id: 'chat-1', canonicalModelKey: 'gpt-6-astra', modality: 'chat', billingType: 'token',
    }, null, { usageContext: 'chat', fallbackCredits: '50' }, 'user-chat');
    expect(estimateSnapshotCredits(captured)).toBe('0.000001');
    expect(calculateSnapshotCharge(captured, {
      usage: { inputTokens: 1_000_000n, cachedInputTokens: 0n, cacheWriteTokens: 0n, outputTokens: 1_000_000n },
    }).totalCredits).toBe('1425.000000');
  });

  it('ignores legacy fixed Agent prices when resolving ordinary Chat fallback', async () => {
    const prisma = {
      userMembership: {
        findFirst: vi.fn(async () => ({
          plan: { versions: [{ prices: { agentRequest: '100', discounts: { chat: '5' } } }] },
        })),
      },
    } as unknown as PrismaClient;
    await expect(resolveMembershipContextCredits(prisma, 'user-chat', 'chat', 10n)).resolves.toBe('5.000000');
  });

  it('uses Astra standard pricing at 272000 and extended pricing at 272001', () => {
    const standard = calculateSnapshotCharge(snapshot('chat', astraPricing, {}), {
      usage: {
        inputTokens: 272_000n,
        cachedInputTokens: 72_000n,
        cacheWriteTokens: 100_000n,
        outputTokens: 100_000n,
      },
    });
    const extended = calculateSnapshotCharge(snapshot('chat', astraPricing, {}), {
      usage: {
        inputTokens: 272_001n,
        cachedInputTokens: 72_000n,
        cacheWriteTokens: 100_000n,
        outputTokens: 100_000n,
      },
    });
    expect(standard.details).toMatchObject({ contextTier: 'standard' });
    expect(standard.totalCredits).toBe('249.660000');
    expect(extended.details).toMatchObject({ contextTier: 'extended' });
    expect(extended.totalCredits).toBe('424.320600');
  });

  it.each([
    ['1k', '30.000000'],
    ['2k', '48.000000'],
    ['4k', '60.000000'],
  ])('prices image resolution %s and count from the captured snapshot', (resolution, expected) => {
    const result = calculateSnapshotCharge(snapshot('image', {
      billingType: 'image_resolution',
      creditsPerImageByResolution: { '1k': '10', '2k': '16', '4k': '20' },
    }, { resolution, count: 3 }));
    expect(result.totalCredits).toBe(expected);
  });

  it('supports flat-per-request and per-image-count billing', () => {
    const flat = calculateSnapshotCharge(snapshot('image', {
      billingType: 'image_flat',
      creditsPerRequest: '9.5',
    }, { count: 4 }), { generatedCount: 3 });
    const counted = calculateSnapshotCharge(snapshot('image', {
      billingType: 'image_count',
      creditsPerImage: '2.25',
    }, { count: 4 }), { generatedCount: 3 });
    expect(flat.totalCredits).toBe('9.500000');
    expect(flat.quantity).toBe('1');
    expect(counted.totalCredits).toBe('6.750000');
    expect(counted.quantity).toBe('3');
  });

  it('projects explicit image billing fields while retaining legacy compatibility fields', () => {
    expect(catalogProfileToImagePrice('flat-image', {
      billingType: 'image_flat',
      creditsPerRequest: '7.5',
    })).toEqual({
      model: 'flat-image',
      billingType: 'image_flat',
      creditsPerRequest: '7.5',
      credits1k: '7.5',
      credits2k: '7.5',
      credits4k: '7.5',
    });
    expect(catalogProfileToImagePrice('count-image', {
      billingType: 'image_count',
      creditsPerImage: '2.25',
    })).toEqual({
      model: 'count-image',
      billingType: 'image_count',
      creditsPerImage: '2.25',
      credits1k: '2.25',
      credits2k: '2.25',
      credits4k: '2.25',
    });
  });

  it('uses one video base billing strategy and then adds reference surcharges', () => {
    const result = calculateSnapshotCharge(snapshot('video', {
      billingType: 'video_resolution_duration',
      credits: '2',
      creditsPerSecond: '2',
      creditsPerVideo: '3',
      creditsByResolution: { '1080p': '1' },
      creditsByInputMode: { ref: '2' },
      includedReferenceImages: 1,
      creditsPerExtraReferenceImage: '4',
      creditsPerReferenceVideoSecond: '0.5',
      referenceVideoCreditsByResolution: { '4k': '0.5' },
    }, {
      duration: 5,
      resolution: '1080p',
      count: 2,
      referenceImageCount: 3,
      referenceVideoCount: 1,
      referenceVideoSeconds: 5,
      referenceVideoResolution: '4k',
      inputMode: 'REF',
    }));
    expect(result.baseCharge).toBe('10.000000');
    expect(result.surcharges).toEqual([
      { type: 'extra_reference_images', quantity: '4', credits: '16.000000' },
      { type: 'reference_video_seconds', quantity: '10', credits: '10.000000' },
    ]);
    expect(result.totalCredits).toBe('36.000000');
  });

  it.each([
    ['video_flat', { creditsPerVideo: '15', creditsPerSecond: '999' }, { duration: 4, count: 1 }, '15.000000'],
    ['video_flat', { creditsPerVideo: '15', creditsPerSecond: '999' }, { duration: 15, count: 2 }, '30.000000'],
    ['video_second', { creditsPerSecond: '15', creditsPerVideo: '999' }, { duration: 4, count: 1 }, '60.000000'],
    ['video_duration', { creditsByDuration: { '10': '80', '15': '110' } }, { duration: 10, count: 1 }, '80.000000'],
    ['video_resolution_duration', { creditsByResolution: { '768p': '5', '2k': '9' } }, { duration: 10, count: 1, resolution: '768p' }, '50.000000'],
  ] as const)('charges %s without adding stale base fields', (billingType, fields, request, expected) => {
    const result = calculateSnapshotCharge(snapshot('video', {
      billingType,
      ...fields,
    }, request));
    expect(result.totalCredits).toBe(expected);
  });

  it('keeps an in-flight request on its captured version when a new price is published', async () => {
    const storedPricing = {
      billingType: 'image_resolution',
      creditsPerImageByResolution: { '1k': '10', '2k': '16', '4k': '20' },
    } satisfies CatalogPricingProfile;
    const prisma = {
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: { id: 'price-10', version: 10, pricing: storedPricing },
        })),
      },
    } as unknown as PrismaClient;
    const captured = await capturePricingSnapshot(prisma, {
      id: 'model-1',
      canonicalModelKey: 'nano-banana-pro',
      modality: 'image',
      billingType: 'image_resolution',
    }, 'route-a', { resolution: '2k', count: 2 });
    storedPricing.creditsPerImageByResolution['2k'] = '99';
    expect(captured.priceVersion).toBe(10);
    expect(calculateSnapshotCharge(captured).totalCredits).toBe('32.000000');
  });

  it('does not change sell price or price version when the route switches', () => {
    const price = {
      billingType: 'image_resolution',
      creditsPerImageByResolution: { '2k': '16', '4k': '20' },
    } satisfies CatalogPricingProfile;
    const routeA = calculateSnapshotCharge(snapshot('image', price, { resolution: '2k', count: 1 }));
    const routeB = calculateSnapshotCharge(snapshot('image', price, { resolution: '2k', count: 1 }, {
      routeId: 'route-b',
    }));
    expect(routeB.totalCredits).toBe(routeA.totalCredits);
    expect(routeB.priceVersion).toBe(routeA.priceVersion);
    expect(routeB.route).toBe('route-b');
  });

  it('keeps Pending separate until Publish creates the next immutable version', async () => {
    const upsert = vi.fn(async (input: unknown) => input);
    const pendingPrisma = {
      aiModel: { findUnique: vi.fn(async () => ({ id: 'model-1', modality: 'image', billingType: 'image_resolution' })) },
      aiModelPricing: { upsert },
    } as unknown as PrismaClient;
    const pending = {
      billingType: 'image_resolution',
      creditsPerImageByResolution: { '2k': '18', '4k': '22' },
    };
    await setPendingPrice(pendingPrisma, 'nano-banana-pro', pending);
    expect(upsert).toHaveBeenCalledOnce();

    const createVersion = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'price-11',
      ...data,
    }));
    const updateWorkspace = vi.fn(async (input: unknown) => input);
    const legacyAiWrite = vi.fn();
    const legacyChatWrite = vi.fn();
    const transaction = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'model-1',
          canonicalModelKey: 'nano-banana-pro',
          modality: 'image',
          billingType: 'image_resolution',
          pricing: { pendingPrice: pending, currentVersion: { version: 10 } },
        })),
        update: vi.fn(async (input: unknown) => input),
      },
      aiPriceVersion: {
        aggregate: vi.fn(async () => ({ _max: { version: 10 } })),
        create: createVersion,
      },
      aiModelPricing: { update: updateWorkspace },
      aiPricingConfig: { upsert: legacyAiWrite },
      chatPricingConfig: { upsert: legacyChatWrite },
    };
    const publishPrisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const published = await publishPendingPrice(publishPrisma, 'nano-banana-pro', 'admin-test');
    expect(published.version).toBe(11);
    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: 'ADMIN_PUBLISH', publishedBy: 'admin-test' }),
    }));
    expect(updateWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentVersionId: 'price-11' }),
    }));
    expect(transaction.aiModel.update).toHaveBeenCalledWith({
      where: { id: 'model-1' },
      data: { billingType: 'image_resolution' },
    });
    expect(legacyAiWrite).not.toHaveBeenCalled();
    expect(legacyChatWrite).not.toHaveBeenCalled();
  });

  it('keeps a pending billing change offline and atomically switches it on publish', async () => {
    const pending = { billingType: 'video_flat', creditsPerVideo: '15' };
    const pendingUpsert = vi.fn(async (input: unknown) => input);
    await setPendingPrice({
      aiModel: { findUnique: vi.fn(async () => ({ id: 'video-1', modality: 'video', billingType: 'video_second' })) },
      aiModelPricing: { upsert: pendingUpsert },
    } as unknown as PrismaClient, 'canonical-video', pending);
    expect(pendingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { pendingPrice: pending },
    }));

    const previousVersion = {
      id: 'video-price-1',
      version: 1,
      pricing: { billingType: 'video_second', creditsPerSecond: '15' },
    };
    const modelUpdate = vi.fn(async (input: unknown) => input);
    const pricingUpdate = vi.fn(async (input: unknown) => input);
    const transaction = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'video-1',
          canonicalModelKey: 'canonical-video',
          modality: 'video',
          billingType: 'video_second',
          capabilities: {},
          pricing: { pendingPrice: pending, currentVersion: previousVersion },
        })),
        update: modelUpdate,
      },
      aiPriceVersion: {
        aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'video-price-2', ...data })),
      },
      aiModelPricing: { update: pricingUpdate },
    };
    const published = await publishPendingPrice({
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient, 'canonical-video');

    expect(published).toMatchObject({ version: 2, pricing: pending });
    expect(pricingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentVersionId: 'video-price-2', pendingPrice: Prisma.JsonNull },
    }));
    expect(modelUpdate).toHaveBeenCalledWith({
      where: { id: 'video-1' },
      data: { billingType: 'video_flat' },
    });
    expect(previousVersion).toEqual({
      id: 'video-price-1',
      version: 1,
      pricing: { billingType: 'video_second', creditsPerSecond: '15' },
    });
  });

  it('requires a price for every supported video resolution before publish', () => {
    expect(() => validatePricingCapabilities('video', {
      billingType: 'video_resolution_duration',
      creditsByResolution: { '768p': '10' },
    }, {
      supportedResolutions: ['768p', '2k'],
    })).toThrow(/2k/);
  });

  it('returns an explicit pricing error when a canonical model has no published version', async () => {
    const prisma = {
      aiModelPricing: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    await expect(capturePricingSnapshot(prisma, {
      id: 'video-model',
      canonicalModelKey: 'future-video',
      modality: 'video',
      billingType: 'video_resolution_duration',
      capabilities: { supportedResolutions: ['768p'] },
    }, null, {})).rejects.toMatchObject({ code: 'PRICING_NOT_AVAILABLE', statusCode: 503 });
  });

  it('accepts dynamic resolution and duration capabilities', () => {
    expect(normalizeModelCapabilities({
      supportedResolutions: ['576P', '864p', '1536p'],
      supportedDurations: [3, 7, 20],
    })).toMatchObject({
      supportedResolutions: ['576p', '864p', '1536p'],
      supportedDurations: [3, 7, 20],
    });
  });

  it('computes markup pricing as a suggestion without publishing it', async () => {
    const upsert = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'astra-model',
          modality: 'chat',
          routes: [{
            costProfile: {
              contextThresholdTokens: 272_000,
              standard: {
                upstreamInputCnyPer1m: '2.272727273',
                upstreamOutputCnyPer1m: '11.36363636',
                upstreamCacheReadCnyPer1m: '0.2272727273',
                upstreamCacheWriteCnyPer1m: '2.840909091',
              },
              extended: {
                upstreamInputCnyPer1m: '4.545454545',
                upstreamOutputCnyPer1m: '17.04545455',
                upstreamCacheReadCnyPer1m: '0.4545454545',
                upstreamCacheWriteCnyPer1m: '5.681818182',
              },
            },
          }],
        })),
      },
      aiModelPricing: { upsert },
    } as unknown as PrismaClient;
    await updatePricingPolicy(prisma, 'gpt-6-astra', {
      pricingMode: 'MARKUP',
      markupMultiplier: '1.32',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        pricingMode: 'MARKUP',
        suggestedPrice: expect.objectContaining({
          billingType: 'token',
          standard: {
            inputCreditsPerMillion: '300',
            outputCreditsPerMillion: '1500',
            cachedInputCreditsPerMillion: '30',
            cacheWriteCreditsPerMillion: '375',
          },
        }),
      }),
    }));
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('update.currentVersionId');
  });

  it('keeps video markup suggestions in the upstream cost billing mode', async () => {
    const upsert = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'flat-video',
          modality: 'video',
          routes: [{
            enabled: true,
            costProfile: { currency: 'USD', billingType: 'video_flat', amountPerVideo: '3' },
          }],
        })),
      },
      aiModelPricing: { upsert },
    } as unknown as PrismaClient;

    await updatePricingPolicy(prisma, 'flat-video', {
      pricingMode: 'MARKUP',
      markupMultiplier: '1.32',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        suggestedPrice: { billingType: 'video_flat', creditsPerVideo: '400' },
      }),
    }));
  });

  it('does not suggest a video price when enabled routes use incompatible cost modes', async () => {
    const upsert = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiModel: {
        findUnique: vi.fn(async () => ({
          id: 'mixed-video',
          modality: 'video',
          routes: [{
            enabled: true,
            costProfile: { currency: 'USD', billingType: 'video_flat', amountPerVideo: '3' },
          }, {
            enabled: true,
            costProfile: { currency: 'USD', billingType: 'video_second', amountPerSecond: '0.06' },
          }],
        })),
      },
      aiModelPricing: { upsert },
    } as unknown as PrismaClient;

    await updatePricingPolicy(prisma, 'mixed-video', {
      pricingMode: 'MARKUP',
      markupMultiplier: '1.32',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ suggestedPrice: Prisma.JsonNull }),
    }));
  });

  it('rejects malformed pricing instead of stringifying objects into charges', () => {
    expect(() => validatePricingProfile('chat', {
      ...astraPricing,
      standard: { ...astraPricing.standard, inputCreditsPerMillion: { bad: true } },
    })).toThrow(/invalid/i);
  });
});

describe('catalog exposure and upstream discovery safety', () => {
  it('projects only capability-backed MiniMax H3 prices for old clients', async () => {
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [{
          canonicalModelKey: 'minimax-h3',
          modality: 'video',
          billingType: 'video_resolution_duration',
          capabilities: { supportedResolutions: ['768p', '2k'] },
          pricing: {
            currentVersion: {
              publishedAt: new Date('2026-09-18T00:00:00.000Z'),
              pricing: {
                billingType: 'video_resolution_duration',
                creditsByResolution: { '768p': '10', '1080p': '99', '2k': '20' },
              },
            },
          },
        }]),
      },
      aiUsageModelBinding: {
        findMany: vi.fn(async () => [{
          key: 'IMAGE_ANALYSIS',
          fixedCredits: new Prisma.Decimal('3'),
          updatedAt: new Date('2026-09-18T01:00:00.000Z'),
        }, {
          key: 'CANVAS_TEXT',
          fixedCredits: new Prisma.Decimal('1'),
          updatedAt: new Date('2026-09-18T02:00:00.000Z'),
        }]),
      },
    } as unknown as PrismaClient;

    const projection = await buildClientPricingProjection(prisma);
    expect(projection.videoModels).toEqual([expect.objectContaining({
      model: 'minimax-h3',
      billingType: 'video_resolution_duration',
      credits: '0',
      creditsByResolution: { '768p': '10', '2k': '20' },
    })]);
    expect(projection.videoModels[0]?.creditsByResolution).not.toHaveProperty('1080p');
    expect(projection.inspirationAnalysisCredits).toBe('3.000000');
    expect(projection.canvasTextAgentCredits).toBe('1.000000');
    expect(projection.agentRequestCredits).toBe(String(getAgentRequestCredits()));
  });

  it('projects flat video pricing with an explicit billing type and a zero legacy rate', async () => {
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [{
          canonicalModelKey: 'flat-video',
          modality: 'video',
          billingType: 'video_flat',
          capabilities: {},
          pricing: {
            currentVersion: {
              publishedAt: new Date('2026-09-18T00:00:00.000Z'),
              pricing: { billingType: 'video_flat', creditsPerVideo: '15' },
            },
          },
        }]),
      },
      aiUsageModelBinding: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;

    const projection = await buildClientPricingProjection(prisma);
    expect(projection.videoModels).toEqual([{
      model: 'flat-video',
      billingType: 'video_flat',
      credits: '0',
      creditsPerVideo: '15',
    }]);
  });

  it('projects a dynamic 2k-only image price without inventing a 4k tier', async () => {
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [{
          canonicalModelKey: 'image-2k-only',
          modality: 'image',
          billingType: 'image_resolution',
          capabilities: { supportedResolutions: ['2k'] },
          pricing: {
            currentVersion: {
              publishedAt: new Date('2026-09-18T00:00:00.000Z'),
              pricing: {
                billingType: 'image_resolution',
                creditsPerImageByResolution: { '2K': '12.5' },
              },
            },
          },
        }]),
      },
      aiUsageModelBinding: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;

    const projection = await buildClientPricingProjection(prisma);
    expect(projection.imageModels).toEqual([{
      model: 'image-2k-only',
      billingType: 'image_resolution',
      creditsByResolution: { '2k': '12.5' },
      credits2k: '12.5',
    }]);
  });

  it('defines MiniMax H3 capabilities without 1080p', () => {
    expect(defaultModelCapabilities('minimax-h3', 'video')).toMatchObject({
      supportedResolutions: ['768p', '2k'],
      defaultResolution: '768p',
    });
    expect(defaultModelCapabilities('seedance-2', 'video')).toMatchObject({
      supportedResolutions: ['480p', '720p', '1080p'],
      defaultResolution: '720p',
    });
    expect(defaultModelCapabilities('seedance-2-fast', 'video')).toMatchObject({
      supportedResolutions: ['480p', '720p', '1080p'],
      defaultResolution: '720p',
    });
  });

  it('replaces legacy ratios without expanding configured GPT Image 2.5 resolutions', async () => {
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [{
          canonicalModelKey: 'custom-image-high',
          displayName: 'GPT Image22.5 high',
          modality: 'image',
          billingType: 'image_resolution',
          capabilities: {
            supportedResolutions: ['2k', '4k'],
            supportedAspectRatios: ['1:1', '16:9'],
            aspectRatiosByResolution: {
              '2k': ['16:9'],
              '4k': ['16:9'],
            },
          },
          pricing: null,
          aliases: [],
          updatedAt: new Date('2026-09-10T10:00:00.000Z'),
        }]),
      },
    } as unknown as PrismaClient;

    const catalog = await getPublicAiCatalog(prisma);

    expect(catalog.models[0]?.capabilities).toMatchObject({
      resolutions: ['2k', '4k'],
      aspectRatiosByResolution: {
        '2k': expect.arrayContaining(['2048x1152', '2064x1376']),
        '4k': expect.arrayContaining(['3840x2160', '3520x2352']),
      },
    });
  });

  it('uses an active membership price override without changing the base catalog version', async () => {
    const prisma = {
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: { id: 'price-10', version: 10, pricing: {
            billingType: 'image_resolution',
            creditsPerImageByResolution: { '1k': '10', '2k': '16', '4k': '20' },
          } },
        })),
      },
      userMembership: {
        findFirst: vi.fn(async () => ({
          planId: 'plan-pro',
          plan: { versions: [{ id: 'plan-price-2', prices: { models: { 'nano-banana-pro': { image1K: '1', image2K: '2', image4K: '3' } } } }] },
        })),
      },
    } as unknown as PrismaClient;
    const captured = await capturePricingSnapshot(prisma, {
      id: 'model-1', canonicalModelKey: 'nano-banana-pro', modality: 'image', billingType: 'image_resolution',
    }, null, { resolution: '2k', count: 1 }, 'user-1');
    expect(captured.membershipPlanId).toBe('plan-pro');
    expect(calculateSnapshotCharge(captured).totalCredits).toBe('2.000000');
  });

  it('supports plan-level visual prices for video and fixed agent contexts', async () => {
    const membership = {
      userMembership: {
        findFirst: vi.fn(async () => ({
          plan: { versions: [{ prices: { videoPerSecond: '3.5', canvasTextAgent: '0.5' } }] },
        })),
      },
    } as unknown as PrismaClient;
    await expect(resolveMembershipContextCredits(membership, 'user-1', 'canvas_text_agent', 1n)).resolves.toBe('0.500000');

    const videoPrisma = {
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: { id: 'price-video', version: 1, pricing: {
            billingType: 'video_second', creditsPerSecond: '10', credits: '10',
          } },
        })),
      },
      userMembership: {
        findFirst: vi.fn(async () => ({
          planId: 'plan-pro',
          plan: { versions: [{ id: 'plan-price-1', prices: { videoPerSecond: '3.5' } }] },
        })),
      },
    } as unknown as PrismaClient;
    const captured = await capturePricingSnapshot(videoPrisma, {
      id: 'model-video', canonicalModelKey: 'seedance2', modality: 'video', billingType: 'video_second',
    }, null, { duration: 2, resolution: '720p', count: 1 }, 'user-1');
    expect(calculateSnapshotCharge(captured).totalCredits).toBe('7.000000');
  });

  it('returns fixed canvas prices in wallet credit units instead of internal micros', async () => {
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;

    await expect(
      resolveMembershipContextCredits(prisma, 'user-1', 'canvas_text_agent', 1n),
    ).resolves.toBe('1.000000');
  });

  it('applies the other-module fold to fixed canvas/workflow pricing', async () => {
    const prisma = {
      userMembership: {
        findFirst: vi.fn(async () => ({
          plan: { versions: [{ prices: { discounts: { other: '0' } } }] },
        })),
      },
    } as unknown as PrismaClient;
    await expect(resolveMembershipContextCredits(prisma, 'user-1', 'canvas_text_agent', 1n)).resolves.toBe('0.000000');
  });

  it('applies membership folds by billing module, including free GPT Image 1K', async () => {
    const prisma = {
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: { id: 'price-fold', version: 1, pricing: {
            billingType: 'image_resolution',
            creditsPerImageByResolution: { '1k': '10', '2k': '20', '4k': '40' },
          } },
        })),
      },
      userMembership: {
        findFirst: vi.fn(async () => ({
          planId: 'plan-fold',
          plan: { versions: [{ id: 'version-fold', prices: { discounts: { gptImage1K: '0', other: '5' } } }] },
        })),
      },
    } as unknown as PrismaClient;
    const freeOneK = await capturePricingSnapshot(prisma, {
      id: 'image-2', canonicalModelKey: 'image2', modality: 'image', billingType: 'image_resolution',
    }, null, { resolution: '1k', count: 1 }, 'user-fold');
    expect(calculateSnapshotCharge(freeOneK).totalCredits).toBe('0.000000');
    const halfPriceTwoK = await capturePricingSnapshot(prisma, {
      id: 'image-2', canonicalModelKey: 'image2', modality: 'image', billingType: 'image_resolution',
    }, null, { resolution: '2k', count: 1 }, 'user-fold');
    expect(calculateSnapshotCharge(halfPriceTwoK).totalCredits).toBe('10.000000');
  });

  it('never exposes route cost or provider credentials in the public catalog', async () => {
    const prisma = {
      aiModel: {
        findMany: vi.fn(async () => [{
          canonicalModelKey: 'nano-banana-pro',
          displayName: 'Nano Banana Pro',
          modality: 'image',
          billingType: 'image_resolution',
          capabilities: { supportedResolutions: ['2k', '4k'] },
          pricing: { currentVersion: { version: 3, pricing: { billingType: 'image_resolution' } } },
          aliases: [{ alias: 'vendor-image-pro' }],
          routes: [{ costProfile: { secretCost: 1 }, channel: { encryptedSecrets: 'secret' } }],
        }]),
      },
    } as unknown as PrismaClient;
    const catalog = await getPublicAiCatalog(prisma);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('secretCost');
    expect(serialized).not.toContain('encryptedSecrets');
    expect(catalog.models[0]).toMatchObject({
      id: 'nano-banana-pro',
      priceVersion: 3,
      aliases: ['vendor-image-pro'],
      capabilities: { resolutions: ['2k', '4k'] },
    });
  });

  it('keeps the legacy Chat and Image/Video model response shapes available', async () => {
    const baseProvider = {
      id: 'provider-legacy',
      name: 'provider-legacy',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.8.8',
      defaultModel: 'gpt-5.6-sol',
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'text-embedding-model' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const chatPrisma = {
      aiProviderChannel: { findMany: vi.fn(async () => [baseProvider]) },
    } as unknown as PrismaClient;
    const chatResponse = await listWalletAgentModels(chatPrisma);
    expect(chatResponse).toEqual(expect.objectContaining({
      models: expect.any(Array),
      defaultModel: expect.any(String),
    }));

    const mediaProvider = {
      ...baseProvider,
      kind: 'BIGMODEL',
      capabilities: ['IMAGE_NANO_BANANA', 'VIDEO'],
      defaultModel: 'gemini-3-pro-image-preview',
    } as AiProviderChannel;
    const mediaPrisma = {
      aiProviderChannel: { findMany: vi.fn(async () => [mediaProvider]) },
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const mediaResponse = await listWalletImageModels(mediaPrisma);
    expect(mediaResponse).toEqual(expect.objectContaining({
      models: expect.any(Array),
      channels: expect.any(Array),
      videoChannels: expect.any(Array),
      pricing: expect.any(Object),
    }));
  });

  it('puts a newly discovered unknown upstream model in UNMAPPED without creating a route', async () => {
    const provider = {
      id: 'provider-1',
      name: 'provider-1',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.8.8',
      defaultModel: null,
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'brand-new-chat-model' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const discoveryUpsert = vi.fn(async (input: unknown) => input);
    const routeCreate = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: { findFirst: vi.fn(async () => null), create: routeCreate },
      aiModel: { findUnique: vi.fn(async () => null) },
      aiModelAlias: { findUnique: vi.fn(async () => null) },
      aiUpstreamDiscovery: { findUnique: vi.fn(async () => null), upsert: discoveryUpsert },
    } as unknown as PrismaClient;
    const result = await syncUpstreamModels(prisma, provider.id);
    expect(result).toMatchObject({
      discovered: 1,
      mapped: 0,
      unmapped: 1,
    });
    expect(result.changes).toContainEqual(expect.objectContaining({
      kind: 'NEW_MODEL',
      providerId: provider.id,
      upstreamModelId: 'brand-new-chat-model',
      canonicalModelId: null,
    }));
    expect(routeCreate).not.toHaveBeenCalled();
    expect(discoveryUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        upstreamModelId: 'brand-new-chat-model',
        status: 'UNMAPPED',
      }),
    }));
  });

  it('classifies newly discovered media models without requiring a legacy channel enum', async () => {
    const provider = {
      id: 'provider-dynamic-image',
      name: 'provider-dynamic-image',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.8.8',
      defaultModel: null,
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'future-image-v9' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const discoveryUpsert = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: { findFirst: vi.fn(async () => null), create: vi.fn() },
      aiModel: { findUnique: vi.fn(async () => null) },
      aiModelAlias: { findUnique: vi.fn(async () => null) },
      aiUpstreamDiscovery: { findUnique: vi.fn(async () => null), upsert: discoveryUpsert },
    } as unknown as PrismaClient;

    await expect(syncUpstreamModels(prisma, provider.id)).resolves.toMatchObject({ unmapped: 1 });
    expect(discoveryUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        upstreamModelId: 'future-image-v9',
        suggestedModality: 'image',
      }),
    }));
  });

  it('does not overwrite a manually configured route capability during sync', async () => {
    const provider = {
      id: 'provider-manual-capabilities',
      name: 'provider-manual-capabilities',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.8.8',
      defaultModel: null,
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'future-image-v9',
        capabilities: { supportedResolutions: ['2k'] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const routeUpdate = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: {
        findFirst: vi.fn(async () => ({
          id: 'route-manual-capabilities',
          canonicalModelId: 'model-future-image',
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          costProfile: null,
          metadata: {
            capabilitiesOverrideSource: 'MANUAL',
            operatorNote: '8K beta enabled',
          },
        })),
        update: routeUpdate,
      },
      aiRouteCostHistory: { create: vi.fn() },
    } as unknown as PrismaClient;

    await expect(syncUpstreamModels(prisma, provider.id)).resolves.toMatchObject({ mapped: 1 });
    const routeRefresh = routeUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(routeRefresh.data).not.toHaveProperty('capabilitiesOverride');
    expect(routeRefresh.data.metadata).toMatchObject({
      capabilitiesOverrideSource: 'MANUAL',
      operatorNote: '8K beta enabled',
    });
  });

  it('reuses an explicit mapping but keeps a newly discovered route disabled', async () => {
    const provider = {
      id: 'provider-image',
      name: 'provider-image',
      kind: 'BIGMODEL',
      status: 'ACTIVE',
      priority: 7,
      baseUrl: 'https://8.8.4.4',
      defaultModel: null,
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['IMAGE_NANO_BANANA'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'models/gemini-3.1-pro-image-preview' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const routeCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'route-new', ...data }));
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: { findFirst: vi.fn(async () => null), create: routeCreate },
      aiModel: {
        findUnique: vi.fn(async ({ where }: { where: { canonicalModelKey: string } }) => (
          where.canonicalModelKey === 'nano-banana-pro'
            ? { id: 'nano-pro-id', canonicalModelKey: 'nano-banana-pro' }
            : null
        )),
      },
      aiModelAlias: { findUnique: vi.fn(async () => null) },
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async (input: unknown) => input),
      },
    } as unknown as PrismaClient;
    await expect(syncUpstreamModels(prisma, provider.id)).resolves.toMatchObject({ mapped: 1, unmapped: 0 });
    expect(routeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        canonicalModelId: 'nano-pro-id',
        upstreamModelId: 'gemini-3.1-pro-image-preview',
        enabled: false,
      }),
    }));
  });

  it('retains the previous route cost and marks a warning when upstream pricing is absent', async () => {
    const provider = {
      id: 'provider-cost',
      name: 'provider-cost',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://8.8.4.4',
      defaultModel: 'known-chat-model',
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'known-chat-model' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const update = vi.fn(async (input: unknown) => input);
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => provider) },
      aiModelRoute: {
        findFirst: vi.fn(async () => ({
          id: 'route-cost',
          canonicalModelId: 'model-cost',
          costProfile: { credits: 'old-cost-must-remain' },
        })),
        update,
      },
      aiRouteCostHistory: { create: vi.fn() },
      aiUpstreamDiscovery: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    await expect(syncUpstreamModels(prisma, provider.id)).resolves.toMatchObject({ mapped: 1 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { pricingSyncStatus: 'WARNING_STALE_COST' },
    }));
    expect(update.mock.calls.some(([call]) => (
      Object.prototype.hasOwnProperty.call((call as { data: object }).data, 'costProfile')
    ))).toBe(false);
  });
});

describe('billing idempotency', () => {
  it.each(['canvas_text_agent', 'prompt_optimization', 'workflow'])(
    'reserves and consumes exactly one CANVAS_TEXT credit for %s despite large token usage',
    async usageContext => {
      const provider = {
        id: 'canvas-provider',
        name: 'canvas-provider',
        kind: 'NEW_API',
        status: 'ACTIVE',
        priority: 10,
        baseUrl: 'https://1.1.1.1',
        defaultModel: 'gpt-5.6-sol',
        allowInsecureHttp: false,
        encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
        apiKeyLast4: 'test',
        capabilities: ['LLM'],
        paramOverrides: null,
        lastTestStatus: null,
        lastTestMessage: null,
        lastTestModelCount: null,
        lastTestedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as AiProviderChannel;
      const route = {
        id: 'canvas-route',
        canonicalModelId: 'canvas-model',
        channelId: provider.id,
        provider: 'NEW_API',
        upstreamModelId: 'gpt-5.6-sol',
        enabled: true,
        upstreamAvailable: true,
        priority: 0,
        healthStatus: 'HEALTHY',
        capabilitiesOverride: null,
        channel: provider,
      };
      const model = {
        id: 'canvas-model',
        canonicalModelKey: 'canvas-text-model',
        displayName: 'Canvas Text Model',
        modality: 'chat',
        billingType: 'token',
        capabilities: {},
        enabled: true,
        visible: true,
        status: 'PUBLISHED',
        routingMode: 'MANAGED',
        defaultRouteId: route.id,
        routes: [route],
      };
      const binding = {
        key: 'CANVAS_TEXT',
        canonicalModelId: model.id,
        fixedCredits: new Prisma.Decimal('1'),
        updatedAt: new Date(),
        canonicalModel: model,
      };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        model: 'gpt-5.6-sol',
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 500_000, completion_tokens: 500_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));

      let requestRow: Record<string, unknown> | null = null;
      const reserveWallet = vi.fn(async () => ({ count: 1 }));
      const settleWallet = vi.fn(async () => ({ availableCredits: creditDecimal(99) }));
      const ledgerCreate = vi.fn(async () => ({}));
      const transaction = {
        aiModel: {
          count: vi.fn(async () => 1),
          findUnique: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
        },
        aiUsageModelBinding: {
          findUnique: vi.fn(async () => binding),
          update: vi.fn(),
          create: vi.fn(),
        },
        aiRequest: {
          findUnique: vi.fn(async () => null),
          findFirst: vi.fn(async () => requestRow),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            requestRow = { id: 'canvas-request', ...data, chargedCredits: creditDecimal(0) };
            return requestRow;
          }),
          updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (requestRow) Object.assign(requestRow, data);
            return { count: requestRow ? 1 : 0 };
          }),
        },
        wallet: {
          updateMany: reserveWallet,
          findUniqueOrThrow: vi.fn(async () => ({ availableCredits: creditDecimal(99) })),
          update: settleWallet,
        },
        walletLedger: { create: ledgerCreate },
        aiBillingSettlement: { create: vi.fn(async () => ({})) },
      };
      const userMembership = { findFirst: vi.fn(async () => null) };
      const prisma = {
        aiModel: transaction.aiModel,
        aiUsageModelBinding: transaction.aiUsageModelBinding,
        aiModelPricing: {
          findUnique: vi.fn(async () => ({
            currentVersion: { id: 'canvas-price-1', version: 1, pricing: astraPricing },
          })),
        },
        userMembership,
        $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
      } as unknown as PrismaClient;

      await expect(executeWalletAgentChat(prisma, {
        userId: 'user-1',
        clientRequestId: `${usageContext}-request`,
        model: 'unmind-agent',
        usageContext,
        messages: [{ role: 'user', content: 'hello' }],
      })).resolves.toMatchObject({ choices: expect.any(Array) });

      const reservation = reserveWallet.mock.calls[0]?.[0] as {
        data: { availableCredits: { decrement: Prisma.Decimal }; reservedCredits: { increment: Prisma.Decimal } };
      };
      expect(reservation.data.availableCredits.decrement.toFixed(6)).toBe('1.000000');
      expect(reservation.data.reservedCredits.increment.toFixed(6)).toBe('1.000000');
      const settlement = settleWallet.mock.calls[0]?.[0] as {
        data: { reservedCredits: { decrement: Prisma.Decimal }; lifetimeConsumed: { increment: Prisma.Decimal } };
      };
      expect(settlement.data.reservedCredits.decrement.toFixed(6)).toBe('1.000000');
      expect(settlement.data.lifetimeConsumed.increment.toFixed(6)).toBe('1.000000');
      const charge = ledgerCreate.mock.calls
        .map(([call]) => call as { data: { type: string; amount: Prisma.Decimal } })
        .find(call => call.data.type === 'CHARGE');
      expect(charge?.data.amount.toFixed(6)).toBe('1.000000');
      expect(requestRow).toMatchObject({
        status: 'SUCCEEDED',
        chargedCredits: expect.objectContaining({}),
      });
    },
  );

  it('rejects a repeated clientRequestId before a second reservation or charge', async () => {
    const provider = {
      id: 'chat-provider',
      name: 'chat-provider',
      kind: 'NEW_API',
      status: 'ACTIVE',
      priority: 10,
      baseUrl: 'https://1.1.1.1',
      defaultModel: 'gpt-5.6-sol',
      allowInsecureHttp: false,
      encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
      apiKeyLast4: 'test',
      capabilities: ['LLM'],
      paramOverrides: null,
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiProviderChannel;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'gpt-5.6-sol',
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    let requestRow: Record<string, unknown> | null = null;
    const reserveWallet = vi.fn(async () => ({ count: 1 }));
    const chargeLedger = vi.fn(async () => ({}));
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => requestRow),
        findFirst: vi.fn(async () => requestRow),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          requestRow = {
            id: 'request-1',
            ...data,
            estimatedCredits: creditDecimal(data.estimatedCredits as string),
            chargedCredits: creditDecimal(0),
          };
          return requestRow;
        }),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (!requestRow || !['RESERVED', 'PROCESSING'].includes(String(requestRow.status))) return { count: 0 };
          Object.assign(requestRow, data);
          return { count: 1 };
        }),
      },
      wallet: {
        updateMany: reserveWallet,
        findUniqueOrThrow: vi.fn(async () => ({ availableCredits: creditDecimal(100) })),
        update: vi.fn(async () => ({ availableCredits: creditDecimal(90) })),
      },
      walletLedger: { create: chargeLedger },
    };
    const prisma = {
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
      aiProviderChannel: { findMany: vi.fn(async () => [provider]) },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const input = {
      userId: 'user-1',
      clientRequestId: 'same-client-request',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    };
    await expect(executeWalletAgentChat(prisma, input)).resolves.toMatchObject({
      choices: expect.any(Array),
    });
    await expect(executeWalletAgentChat(prisma, input)).rejects.toMatchObject({
      code: 'duplicate_request',
      statusCode: 409,
    });
    expect(reserveWallet).toHaveBeenCalledOnce();
    expect(chargeLedger.mock.calls.filter(([call]) => (
      (call as { data: { type: string } }).data.type === 'CHARGE'
    ))).toHaveLength(1);
  });
});

describe('catalog bootstrap isolation', () => {
  it('does not read legacy pricing or publish a price when the catalog already exists', async () => {
    const legacyAiRead = vi.fn(async () => { throw new Error('legacy AI pricing must not be read'); });
    const legacyChatRead = vi.fn(async () => { throw new Error('legacy Chat pricing must not be read'); });
    const createVersion = vi.fn();
    const transaction = {
      aiModel: {
        count: vi.fn(async () => 1),
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
      },
      aiModelAlias: { upsert: vi.fn() },
      aiPriceVersion: { create: createVersion },
      aiUsageModelBinding: { findUnique: vi.fn(async () => null) },
      aiPricingConfig: { findUnique: legacyAiRead },
      chatPricingConfig: { findUnique: legacyChatRead },
    };
    const prisma = {
      ...transaction,
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;

    await expect(ensureAiCatalogSeeded(prisma)).resolves.toBe(true);
    expect(legacyAiRead).not.toHaveBeenCalled();
    expect(legacyChatRead).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });
});

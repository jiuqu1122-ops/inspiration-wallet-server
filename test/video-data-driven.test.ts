import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';
import { normalizeModelCapabilities, normalizePublicModelCapabilities } from '../src/modules/ai/model-catalog.js';
import { calculateSnapshotCharge, type PricingSnapshot } from '../src/modules/ai/pricing-center.js';
import { genericAsyncVideoAdapter } from '../src/modules/ai/video-adapters/generic-async-video.js';
import { getVideoAdapter } from '../src/modules/ai/video-adapters/registry.js';
import { selectManagedVideoRoutes, type VideoRouteCandidate } from '../src/modules/ai/video-routing.js';
import { normalizeManagedVideoRequest } from '../src/modules/ai/video-request.js';
import { settleVideoRequestIfTerminal, videoOutputIdempotencyKey } from '../src/modules/ai/video-task-service.js';

const provider = {
  id: 'channel-1',
  name: 'AI Media',
  status: 'ACTIVE',
  baseUrl: 'https://8.8.8.8',
  encryptedSecrets: encryptProviderSecrets({ apiKey: 'test-key', headers: {} }),
};

const route = (overrides: Partial<VideoRouteCandidate> = {}): VideoRouteCandidate => ({
  id: 'route-1',
  canonicalModelId: 'model-1',
  channelId: provider.id,
  upstreamModelId: 'exact-upstream-sku',
  adapterKey: 'GENERIC_ASYNC_VIDEO',
  adapterConfig: { referenceSerialization: 'array' },
  capabilitiesOverride: null,
  enabled: true,
  upstreamAvailable: true,
  healthStatus: 'HEALTHY',
  priority: 100,
  channel: provider,
  ...overrides,
});

const baseRequest = {
  model: 'canonical-video',
  prompt: 'orbit around the product',
  inputImages: [] as string[],
  inputVideos: [] as string[],
  inputAudios: [] as string[],
  count: 1,
};

describe('data-driven managed video capabilities', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates and publicly projects the additive capability schema', () => {
    const normalized = normalizeModelCapabilities({
      supportedResolutions: ['768P', '2K'],
      defaultResolution: '768p',
      durationMode: 'range',
      durationRange: { min: 5, max: 15, step: 1 },
      defaultDurationSeconds: 5,
      aspectRatioMode: 'any',
      defaultAspectRatio: '16:9',
      minReferenceImages: 1,
      maxReferenceImages: 9,
      minReferenceVideos: 0,
      maxReferenceVideos: 0,
      minReferenceAudios: 0,
      maxReferenceAudios: 3,
      supportsReferenceImage: true,
      supportsReferenceVideo: false,
      supportsReferenceAudio: true,
    });
    expect(normalizePublicModelCapabilities(normalized)).toMatchObject({
      resolutions: ['768p', '2k'],
      defaultResolution: '768p',
      durationMode: 'range',
      durationRange: { min: 5, max: 15, step: 1 },
      defaultDurationSeconds: 5,
      aspectRatioMode: 'any',
      minReferenceImages: 1,
      minReferenceVideos: 0,
      minReferenceAudios: 0,
    });
  });

  it.each([
    [{ durationMode: 'range', durationRange: { min: 4, max: 15, step: 1 }, defaultDurationSeconds: 4 }, undefined, 4],
    [{ durationMode: 'list', supportedDurations: [10, 15], defaultDurationSeconds: 10 }, undefined, 10],
    [{ durationMode: 'fixed', supportedDurations: [30], defaultDurationSeconds: 30 }, undefined, 30],
    [{ durationMode: 'range', durationRange: { min: 5, max: 15, step: 1 }, defaultDurationSeconds: 5 }, undefined, 5],
  ])('normalizes duration modes without a global fallback', (capabilities, requested, expected) => {
    expect(normalizeManagedVideoRequest(
      { ...baseRequest, duration: requested },
      'canonical-video',
      capabilities,
    ).duration).toBe(expected);
  });

  it('rejects an explicit invalid fixed duration instead of clamping it', () => {
    expect(() => normalizeManagedVideoRequest(
      { ...baseRequest, duration: 10 },
      'seedance-2-5',
      { durationMode: 'fixed', supportedDurations: [30], defaultDurationSeconds: 30 },
    )).toThrow(/duration/);
  });

  it('uses exact resolution labels and rejects unsupported aliases', () => {
    const capabilities = { supportedResolutions: ['768p', '2k'], defaultResolution: '768p' };
    expect(normalizeManagedVideoRequest(baseRequest, 'h3', capabilities).resolution).toBe('768p');
    expect(() => normalizeManagedVideoRequest(
      { ...baseRequest, resolution: '1080p' }, 'h3', capabilities,
    )).toThrow(/resolution/);
  });

  it('supports list, any, and unspecified aspect-ratio semantics', () => {
    expect(normalizeManagedVideoRequest(
      { ...baseRequest, aspectRatio: '9:16' }, 'list',
      { aspectRatioMode: 'list', supportedAspectRatios: ['16:9', '9:16'] },
    ).aspectRatio).toBe('9:16');
    expect(normalizeManagedVideoRequest(
      { ...baseRequest, aspectRatio: '5:4' }, 'any', { aspectRatioMode: 'any' },
    ).aspectRatio).toBe('5:4');
    expect(normalizeManagedVideoRequest(
      { ...baseRequest, aspectRatio: '16:9' }, 'unspecified', { aspectRatioMode: 'unspecified' },
    ).aspectRatio).toBeUndefined();
  });

  it('enforces reference min/max independently from first/last frame flags', () => {
    const capabilities = {
      minReferenceImages: 1,
      maxReferenceImages: 9,
      minReferenceVideos: 0,
      maxReferenceVideos: 0,
      minReferenceAudios: 0,
      maxReferenceAudios: 3,
      supportsReferenceImage: true,
      supportsReferenceVideo: false,
      supportsReferenceAudio: true,
      supportsFirstFrame: false,
      supportsLastFrame: false,
      supportsFirstLastFrame: false,
    };
    expect(() => normalizeManagedVideoRequest(baseRequest, 'h3', capabilities)).toThrow(/inputs/);
    expect(normalizeManagedVideoRequest({
      ...baseRequest, inputImages: ['https://example.com/ref.png'],
    }, 'h3', capabilities).inputImages).toHaveLength(1);
    expect(() => normalizeManagedVideoRequest({
      ...baseRequest,
      inputImages: ['https://example.com/ref.png'],
      inputVideos: ['https://example.com/ref.mp4'],
    }, 'h3', capabilities)).toThrow(/inputs/);
  });

  it('filters routes by route capability and adapter serializer readiness', () => {
    const request = normalizeManagedVideoRequest(
      { ...baseRequest, duration: 12, inputImages: ['https://example.com/ref.png'] },
      'canonical-video',
      {
        durationMode: 'range', durationRange: { min: 4, max: 15 },
        minReferenceImages: 0, maxReferenceImages: 9, supportsReferenceImage: true,
      },
    );
    const routes = [
      route({
        id: 'only-10',
        capabilitiesOverride: {
          durationMode: 'fixed', supportedDurations: [10],
          minReferenceImages: 0, maxReferenceImages: 9, supportsReferenceImage: true,
        },
        adapterConfig: { referenceImagesParameter: 'refs', referenceSerialization: 'array' },
      }),
      route({
        id: 'range-no-serializer',
        capabilitiesOverride: {
          durationMode: 'range', durationRange: { min: 4, max: 15 },
          minReferenceImages: 0, maxReferenceImages: 9, supportsReferenceImage: true,
        },
        adapterConfig: {},
      }),
      route({
        id: 'range-ready',
        capabilitiesOverride: {
          durationMode: 'range', durationRange: { min: 4, max: 15 },
          minReferenceImages: 0, maxReferenceImages: 9, supportsReferenceImage: true,
        },
        adapterConfig: { referenceImagesParameter: 'reference_assets', referenceSerialization: 'array' },
      }),
    ];
    expect(selectManagedVideoRoutes(routes, 'model-1', {}, request).map(item => item.id)).toEqual(['range-ready']);
  });

  it('never falls back across canonical models and lets adapterKey choose the protocol', () => {
    const request = normalizeManagedVideoRequest(
      { ...baseRequest, duration: 10 },
      'canonical-video',
      { durationMode: 'fixed', supportedDurations: [10] },
    );
    const candidates = [
      route({ id: 'same-model', adapterKey: 'GENERIC_ASYNC_VIDEO' }),
      route({ id: 'other-model', canonicalModelId: 'model-2', priority: 1 }),
    ];
    expect(selectManagedVideoRoutes(candidates, 'model-1', {}, request).map(item => item.id))
      .toEqual(['same-model']);
    expect(getVideoAdapter('GENERIC_ASYNC_VIDEO')?.key).toBe('GENERIC_ASYNC_VIDEO');
    expect(getVideoAdapter('LEGACY_VIDEO')?.key).toBe('LEGACY_VIDEO');
  });

  it('rejects a route that cannot serialize its requested reference media type', () => {
    const request = normalizeManagedVideoRequest(
      { ...baseRequest, inputVideos: ['https://example.com/ref.mp4'] },
      'canonical-video',
      { maxReferenceVideos: 3, supportsReferenceVideo: true },
    );
    expect(selectManagedVideoRoutes([
      route({
        adapterConfig: {},
        capabilitiesOverride: { maxReferenceVideos: 3, supportsReferenceVideo: true },
      }),
    ], 'model-1', {}, request)).toEqual([]);
  });

  it('submits /v1/videos with exact upstreamModelId and a stable per-output idempotency key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('exact-upstream-sku');
      expect(body.model).not.toBe('canonical-video');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(videoOutputIdempotencyKey('client-request-123', 2));
      return new Response(JSON.stringify({ id: 'upstream-task-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = normalizeManagedVideoRequest(
      { ...baseRequest, duration: 5 }, 'canonical-video',
      { durationMode: 'fixed', supportedDurations: [5] },
    );
    const selectedRoute = route({ adapterConfig: { durationParameter: 'seconds' } });
    const key = videoOutputIdempotencyKey('client-request-123', 2);
    expect(key).toBe(videoOutputIdempotencyKey('client-request-123', 2));
    await expect(genericAsyncVideoAdapter.submit(
      { route: selectedRoute, provider }, request, 2, key,
    )).resolves.toMatchObject({ upstreamTaskId: 'upstream-task-1' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://8.8.8.8/v1/videos');
  });

  it('keeps queued/completed-not-available/saving tasks pending and expires terminally', async () => {
    const payloads = [
      { status: 'queued', poll_after_ms: 4_000 },
      { status: 'completed', video_available: false },
      { status: 'completed', video_available: true, asset_state: 'saving' },
      { status: 'completed', video_available: true, asset_state: 'expired' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payloads.shift()), { status: 200 })));
    const context = { route: route(), provider };
    await expect(genericAsyncVideoAdapter.poll(context, 'task')).resolves.toMatchObject({ state: 'processing', pollAfterMs: 4_000 });
    await expect(genericAsyncVideoAdapter.poll(context, 'task')).resolves.toMatchObject({ state: 'processing', videoAvailable: false });
    await expect(genericAsyncVideoAdapter.poll(context, 'task')).resolves.toMatchObject({ state: 'processing', assetState: 'saving' });
    await expect(genericAsyncVideoAdapter.poll(context, 'task')).resolves.toMatchObject({ state: 'failed', assetState: 'expired' });
  });

  it('charges video_flat per generated output and duration pricing per second', () => {
    const snapshot = (pricing: PricingSnapshot['pricing'], request: Record<string, unknown>): PricingSnapshot => ({
      schemaVersion: 1,
      canonicalModelId: 'model-1',
      canonicalModelKey: 'video-model',
      modality: 'video',
      routeId: 'route-1',
      priceVersionId: 'price-1',
      priceVersion: 1,
      billingType: String(pricing.billingType),
      pricing,
      request,
      capturedAt: new Date(0).toISOString(),
    });
    expect(calculateSnapshotCharge(snapshot(
      { billingType: 'video_flat', creditsPerVideo: '3' },
      { duration: 30, count: 4 },
    ), { generatedCount: 3 }).totalCredits).toBe('9.000000');
    expect(calculateSnapshotCharge(snapshot(
      { billingType: 'video_resolution_duration', creditsByResolution: { '768p': '2' } },
      { duration: 10, resolution: '768p', count: 1 },
    )).totalCredits).toBe('20.000000');
  });

  it('does not settle while any output task is still queued or processing', async () => {
    const updateMany = vi.fn();
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => ({
          id: 'request-1',
          status: 'PROCESSING',
          videoTasks: [{ status: 'PROCESSING', resultUrl: null }],
        })),
        updateMany,
      },
    };
    const prisma = {
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;
    await expect(settleVideoRequestIfTerminal(prisma, 'request-1')).resolves.toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('releases the complete reservation when every output task fails', async () => {
    const ledgerCreate = vi.fn(async () => ({}));
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => ({
          id: 'request-failed', userId: 'user-1', status: 'PROCESSING',
          estimatedCredits: creditDecimal('6'),
          videoTasks: [{ id: 'task-1', status: 'FAILED', resultUrl: null, lastError: 'upstream failed' }],
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      wallet: { update: vi.fn(async () => ({ availableCredits: creditDecimal('20') })) },
      walletLedger: { create: ledgerCreate },
    };
    const prisma = {
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;
    await expect(settleVideoRequestIfTerminal(prisma, 'request-failed')).resolves.toEqual({
      status: 'failed', generatedCount: 0,
    });
    expect(transaction.wallet.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { availableCredits: { increment: creditDecimal('6') }, reservedCredits: { decrement: creditDecimal('6') } },
    }));
    expect(ledgerCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'RELEASE' }) }));
  });

  it('settles partial success by generated output count and releases the remainder', async () => {
    const pricingSnapshot: PricingSnapshot = {
      schemaVersion: 1,
      canonicalModelId: 'model-1',
      canonicalModelKey: 'video-model',
      modality: 'video',
      routeId: 'route-1',
      priceVersionId: 'price-1',
      priceVersion: 1,
      billingType: 'video_flat',
      pricing: { billingType: 'video_flat', creditsPerVideo: '3' },
      request: { duration: 30, count: 2 },
      capturedAt: new Date(0).toISOString(),
    };
    const ledgerCreate = vi.fn(async () => ({}));
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => ({
          id: 'request-partial', userId: 'user-1', status: 'PROCESSING',
          estimatedCredits: creditDecimal('6'), pricingSnapshot,
          videoTasks: [
            { id: 'task-1', outputIndex: 0, status: 'SUCCEEDED', resultUrl: 'https://cdn.example/1.mp4', lastError: null },
            { id: 'task-2', outputIndex: 1, status: 'FAILED', resultUrl: null, lastError: 'upstream failed' },
          ],
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      aiBillingSettlement: { create: vi.fn(async () => ({})) },
      wallet: { update: vi.fn(async () => ({ availableCredits: creditDecimal('17') })) },
      walletLedger: { create: ledgerCreate },
    };
    const prisma = {
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;
    await expect(settleVideoRequestIfTerminal(prisma, 'request-partial')).resolves.toMatchObject({
      status: 'succeeded', generatedCount: 1,
    });
    expect(transaction.aiRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ chargedCredits: creditDecimal('3') }),
    }));
    expect(transaction.wallet.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        reservedCredits: { decrement: creditDecimal('6') },
        availableCredits: { increment: creditDecimal('3') },
        lifetimeConsumed: { increment: creditDecimal('3') },
      },
    }));
    expect(ledgerCreate.mock.calls.map(call => call[0].data.type)).toEqual(['CHARGE', 'RELEASE']);
  });
});

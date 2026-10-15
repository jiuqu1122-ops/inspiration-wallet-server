import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({
  ensureAiCatalogSeeded: vi.fn(async () => true),
}));
vi.mock('../src/modules/ai/image-result-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => 'https://persisted.example/result.png'),
}));

import { executeWalletImageGeneration } from '../src/modules/ai/image-service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
const reference = 'https://assets.example/reference.png';
const channel: AiProviderChannel = {
  id: 'image-channel', name: 'Image fixture', kind: 'NEW_API', status: 'ACTIVE', priority: 0,
  baseUrl: 'https://1.1.1.1', defaultModel: null, allowInsecureHttp: false,
  encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture', headers: {} }), apiKeyLast4: 'ture',
  capabilities: ['IMAGE'], lastTestStatus: null, lastTestMessage: null,
  lastTestModelCount: null, lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
};

function fixture(canonicalEdit: boolean, override: unknown, source: string | undefined, submitEndpoint = '/v1/images/generations') {
  const canonicalCapabilities = {
    supportedResolutions: ['2k'], supportedAspectRatios: ['16:9'], supportsReferenceImages: true,
    supportsImageEdit: canonicalEdit, supportedQualities: ['high'], qualityParameter: 'render_quality',
    outputMode: 'single_asset', maxOutputImages: 1, billingMode: 'per_request',
  };
  const route = {
    id: 'image-route', canonicalModelId: 'image-model', provider: 'NEW_API', channelId: channel.id,
    upstreamModelId: 'gpt-image-2.5', adapterKey: 'GENERIC_OPENAI_IMAGE',
    adapterConfig: { referenceSerializer: 'json_images' }, executionMode: 'TASK',
    executionConfig: { profile: 'GENERIC_TASK', submitEndpoint,
      statusEndpointTemplate: '/tasks/{taskId}' },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0,
    capabilitiesOverride: override, metadata: source ? { capabilitiesOverrideSource: source } : null,
    channel,
  };
  const model = {
    id: 'image-model', canonicalModelKey: 'gpt-image-2.5', displayName: 'Image 2.5', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', routingMode: 'MANAGED',
    billingType: 'image_resolution', capabilities: canonicalCapabilities, defaultRouteId: route.id,
    routes: [route],
  };
  let request: Record<string, unknown> | null = null;
  const transaction = {
    aiRequest: {
      findUnique: vi.fn(async () => request),
      findFirst: vi.fn(async () => request),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        request = { id: 'request', ...data, estimatedCredits: creditDecimal(data.estimatedCredits as string),
          chargedCredits: creditDecimal(0) };
        return request;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (request) Object.assign(request, data);
        return request;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!request || !['RESERVED', 'PROCESSING'].includes(String(request.status))) return { count: 0 };
        Object.assign(request, data);
        return { count: 1 };
      }),
    },
    wallet: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ availableCredits: creditDecimal(1_000) })),
      update: vi.fn(async () => ({ availableCredits: creditDecimal(1_000) })),
    },
    walletLedger: { create: vi.fn(async () => ({})) },
    aiBillingSettlement: { create: vi.fn(async () => ({})) },
  };
  const legacyProviders = vi.fn(async () => []);
  const prisma = {
    aiRequest: transaction.aiRequest,
    userMembership: { findFirst: vi.fn(async () => null) },
    aiModel: { findUnique: vi.fn(async () => model) },
    aiModelPricing: { findUnique: vi.fn(async () => ({ currentVersion: {
      id: 'image-price', version: 1, publishedAt: new Date(0), pricing: {
        billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '10' },
      },
    } })) },
    aiProviderChannel: { findMany: legacyProviders },
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
  } as unknown as PrismaClient;
  return { prisma, model, transaction, legacyProviders, getRequest: () => request };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('managed route native image editing through real image execution', () => {
  it.each([
    { name: 'manual false overrides canonical true', canonicalEdit: true, overrideEdit: false, source: 'MANUAL', nativeEdit: false, submitEndpoint: '/v1/images/generations' },
    { name: 'manual true overrides canonical false', canonicalEdit: false, overrideEdit: true, source: 'MANUAL', nativeEdit: true, submitEndpoint: '/v1/images/generations' },
    { name: 'automatic false is ignored', canonicalEdit: true, overrideEdit: false, source: 'SYNC', nativeEdit: true, submitEndpoint: '/v1/images/generations' },
    { name: 'unmarked false is ignored', canonicalEdit: true, overrideEdit: false, source: undefined, nativeEdit: true, submitEndpoint: '/v1/images/generations' },
    { name: 'unrelated manual capabilities retain canonical false', canonicalEdit: false, overrideEdit: undefined, source: 'MANUAL', nativeEdit: false, submitEndpoint: '/v1/images/generations' },
    { name: 'invalid manual string retains canonical true', canonicalEdit: true, overrideEdit: 'false', source: 'MANUAL', nativeEdit: true, submitEndpoint: '/v1/images/generations' },
    { name: 'native editing preserves an independent task contract', canonicalEdit: false, overrideEdit: true, source: 'MANUAL', nativeEdit: false, submitEndpoint: '/custom/async/generations' },
  ])('$name without changing canonical quality, result limits or billing', async ({ canonicalEdit, overrideEdit, source, nativeEdit, submitEndpoint }) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const override = {
      ...(overrideEdit !== undefined ? { supportsImageEdit: overrideEdit } : {}),
      supportedQualities: ['low'], qualityParameter: 'route_quality',
      outputMode: 'multiple_assets', maxOutputImages: 16, billingMode: 'per_image',
    };
    const state = fixture(canonicalEdit, override, source, submitEndpoint);
    const originalModel = structuredClone(state.model);
    const submissions: Array<{ url: string; method: string | undefined; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      submissions.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ task_id: 'accepted-task', status: 'success', data: [{ b64_json: png }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: 'fresh-request', model: 'gpt-image-2.5', prompt: 'change the handle',
      inputImages: [reference], aspectRatio: '16:9', resolution: '2k', quality: 'high', outputFormat: 'jpg', count: 1,
    })).resolves.toMatchObject({ images: ['https://persisted.example/result.png'], chargedCredits: '10.000000' });

    expect(submissions).toHaveLength(1);
    expect(console.info).toHaveBeenCalledWith('[image_generation_upstream_dispatch]', expect.objectContaining({
      endpoint: nativeEdit ? '/v1/images/edits' : submitEndpoint,
    }));
    expect(submissions[0]).toMatchObject({
      url: `https://1.1.1.1${nativeEdit ? '/v1/images/edits' : submitEndpoint}`, method: 'POST',
      body: { model: 'gpt-image-2.5', images: [reference], render_quality: 'high' },
    });
    for (const field of ['quality', 'route_quality', 'n']) expect(submissions[0]!.body).not.toHaveProperty(field);
    expect(state.getRequest()).toMatchObject({ status: 'SUCCEEDED', pricingSnapshot: {
      request: { quality: 'high', count: 1, billingMode: 'per_request' },
    } });
    expect(state.legacyProviders).not.toHaveBeenCalled();
    expect(state.model).toEqual(originalModel);
  });
});

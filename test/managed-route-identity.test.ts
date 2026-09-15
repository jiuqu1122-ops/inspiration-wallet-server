import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({
  ensureAiCatalogSeeded: vi.fn(async () => true),
}));

import { executeWalletImageGeneration } from '../src/modules/ai/image-service.js';
import { executeWalletAgentChat } from '../src/modules/ai/service.js';

const encryptedSecrets = encryptProviderSecrets({ apiKey: 'sk-route-test', headers: {} });

function provider(
  id: string,
  baseUrl: string,
  kind: AiProviderChannel['kind'],
  capabilities: AiProviderChannel['capabilities'],
): AiProviderChannel {
  return {
    id,
    name: id,
    kind,
    status: 'ACTIVE',
    priority: 0,
    baseUrl,
    defaultModel: null,
    allowInsecureHttp: false,
    encryptedSecrets,
    apiKeyLast4: 'test',
    capabilities,
    paramOverrides: null,
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestModelCount: null,
    lastTestedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function walletTransaction(requestId: string) {
  let requestRow: Record<string, unknown> | null = null;
  const transaction = {
    aiRequest: {
      findUnique: vi.fn(async () => requestRow),
      findFirst: vi.fn(async () => requestRow),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        requestRow = {
          id: requestId,
          ...data,
          estimatedCredits: creditDecimal(data.estimatedCredits as string),
          chargedCredits: creditDecimal(0),
        };
        return requestRow;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (requestRow) Object.assign(requestRow, data);
        return requestRow;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!requestRow || !['RESERVED', 'PROCESSING'].includes(String(requestRow.status))) return { count: 0 };
        Object.assign(requestRow, data);
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
  return { transaction, getRequest: () => requestRow };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('managed canonical route identity', () => {
  it('submits explicit Chat model A only to model A routes when its primary route fails', async () => {
    const routeA1Provider = provider('chat-a-1', 'https://1.1.1.1', 'NEW_API', ['LLM']);
    const routeA2Provider = provider('chat-a-2', 'https://8.8.8.8', 'NEW_API', ['LLM']);
    const modelBProvider = provider('chat-b-1', 'https://9.9.9.9', 'NEW_API', ['LLM']);
    const modelA = {
      id: 'model-a',
      canonicalModelKey: 'chat-model-a',
      displayName: 'Chat model A',
      modality: 'chat',
      enabled: true,
      visible: true,
      status: 'PUBLISHED',
      routingMode: 'MANAGED',
      billingType: 'token',
      capabilities: {},
      defaultRouteId: 'route-a-1',
      routes: [
        {
          id: 'route-a-1',
          canonicalModelId: 'model-a',
          provider: 'NEW_API',
          channelId: routeA1Provider.id,
          upstreamModelId: 'upstream-chat-a-primary',
          enabled: true,
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          priority: 0,
          channel: routeA1Provider,
        },
        {
          id: 'route-a-2',
          canonicalModelId: 'model-a',
          provider: 'NEW_API',
          channelId: routeA2Provider.id,
          upstreamModelId: 'upstream-chat-a-fallback',
          enabled: true,
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          priority: 10,
          channel: routeA2Provider,
        },
      ],
    };
    const { transaction, getRequest } = walletTransaction('chat-request-a');
    const findLegacyProviders = vi.fn(async () => [modelBProvider]);
    const prisma = {
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => modelA) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'chat-price-1',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'token',
              contextThresholdTokens: 272_000,
              standard: {
                inputCreditsPerMillion: '1',
                outputCreditsPerMillion: '1',
                cachedInputCreditsPerMillion: '1',
                cacheWriteCreditsPerMillion: '1',
              },
              extended: {
                inputCreditsPerMillion: '1',
                outputCreditsPerMillion: '1',
                cachedInputCreditsPerMillion: '1',
                cacheWriteCreditsPerMillion: '1',
              },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: findLegacyProviders },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const submissions: Array<{ url: string; model: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      const body = JSON.parse(String(init?.body)) as { model: string };
      submissions.push({ url, model: body.model });
      if (url.startsWith(routeA1Provider.baseUrl)) {
        return new Response(JSON.stringify({ error: { message: 'primary route unavailable' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(executeWalletAgentChat(prisma, {
      userId: 'user-1',
      clientRequestId: 'explicit-chat-a',
      model: 'chat-model-a',
      usageContext: 'chat',
      messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toMatchObject({ choices: expect.any(Array) });

    expect(findLegacyProviders).not.toHaveBeenCalled();
    expect(submissions).toEqual([
      { url: 'https://1.1.1.1/v1/chat/completions', model: 'upstream-chat-a-primary' },
      { url: 'https://8.8.8.8/v1/chat/completions', model: 'upstream-chat-a-fallback' },
    ]);
    expect(submissions.some(({ url }) => url.startsWith(modelBProvider.baseUrl))).toBe(false);
    expect(getRequest()).toMatchObject({
      canonicalModelId: 'model-a',
      logicalModel: 'chat-model-a',
      routeId: 'route-a-2',
      status: 'SUCCEEDED',
    });
  });

  it('ignores a stale model B hint and submits Image model A only to model A routes', async () => {
    const routeA1Provider = provider('image-a-1', 'https://1.0.0.1', 'MIKOTO', ['IMAGE_NANO_BANANA']);
    const routeA2Provider = provider('image-a-2', 'https://8.8.4.4', 'MIKOTO', ['IMAGE_NANO_BANANA']);
    const modelBProvider = provider('image-b-1', 'https://9.9.9.9', 'MIKOTO', ['IMAGE_NANO_BANANA']);
    const modelA = {
      id: 'image-model-a',
      canonicalModelKey: 'image-model-a',
      displayName: 'Image model A',
      modality: 'image',
      enabled: true,
      visible: true,
      status: 'PUBLISHED',
      routingMode: 'MANAGED',
      billingType: 'image_resolution',
      capabilities: {
        supportedResolutions: ['2k'],
        supportedAspectRatios: ['1:1'],
        supportsReferenceImages: true,
      },
      defaultRouteId: 'image-route-a-1',
      routes: [
        {
          id: 'image-route-a-1',
          canonicalModelId: 'image-model-a',
          provider: 'MIKOTO',
          channelId: routeA1Provider.id,
          upstreamModelId: 'gemini-3-pro-image-preview',
          adapterKey: null,
          adapterConfig: null,
          enabled: true,
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          priority: 0,
          capabilitiesOverride: null,
          metadata: null,
          channel: routeA1Provider,
        },
        {
          id: 'image-route-a-2',
          canonicalModelId: 'image-model-a',
          provider: 'MIKOTO',
          channelId: routeA2Provider.id,
          upstreamModelId: 'gemini-3-pro-image-preview',
          adapterKey: null,
          adapterConfig: null,
          enabled: true,
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          priority: 10,
          capabilitiesOverride: null,
          metadata: null,
          channel: routeA2Provider,
        },
      ],
    };
    const { transaction, getRequest } = walletTransaction('image-request-a');
    const findLegacyProviders = vi.fn(async () => [modelBProvider]);
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => modelA) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'image-price-1',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'image_resolution',
              creditsPerImageByResolution: { '2k': '10', '4k': '20' },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: findLegacyProviders },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const resultUrl = 'https://api.example.test/v1/ai/image-results/model-a.png';
    const submissions: Array<{ url: string; model: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      const body = JSON.parse(String(init?.body)) as { generationConfig?: { model?: string }; model?: string } & Record<string, unknown>;
      submissions.push({ url, model: body.model ?? body.generationConfig?.model ?? '', body });
      if (url.startsWith(routeA1Provider.baseUrl)) {
        return new Response(JSON.stringify({ error: { message: 'primary route unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ fileData: { mimeType: 'image/png', fileUri: resultUrl } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(executeWalletImageGeneration(prisma, {
      userId: 'user-1',
      clientRequestId: 'managed-image-a',
      provider: 'MIKOTO',
      providerChannelId: modelBProvider.id,
      model: 'image-model-a',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toMatchObject({
      images: [resultUrl],
      providerChannelId: routeA2Provider.id,
      model: 'image-model-a',
    });

    expect(findLegacyProviders).not.toHaveBeenCalled();
    expect(submissions.map(({ url }) => url)).toEqual([
      'https://1.0.0.1/v1beta/models/gemini-3-pro-image-preview:generateContent',
      'https://8.8.4.4/v1beta/models/gemini-3-pro-image-preview:generateContent',
    ]);
    for (const { body } of submissions) {
      expect(body).toMatchObject({
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { imageSize: '2K', aspectRatio: '1:1' },
        },
      });
    }
    expect(submissions.some(({ url }) => url.startsWith(modelBProvider.baseUrl))).toBe(false);
    expect(getRequest()).toMatchObject({
      canonicalModelId: 'image-model-a',
      logicalModel: 'image-model-a',
      routeId: 'image-route-a-2',
      status: 'SUCCEEDED',
    });
  });

  it('keeps an explicit Grok adapter on the selected route SKU during same-canonical failover', async () => {
    const primary = provider('grok-primary', 'https://1.1.1.1', 'NEW_API', ['IMAGE']);
    const fallback = provider('grok-fallback', 'https://8.8.8.8', 'NEW_API', ['IMAGE']);
    const unrelated = provider('grok-other-model', 'https://9.9.9.9', 'NEW_API', ['IMAGE']);
    const route = (id: string, channel: AiProviderChannel, priority: number) => ({
      id,
      canonicalModelId: 'model-grok',
      provider: 'NEW_API',
      channelId: channel.id,
      upstreamModelId: 'grok-imagine-image-edit',
      adapterKey: 'GROK_IMAGES_API',
      adapterConfig: null,
      enabled: true,
      upstreamAvailable: true,
      healthStatus: 'HEALTHY',
      priority,
      capabilitiesOverride: null,
      metadata: null,
      channel,
    });
    const model = {
      id: 'model-grok',
      canonicalModelKey: 'grok-image',
      displayName: 'Grok Image',
      modality: 'image',
      enabled: true,
      visible: true,
      status: 'PUBLISHED',
      routingMode: 'MANAGED',
      billingType: 'image_resolution',
      capabilities: {
        supportedResolutions: ['2k'],
        supportedAspectRatios: ['16:9'],
      },
      defaultRouteId: 'route-grok-primary',
      routes: [
        route('route-grok-primary', primary, 0),
        route('route-grok-fallback', fallback, 10),
      ],
    };
    const { transaction, getRequest } = walletTransaction('image-request-grok');
    const findLegacyProviders = vi.fn(async () => [unrelated]);
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => model) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'image-price-grok',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'image_resolution',
              creditsPerImageByResolution: { '2k': '10', '4k': '20' },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: findLegacyProviders },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const resultUrl = 'https://api.example.test/v1/ai/image-results/grok-fallback.png';
    const submissions: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submissions.push({ url, body });
      if (url.startsWith(primary.baseUrl)) {
        return new Response(JSON.stringify({ error: { message: 'primary unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [{ url: resultUrl }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(executeWalletImageGeneration(prisma, {
      userId: 'user-1',
      clientRequestId: 'managed-grok',
      model: 'grok-image',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '16:9',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toMatchObject({
      images: [resultUrl],
      providerChannelId: fallback.id,
      model: 'grok-image',
    });

    expect(findLegacyProviders).not.toHaveBeenCalled();
    expect(submissions.map(({ url }) => url)).toEqual([
      'https://1.1.1.1/v1/images/generations',
      'https://8.8.8.8/v1/images/generations',
    ]);
    for (const submission of submissions) {
      expect(submission.body.model).toBe('grok-imagine-image-edit');
      expect(submission.body).not.toHaveProperty('quality');
      expect(submission.body).not.toHaveProperty('size');
      expect(submission.body).not.toHaveProperty('output_resolution');
    }
    expect(submissions.some(({ url }) => url.startsWith(unrelated.baseUrl))).toBe(false);
    expect(getRequest()).toMatchObject({
      canonicalModelId: 'model-grok',
      logicalModel: 'grok-image',
      routeId: 'route-grok-fallback',
      status: 'SUCCEEDED',
    });
  });
});

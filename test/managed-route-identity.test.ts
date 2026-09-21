import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { storageService } from '../src/modules/storage/service.js';
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
    const resultUrl = 'https://208.67.222.222/model-a.png';
    const storedUrl = 'https://storage.example/generated-images/model-a.png?signature=redacted';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    vi.spyOn(storageService, 'uploadMedia').mockResolvedValue('generated-images/model-a.png');
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(storedUrl);
    const submissions: Array<{ url: string; model: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      if (url === resultUrl) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
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
      images: [storedUrl],
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

  it('uses Gemini Native protocol for an explicit adapter route and persists inline output', async () => {
    const channel = provider(
      'gemini-native-channel',
      'https://1.1.1.1',
      'NEW_API',
      ['IMAGE_NANO_BANANA_2'],
    );
    const route = {
      id: 'route-gemini-native',
      canonicalModelId: 'model-nano-banana-2',
      provider: 'NEW_API',
      channelId: channel.id,
      upstreamModelId: 'gemini-3.1-flash-image',
      adapterKey: 'GEMINI_NATIVE_IMAGE',
      adapterConfig: null,
      enabled: true,
      upstreamAvailable: true,
      healthStatus: 'HEALTHY',
      priority: 0,
      capabilitiesOverride: null,
      metadata: null,
      channel,
    };
    const model = {
      id: 'model-nano-banana-2',
      canonicalModelKey: 'nano-banana-2',
      displayName: 'Nano Banana 2',
      modality: 'image',
      enabled: true,
      visible: true,
      status: 'PUBLISHED',
      routingMode: 'MANAGED',
      billingType: 'image_resolution',
      capabilities: {
        supportedResolutions: ['1k', '2k', '4k'],
        supportedAspectRatios: ['16:9'],
        supportsReferenceImages: true,
      },
      defaultRouteId: route.id,
      routes: [route],
    };
    const { transaction, getRequest } = walletTransaction('image-request-gemini-native');
    const findLegacyProviders = vi.fn(async () => []);
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => model) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'image-price-gemini-native',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'image_resolution',
              creditsPerImageByResolution: { '1k': '8', '2k': '10', '4k': '20' },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: findLegacyProviders },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const referenceUrl = 'https://1.0.0.2/reference.png';
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const png = Buffer.from(pngBase64, 'base64');
    const storedUrl = 'https://storage.example/generated-images/gemini-native.png?signature=redacted';
    vi.spyOn(storageService, 'uploadMedia').mockResolvedValue('generated-images/gemini-native.png');
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(storedUrl);
    const submissions: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Headers;
    }> = [];
    const fetchMock = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      if (url === referenceUrl) {
        return new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submissions.push({ url, body, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBase64 } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeWalletImageGeneration(prisma, {
      userId: 'user-1',
      clientRequestId: 'managed-gemini-native',
      model: 'nano-banana-2',
      prompt: 'a red apple',
      inputImages: [referenceUrl],
      aspectRatio: '16:9',
      resolution: '4k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toMatchObject({
      images: [storedUrl],
      providerChannelId: channel.id,
      model: 'nano-banana-2',
    });

    expect(findLegacyProviders).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.url).toBe(
      'https://1.1.1.1/v1beta/models/gemini-3.1-flash-image:generateContent',
    );
    expect(submissions[0]?.headers.get('x-goog-api-key')).toBe('sk-route-test');
    expect(submissions[0]?.body).toMatchObject({
      contents: [{
        role: 'user',
        parts: [
          { text: expect.any(String) },
          { inlineData: { mimeType: 'image/png', data: pngBase64 } },
        ],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
      },
    });
    for (const forbidden of [
      'model',
      'prompt',
      'size',
      'quality',
      'output_resolution',
      'image_size',
      'aspect_ratio',
    ]) {
      expect(submissions[0]?.body).not.toHaveProperty(forbidden);
    }
    expect(fetchMock.mock.calls.some(([source]) => (
      /\/v1\/images\/(?:generations|edits)/.test(String(source))
    ))).toBe(false);
    expect(storageService.uploadMedia).toHaveBeenCalledTimes(1);
    expect(getRequest()).toMatchObject({
      canonicalModelId: model.id,
      logicalModel: model.canonicalModelKey,
      routeId: route.id,
      status: 'SUCCEEDED',
    });
  });

  it('keeps an ambiguous Generic async submit processing without release or route failover', async () => {
    const primary = provider('task-primary', 'https://1.1.1.1', 'USELG', ['IMAGE_NANO_BANANA_2']);
    const fallback = provider('task-fallback', 'https://8.8.8.8', 'USELG', ['IMAGE_NANO_BANANA_2']);
    const route = (id: string, channel: AiProviderChannel, priority: number) => ({
      id,
      canonicalModelId: 'model-task-image',
      provider: 'USELG',
      channelId: channel.id,
      upstreamModelId: 'gemini-3.1-flash-image-preview',
      adapterKey: 'GENERIC_OPENAI_IMAGE',
      adapterConfig: {
        async: true,
        generationEndpoint: '/v1/images/generations',
      },
      executionMode: 'TASK',
      executionConfig: {
        profile: 'USELG_IMAGE_TASK',
        submitEndpoint: '/v1/images/generations',
      },
      enabled: true,
      upstreamAvailable: true,
      healthStatus: 'HEALTHY',
      priority,
      capabilitiesOverride: null,
      metadata: null,
      channel,
    });
    const model = {
      id: 'model-task-image',
      canonicalModelKey: 'task-image',
      displayName: 'Task Image',
      modality: 'image',
      enabled: true,
      visible: true,
      status: 'PUBLISHED',
      routingMode: 'MANAGED',
      billingType: 'image_resolution',
      capabilities: {
        supportedResolutions: ['2k'],
        supportedAspectRatios: ['1:1'],
      },
      defaultRouteId: 'route-task-primary',
      routes: [
        route('route-task-primary', primary, 0),
        route('route-task-fallback', fallback, 10),
      ],
    };
    const { transaction, getRequest } = walletTransaction('image-request-task-ambiguous');
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => model) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'image-price-task',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'image_resolution',
              creditsPerImageByResolution: { '2k': '10', '4k': '10' },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'gateway timeout after forwarding the request' },
    }), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(executeWalletImageGeneration(prisma, {
      userId: 'user-1',
      clientRequestId: 'managed-task-ambiguous',
      model: 'task-image',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).rejects.toMatchObject({
      code: 'AMBIGUOUS_SUBMIT',
      statusCode: 503,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://1.1.1.1/v1/images/generations');
    expect(getRequest()).toMatchObject({ status: 'PROCESSING' });
    expect(transaction.wallet.update).not.toHaveBeenCalled();
    expect(transaction.walletLedger.create).toHaveBeenCalledTimes(1);
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
    const resultUrl = 'https://208.67.222.222/grok-fallback.png';
    const storedUrl = 'https://storage.example/generated-images/grok-fallback.png?signature=redacted';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    vi.spyOn(storageService, 'uploadMedia').mockResolvedValue('generated-images/grok-fallback.png');
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(storedUrl);
    const submissions: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = String(source);
      if (url === resultUrl) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
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
      images: [storedUrl],
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

  it('keeps a prepared adapter result locally when storage persistence fails without regenerating or failing over', async () => {
    const primary = provider('grok-persistence-primary', 'https://1.1.1.1', 'NEW_API', ['IMAGE']);
    const fallback = provider('grok-persistence-fallback', 'https://8.8.8.8', 'NEW_API', ['IMAGE']);
    const route = (id: string, channel: AiProviderChannel, priority: number) => ({
      id,
      canonicalModelId: 'model-grok-persistence',
      provider: 'NEW_API',
      channelId: channel.id,
      upstreamModelId: 'grok-imagine-image-quality',
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
      id: 'model-grok-persistence',
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
      defaultRouteId: 'route-grok-persistence-primary',
      routes: [
        route('route-grok-persistence-primary', primary, 0),
        route('route-grok-persistence-fallback', fallback, 10),
      ],
    };
    const { transaction, getRequest } = walletTransaction('image-request-grok-persistence');
    const prisma = {
      userMembership: { findFirst: vi.fn(async () => null) },
      aiModel: { findUnique: vi.fn(async () => model) },
      aiModelPricing: {
        findUnique: vi.fn(async () => ({
          currentVersion: {
            id: 'image-price-grok-persistence',
            version: 1,
            publishedAt: new Date(0),
            pricing: {
              billingType: 'image_resolution',
              creditsPerImageByResolution: { '2k': '10', '4k': '20' },
            },
          },
        })),
      },
      aiProviderChannel: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;
    const providerResultUrl = 'https://208.67.222.222/grok-persistence.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const fetchMock = vi.fn(async (source: RequestInfo | URL) => {
      const url = String(source);
      if (url === providerResultUrl) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url === 'https://1.1.1.1/v1/images/generations') {
        return new Response(JSON.stringify({ data: [{ url: providerResultUrl }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const uploadMedia = vi.spyOn(storageService, 'uploadMedia')
      .mockRejectedValue(new Error('COS unavailable'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await executeWalletImageGeneration(prisma, {
      userId: 'user-1',
      clientRequestId: 'managed-grok-persistence',
      model: 'grok-image',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '16:9',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    });
    expect(result.images[0]).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);

    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      'https://1.1.1.1/v1/images/generations',
      providerResultUrl,
    ]);
    expect(uploadMedia).toHaveBeenCalledTimes(3);
    expect(info.mock.calls.some(([event]) => event === '[image_generation_complete]')).toBe(true);
    expect(info).toHaveBeenCalledWith('[image_generation_timing]', expect.objectContaining({
      upstreamDurationMs: expect.any(Number),
      mirrorDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number),
    }));
    expect(warn).toHaveBeenCalledWith('[image_result_storage_upload_failed]', expect.objectContaining({
      clientRequestId: 'managed-grok-persistence',
      canonicalModel: 'grok-image',
      routeId: 'route-grok-persistence-primary',
      providerId: primary.id,
      adapterKey: 'GROK_IMAGES_API',
      index: 0,
      durationMs: expect.any(Number),
      final: true,
    }));
    expect(getRequest()).toMatchObject({ status: 'SUCCEEDED' });
    expect(transaction.wallet.update).toHaveBeenCalledTimes(1);
  });
});

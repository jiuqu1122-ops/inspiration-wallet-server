import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => 'https://persisted.example/direct-result.png'),
}));

import { executeWalletImageGeneration } from '../src/modules/ai/image-service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
const reference = 'https://assets.example/reference.png';
const channel: AiProviderChannel = {
  id: 'direct-channel', name: 'Direct response fixture', kind: 'NEW_API', status: 'ACTIVE', priority: 0,
  baseUrl: 'https://1.1.1.1', defaultModel: null, allowInsecureHttp: false,
  encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture', headers: {} }), apiKeyLast4: 'ture',
  capabilities: ['IMAGE'], lastTestStatus: null, lastTestMessage: null,
  lastTestModelCount: null, lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
};

function fixture(legacyUselg = false) {
  const provider = legacyUselg ? { ...channel, kind: 'USELG' as const } : channel;
  const capabilities = {
    supportedResolutions: ['2k'], supportedAspectRatios: ['16:9'], supportsReferenceImages: true,
    supportsImageEdit: true, supportedQualities: ['high', 'max'], qualityParameter: 'quality',
    outputMode: 'single_asset', maxOutputImages: 1, billingMode: 'per_request',
  };
  const route = {
    id: 'direct-route', canonicalModelId: 'image-model', provider: provider.kind, channelId: provider.id,
    upstreamModelId: 'gpt-image-2.5', adapterKey: legacyUselg ? 'LEGACY' : 'GENERIC_OPENAI_IMAGE',
    adapterConfig: legacyUselg ? null : { referenceSerializer: 'json_images' }, executionMode: 'TASK',
    executionConfig: legacyUselg
      ? { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations' }
      : { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}' },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0,
    capabilitiesOverride: null, metadata: null, channel: provider,
  };
  const fallback = { ...route, id: 'fallback-route', channelId: 'fallback-channel', priority: 10,
    channel: { ...provider, id: 'fallback-channel', baseUrl: 'https://2.2.2.2' } };
  const model = {
    id: 'image-model', canonicalModelKey: 'image-2-5-fixture', displayName: 'Image 2.5', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', routingMode: 'MANAGED',
    billingType: 'image_resolution', capabilities, defaultRouteId: route.id, routes: [route, fallback],
  };
  let row: Record<string, unknown> | null = null;
  let available = creditDecimal(100);
  let reserved = creditDecimal(0);
  const transaction = {
    aiRequest: {
      findUnique: vi.fn(async () => row), findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { id: 'wallet-request', ...data, estimatedCredits: creditDecimal(data.estimatedCredits as string), chargedCredits: creditDecimal(0) };
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (row) Object.assign(row, data); return row; }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!row || !['RESERVED', 'PROCESSING'].includes(String(row.status))) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }),
    },
    wallet: {
      updateMany: vi.fn(async () => {
        available = available.minus(25); reserved = reserved.plus(25); return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ availableCredits: available })),
      update: vi.fn(async ({ data }: { data: { availableCredits?: { increment: unknown }; reservedCredits: { decrement: unknown } } }) => {
        available = available.plus(String(data.availableCredits?.increment ?? 0));
        reserved = reserved.minus(String(data.reservedCredits.decrement));
        return { availableCredits: available };
      }),
    },
    walletLedger: { create: vi.fn(async (_entry: { data: { type: string } }) => ({})) },
    aiBillingSettlement: { create: vi.fn(async () => ({})) },
  };
  const legacyProviders = vi.fn(async () => []);
  const prisma = {
    aiRequest: transaction.aiRequest, userMembership: { findFirst: vi.fn(async () => null) },
    aiModel: { findUnique: vi.fn(async () => model) },
    aiModelPricing: { findUnique: vi.fn(async () => ({ currentVersion: {
      id: 'price', version: 1, publishedAt: new Date(0), pricing: {
        billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '25' },
      },
    } })) },
    aiProviderChannel: { findMany: legacyProviders },
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
  } as unknown as PrismaClient;
  return { prisma, transaction, legacyProviders, getRow: () => row, balances: () => ({ available: available.toString(), reserved: reserved.toString() }) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('wallet delivery of a direct final response on a generic TASK route', () => {
  it.each([false, true])('settles one POST without a task receipt (reference: %s)', async withReference => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = fixture();
    const submissions: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      submissions.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ created: 1792023276, data: [{ b64_json: png }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: 'fresh-direct-request', model: 'image-2-5-fixture', prompt: 'fixture prompt',
      inputImages: withReference ? [reference] : [], aspectRatio: '16:9', resolution: '2k', quality: 'max', outputFormat: 'jpg', count: 1,
    })).resolves.toMatchObject({
      images: ['https://persisted.example/direct-result.png'],
      imageAssets: [{ assetType: 'image', url: 'https://persisted.example/direct-result.png' }], chargedCredits: '25.000000',
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ url: `https://1.1.1.1/v1/images/${withReference ? 'edits' : 'generations'}`,
      method: 'POST', body: { model: 'gpt-image-2.5', quality: 'max', ...(withReference ? { images: [reference] } : {}) } });
    if (!withReference) expect(submissions[0]!.body).not.toHaveProperty('images');
    expect(state.getRow()).toMatchObject({ status: 'SUCCEEDED', chargedCredits: creditDecimal(25), routeId: 'direct-route' });
    expect(state.balances()).toEqual({ available: '75', reserved: '0' });
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.transaction.walletLedger.create.mock.calls.map(([entry]) => (entry as { data: { type: string } }).data.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.legacyProviders).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith('[image_provider_failover]', expect.anything());
  });

  it('keeps an explicit provider rejection failed and releases its reservation without polling', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Fixture rejected quality' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: 'rejected-direct-request', model: 'image-2-5-fixture', prompt: 'fixture prompt',
      inputImages: [], aspectRatio: '16:9', resolution: '2k', quality: 'max', outputFormat: 'jpg', count: 1,
    })).rejects.toMatchObject({ code: 'provider_request_failed' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.getRow()).toMatchObject({ status: 'FAILED' });
    expect(state.balances()).toEqual({ available: '100', reserved: '0' });
    expect(state.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
    expect(state.transaction.walletLedger.create.mock.calls.map(([entry]) => (entry as { data: { type: string } }).data.type)).toEqual(['RESERVE', 'RELEASE']);
  });
});

describe('wallet delivery on the configured Legacy USELG TASK route', () => {
  it.each(['task receipt', 'direct final data'])('settles max-quality text generation from %s with async enabled', async responseMode => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = fixture(true);
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ url: String(url), method, body: JSON.parse(String(init?.body ?? '{}')) });
      const payload = method === 'POST' && responseMode === 'task receipt'
        ? { task_id: 'accepted-task', status: 'processing', poll_after_ms: 1 }
        : { created: 1792023276, data: [{ b64_json: png }],
          ...(method === 'GET' ? { task_id: 'accepted-task', status: 'success' } : {}) };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: 'fresh-legacy-task-request', model: 'image-2-5-fixture', prompt: 'fixture prompt',
      inputImages: [], aspectRatio: '16:9', resolution: '2k', quality: 'max', outputFormat: 'jpg', count: 1,
    })).resolves.toMatchObject({
      images: ['https://persisted.example/direct-result.png'],
      imageAssets: [{ assetType: 'image', url: 'https://persisted.example/direct-result.png' }], chargedCredits: '25.000000',
    });

    expect(requests[0]).toMatchObject({
      url: 'https://1.1.1.1/v1/images/generations', method: 'POST',
      body: { model: 'gpt-image-2.5', quality: 'max', async: true },
    });
    expect(requests.map(request => request.method)).toEqual(responseMode === 'task receipt' ? ['POST', 'GET'] : ['POST']);
    if (responseMode === 'task receipt') {
      expect(requests[1]?.url).toBe('https://1.1.1.1/v1/images/tasks/accepted-task?view=summary');
      expect(state.transaction.aiRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: {
        result: expect.objectContaining({ kind: 'image_task_submission', tasks: [expect.objectContaining({
          taskId: 'accepted-task', profile: 'USELG_IMAGE_TASK', clientRequestId: 'fresh-legacy-task-request',
        })] }),
      } }));
    } else {
      expect(state.transaction.aiRequest.updateMany.mock.calls.some(([entry]) => entry.data.result
        && (entry.data.result as { kind?: string }).kind === 'image_task_submission')).toBe(false);
    }
    expect(state.getRow()).toMatchObject({ status: 'SUCCEEDED', chargedCredits: creditDecimal(25), routeId: 'direct-route' });
    expect(state.balances()).toEqual({ available: '75', reserved: '0' });
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.transaction.walletLedger.create.mock.calls.map(([entry]) => entry.data.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.legacyProviders).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith('[image_provider_failover]', expect.anything());
  });
});

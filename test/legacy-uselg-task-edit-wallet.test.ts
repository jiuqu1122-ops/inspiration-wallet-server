import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => 'https://persisted.example/edit-result.png'),
}));

import { executeWalletImageGeneration } from '../src/modules/ai/image-service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
const referencePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const reference = `data:image/png;base64,${referencePng}`;
const channel: AiProviderChannel = {
  id: 'uselg-channel', name: 'Legacy USELG fixture', kind: 'USELG', status: 'ACTIVE', priority: 0,
  baseUrl: 'https://1.1.1.1', defaultModel: null, allowInsecureHttp: false,
  encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture', headers: {} }), apiKeyLast4: 'ture',
  capabilities: ['IMAGE'], lastTestStatus: null, lastTestMessage: null,
  lastTestModelCount: null, lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
};

function fixture(supportsImageEdit: boolean, submitEndpoint: string) {
  const route = {
    id: 'uselg-route', canonicalModelId: 'image-model', provider: 'USELG', channelId: channel.id,
    upstreamModelId: 'gpt-image-2.5', adapterKey: 'LEGACY', adapterConfig: null, executionMode: 'TASK',
    executionConfig: { profile: 'USELG_IMAGE_TASK', submitEndpoint },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0,
    capabilitiesOverride: null, metadata: null, channel,
  };
  const model = {
    id: 'image-model', canonicalModelKey: 'image-2-5-fixture', displayName: 'Image 2.5', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', routingMode: 'MANAGED', billingType: 'image_resolution',
    capabilities: { supportedResolutions: ['2k'], supportedAspectRatios: ['16:9'], supportsReferenceImages: true,
      supportsImageEdit, supportedQualities: ['max'], qualityParameter: 'quality',
      outputMode: 'single_asset', maxOutputImages: 1, billingMode: 'per_request' },
    defaultRouteId: route.id, routes: [route],
  };
  let row: Record<string, unknown> | null = null;
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
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ availableCredits: creditDecimal(100) })),
      update: vi.fn(async () => ({ availableCredits: creditDecimal(75) })),
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
  return { prisma, transaction, legacyProviders, getRow: () => row };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Legacy USELG TASK references through real wallet dispatch', () => {
  it.each([
    { name: 'reference uses native edits', withReference: true, supportsImageEdit: true, submitEndpoint: '/v1/images/generations', multipart: true, async: true },
    { name: 'text generation retains JSON generations', withReference: false, supportsImageEdit: true, submitEndpoint: '/v1/images/generations', multipart: false, async: true },
    { name: 'disabled native editing preserves JSON contract', withReference: true, supportsImageEdit: false, submitEndpoint: '/v1/images/generations', multipart: false, async: true },
    { name: 'custom task endpoint preserves JSON contract', withReference: true, supportsImageEdit: true, submitEndpoint: '/custom/image-submit', multipart: false, async: false },
  ])('$name', async testCase => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = fixture(testCase.supportsImageEdit, testCase.submitEndpoint);
    const requests: Array<{ url: string; method: string; contentType: string; bytes: Buffer }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const bytes = init?.body ? Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()) : Buffer.alloc(0);
      requests.push({ url: String(url), method, contentType: new Headers(init?.headers).get('content-type') ?? '', bytes });
      const payload = method === 'POST'
        ? { task_id: 'accepted-edit-task', status: 'processing', poll_after_ms: 1 }
        : { task_id: 'accepted-edit-task', status: 'success', data: [{ b64_json: png }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: 'fresh-legacy-edit-request', model: 'image-2-5-fixture', prompt: 'fixture prompt',
      inputImages: testCase.withReference ? [reference] : [], aspectRatio: '16:9', resolution: '2k',
      quality: 'max', outputFormat: 'jpg', count: 1,
    })).resolves.toMatchObject({ images: ['https://persisted.example/edit-result.png'], chargedCredits: '25.000000' });

    expect(requests.map(request => request.method)).toEqual(['POST', 'GET']);
    expect(requests[0]?.url).toBe(`https://1.1.1.1${testCase.multipart ? '/v1/images/edits' : testCase.submitEndpoint}`);
    expect(requests[1]?.url).toBe('https://1.1.1.1/v1/images/tasks/accepted-edit-task?view=summary');
    const posted = requests[0]!;
    if (testCase.multipart) {
      expect(posted.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const body = posted.bytes.toString('utf8');
      expect(body).toContain('name="image"; filename="reference-1.png"');
      expect(posted.bytes.includes(Buffer.from(referencePng, 'base64'))).toBe(true);
      expect(body).toContain('name="model"\r\n\r\ngpt-image-2.5');
      expect(body).toContain('name="quality"\r\n\r\nmax');
      expect(body).toContain('name="async"\r\n\r\ntrue');
      expect(body).not.toContain(reference);
    } else {
      expect(posted.contentType).toContain('application/json');
      const body = JSON.parse(posted.bytes.toString('utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'gpt-image-2.5', quality: 'max' });
      if (testCase.async) expect(body.async).toBe(true); else expect(body).not.toHaveProperty('async');
      if (testCase.withReference) expect(body.image).toBe(reference); else expect(body).not.toHaveProperty('image');
    }
    expect(state.getRow()).toMatchObject({ status: 'SUCCEEDED', chargedCredits: creditDecimal(25), routeId: 'uselg-route' });
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.transaction.walletLedger.create.mock.calls.map(([entry]) => entry.data.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.legacyProviders).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith('[image_provider_failover]', expect.anything());
  });
});

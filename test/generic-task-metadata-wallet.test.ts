import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

const persisted = vi.hoisted(() => ({ index: 0 }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }));
vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => `https://persisted.example/metadata-${++persisted.index}.png`),
  createImageResultFromFile: vi.fn(async () => `https://persisted.example/metadata-${++persisted.index}.png`),
}));

import { executeWalletImageGeneration, getWalletImageGenerationByRequest, recoverWalletImageGeneration } from '../src/modules/ai/image-service.js';

const taskId = 'one-owned-upstream-task';
const clientRequestId = 'metadata-wallet-request';
const expectedMetadata = { version: 1, taskId, operation: 'imagine', speed: 'fast', requiresModal: false,
  actions: [
    { actionId: 'upscale-one', operation: 'upscale', label: 'U1', requiresPrompt: false, requiresMask: false },
    { actionId: 'vary-one', operation: 'variation', label: 'V1', requiresPrompt: true, requiresMask: false },
  ], parentTaskId: 'parent-task', expiresAt: '2030-01-01T00:00:00.000Z' };
const upstreamMetadata = { operation: 'imagine', speed: 'fast', requires_modal: false,
  actions: [
    { action_id: 'upscale-one', operation: 'upscale', label: 'U1', requires_prompt: false, requires_mask: false, secret: 'private-action-canary' },
    { action_id: 'vary-one', operation: 'variation', label: 'V1', requires_prompt: true, requires_mask: false },
  ], parent_task_id: 'parent-task', expires_at: '2030-01-01T00:00:00.000Z',
  api_key: 'private-provider-canary', authorization: 'private-auth-canary',
  headers: { authorization: 'private-header-canary' }, debug_payload: { prompt: 'private-prompt-canary' } };
let outputData: Array<{ b64_json: string }>;
const documentedMetadata = (metadata: Record<string, unknown> = upstreamMetadata) => {
  const { expires_at, ...midjourney } = metadata;
  return { midjourney, ...(expires_at === undefined ? {} : { expires_at }) };
};

function fixture(preserve = true, generic = true, operations = false) {
  const channel: AiProviderChannel = { id: 'metadata-channel', name: 'Metadata fixture', kind: 'NEW_API', status: 'ACTIVE', priority: 0,
    baseUrl: 'https://1.1.1.1', defaultModel: null, allowInsecureHttp: false,
    encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture', headers: {} }), apiKeyLast4: 'ture', capabilities: ['IMAGE'],
    lastTestStatus: null, lastTestMessage: null, lastTestModelCount: null, lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
  const route = { id: 'metadata-route', canonicalModelId: 'metadata-model', provider: channel.kind, channelId: channel.id,
    upstreamModelId: generic ? 'arbitrary-image-model' : 'grok-image', adapterKey: generic ? 'GENERIC_OPENAI_IMAGE' : 'GROK_IMAGES_API',
    adapterConfig: { ...(preserve ? { preserveTaskMetadata: true } : {}), ...(operations ? {
      enableTaskOperations: true, idempotencyHeader: 'Idempotency-Key',
      requestParameters: { operation: 'imagine', speed: 'fast', n: 1 },
    } : {}) }, executionMode: 'TASK',
    executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}' },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0, capabilitiesOverride: null, metadata: null, channel };
  const model = { id: 'metadata-model', canonicalModelKey: 'configured-metadata-image', displayName: 'Metadata fixture', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', routingMode: 'MANAGED', billingType: operations ? 'image_flat' : 'image_resolution',
    capabilities: { supportedResolutions: ['2k'], supportedAspectRatios: ['16:9'], outputMode: 'multiple_assets', maxOutputImages: 4, billingMode: 'per_request' },
    defaultRouteId: route.id, routes: [route] };
  let row: Record<string, unknown> | null = null;
  let available = creditDecimal(100);
  let reserved = creditDecimal(0);
  type Query = { where?: { id?: string; userId?: string; status?: string | { in: string[] }; userId_clientRequestId?: { userId: string; clientRequestId: string } } };
  const findRow = async ({ where }: Query) => {
    if (!row) return null;
    const identity = where?.userId_clientRequestId;
    if (identity && (identity.userId !== row.userId || identity.clientRequestId !== row.clientRequestId)) return null;
    if (where?.id && where.id !== row.id || where?.userId && where.userId !== row.userId) return null;
    return row;
  };
  const transaction = {
    aiRequest: {
      findUnique: vi.fn(findRow), findFirst: vi.fn(findRow),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { id: 'metadata-database-request', route, completedAt: null, ...data,
          estimatedCredits: creditDecimal(data.estimatedCredits as string), chargedCredits: creditDecimal(0) };
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (row) Object.assign(row, data); return row; }),
      updateMany: vi.fn(async ({ where, data }: Query & { data: Record<string, unknown> }) => {
        if (!row) return { count: 0 };
        const statuses = typeof where?.status === 'string' ? [where.status] : where?.status?.in;
        if (statuses && !statuses.includes(String(row.status))) return { count: 0 };
        if (where?.userId && where.userId !== row.userId || where?.id && where.id !== row.id) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }),
    },
    wallet: {
      updateMany: vi.fn(async ({ data }: { data: { availableCredits: { decrement: string }; reservedCredits: { increment: string } } }) => {
        available = available.minus(String(data.availableCredits.decrement)); reserved = reserved.plus(String(data.reservedCredits.increment)); return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ availableCredits: available })),
      update: vi.fn(async ({ data }: { data: { availableCredits?: { increment: unknown }; reservedCredits: { decrement: unknown } } }) => {
        available = available.plus(String(data.availableCredits?.increment ?? 0)); reserved = reserved.minus(String(data.reservedCredits.decrement));
        return { availableCredits: available };
      }),
    },
    walletLedger: { create: vi.fn(async () => ({})) }, aiBillingSettlement: { create: vi.fn(async () => ({})) },
  };
  const prisma = { aiRequest: transaction.aiRequest, userMembership: { findFirst: vi.fn(async () => null) },
    aiModel: { findUnique: vi.fn(async () => model) },
    aiModelPricing: { findUnique: vi.fn(async () => ({ currentVersion: { id: 'metadata-price', version: 1, publishedAt: new Date(0),
      pricing: operations ? { billingType: 'image_flat', creditsPerRequest: '99', creditsPerOperation: { imagine: { fast: '2' } } }
        : { billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '25' } } } })) },
    aiProviderChannel: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
  } as unknown as PrismaClient;
  const input = { userId: 'owner', clientRequestId, model: model.canonicalModelKey, prompt: 'Fixture prompt',
    inputImages: [], aspectRatio: '16:9', resolution: '2k', outputFormat: 'jpg' as const, count: 1 };
  return { prisma, input, transaction, getRow: () => row, route, model,
    balance: () => ({ available: available.toString(), reserved: reserved.toString() }) };
}

beforeAll(async () => { outputData = await Promise.all(['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map(async background => ({
  b64_json: (await sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toBuffer()).toString('base64'),
}))); });
beforeEach(() => {
  persisted.index = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function successfulTransport(metadata: Record<string, unknown> = upstreamMetadata) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ task_id: taskId, status: 'processing' })
    : Response.json({ task_id: taskId, status: 'success', data: outputData, ...documentedMetadata(metadata) }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Generic task metadata through real wallet dispatch and read-side recovery', () => {
  it.each([0, 1, 5])('dispatches the documented V8.2 model from its internal alias with %i references', async referenceCount => {
    const state = fixture();
    state.route.channel.baseUrl = 'https://api.uselg.top';
    state.route.upstreamModelId = 'midjourney-v8.2';
    state.model.canonicalModelKey = 'midjourney-v8-2';
    state.input.model = state.model.canonicalModelKey;
    state.input.prompt = 'a quiet village --stylize 100';
    Object.assign(state.model.capabilities, { outputMode: 'single_asset', maxOutputImages: 1,
      supportsReferenceImage: true, supportsImageEdit: true, minReferenceImages: 0, maxReferenceImages: 5 });
    Object.assign(state.route.adapterConfig, { generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/generations',
      requestParameters: { operation: 'imagine', speed: 'fast', n: 1 }, aspectRatioParameter: 'aspect_ratio',
      referenceSerializer: 'object_image_url', referenceTransport: 'data_url', referenceRequestCount: 1 });
    const references = await Promise.all(Array.from({ length: referenceCount }, async (_, index) =>
      `data:image/png;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3,
        background: { r: 30 + index, g: 60, b: 90 } } }).png().toBuffer()).toString('base64')}`));
    Object.assign(state.input, { inputImages: references });
    const fetch = successfulTransport();
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result.images).toHaveLength(1);
    expect(result.chargedCredits).toBe('25.000000');
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toBe('https://api.uselg.top/v1/images/generations');
    expect(JSON.parse(post[1]!.body as string)).toEqual({ model: 'midjourney-v8.2', operation: 'imagine', speed: 'fast',
      n: 1, aspect_ratio: '16:9', prompt: state.input.prompt,
      ...(referenceCount ? { images: references.map(image_url => ({ image_url })) } : {}) });
    expect(new Headers(post[1]!.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(state.balance()).toEqual({ available: '75', reserved: '0' });
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
  });

  it.each(['quota_not_enough', 'content_policy_violation'])(
    'preserves a terminal %s diagnostic through wallet release and request lookup', async reason => {
      vi.useFakeTimers();
      try {
        const state = fixture();
        const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({ task_id: taskId,
          status: init?.method === 'POST' ? 'queued' : 'failed', ...(init?.method === 'POST' ? {} : {
            error: { code: reason, message: 'https://private.example/prompt-secret.png Bearer private-token' } }) }));
        vi.stubGlobal('fetch', fetch);
        const pending = executeWalletImageGeneration(state.prisma, state.input).catch(error => error);
        await vi.advanceTimersByTimeAsync(2500);
        const failure = await pending;
        const code = reason === 'quota_not_enough' ? 'PROVIDER_QUOTA_EXCEEDED' : 'PROVIDER_CONTENT_REJECTED';
        expect(failure).toMatchObject({ code: 'provider_request_failed' });
        expect(state.getRow()?.failureDiagnostic).toMatchObject({ code });
        const lookup = await getWalletImageGenerationByRequest(state.prisma, 'owner', clientRequestId);
        expect(lookup).toMatchObject({ error: { code } });
        expect(JSON.stringify([failure.message, lookup, state.getRow()?.failureDiagnostic]))
          .not.toMatch(/private-token|prompt-secret|private\.example/);
        expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(state.balance()).toEqual({ available: '100', reserved: '0' });
        expect(state.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });

  it('pins an enabled normal generation for future actions and charges its locked imagine price once', async () => {
    const state = fixture(true, true, true);
    const fetch = successfulTransport();
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result.images).toHaveLength(4);
    expect(result.chargedCredits).toBe('2.000000');
    expect(result).not.toHaveProperty('imageOperationContext');
    expect(state.getRow()?.result).toMatchObject({ imageOperationContext: {
      version: 1, protocol: 'GENERIC_TASK', providerId: 'metadata-channel', routeId: 'metadata-route',
      submittedModel: 'arbitrary-image-model', taskId, operation: 'imagine', speed: 'fast',
      providerConnectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    expect(state.getRow()?.pricingSnapshot).toMatchObject({ request: { operation: 'imagine', speed: 'fast', operationUnitCredits: '2.000000' } });
    expect(await getWalletImageGenerationByRequest(state.prisma, 'owner', clientRequestId)).not.toHaveProperty('imageOperationContext');
    expect(await executeWalletImageGeneration(state.prisma, state.input)).toEqual(result);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.balance()).toEqual({ available: '98', reserved: '0' });
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
  });

  it('does not recycle a failed operation-priced generation request ID', async () => {
    const state = fixture(true, true, true);
    const fetch = successfulTransport();
    await executeWalletImageGeneration(state.prisma, state.input);
    state.getRow()!.status = 'FAILED';
    await expect(executeWalletImageGeneration(state.prisma, state.input)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
  });

  it('keeps failed operation receipts immutable after their route opts out of operations', async () => {
    const state = fixture(true, true, true);
    const fetch = successfulTransport();
    await executeWalletImageGeneration(state.prisma, state.input);
    state.getRow()!.status = 'FAILED';
    delete state.route.adapterConfig.enableTaskOperations;
    await expect(executeWalletImageGeneration(state.prisma, state.input)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
  });

  it('does not fail over from ordinary generation into a separately priced operation route', async () => {
    const state = fixture();
    state.route.executionMode = 'DIRECT';
    state.model.routes.push({ ...state.route, id: 'operation-secondary', channelId: 'operation-channel', priority: 1,
      channel: { ...state.route.channel, id: 'operation-channel', priority: 1 },
      adapterConfig: { preserveTaskMetadata: true, enableTaskOperations: true, idempotencyHeader: 'Idempotency-Key',
        requestParameters: { operation: 'imagine', speed: 'fast', n: 1 } } });
    const fetch = vi.fn(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(state.prisma, state.input)).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
    expect(state.getRow()?.status).toBe('FAILED');
    expect(state.balance()).toEqual({ available: '100', reserved: '0' });
  });

  it.each([408, 500])('keeps an operation-priced normal submission pending after an unconfirmed HTTP %i', async status => {
    const state = fixture(true, true, true);
    const fetch = vi.fn(async () => Response.json({ error: { message: 'Unconfirmed acceptance' } }, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(state.prisma, state.input)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
    expect(state.transaction.wallet.update).not.toHaveBeenCalled();
    expect(state.getRow()?.status).toBe('PROCESSING');
    expect(state.balance()).toEqual({ available: '98', reserved: '2' });
  });

  it('delivers all images, persists only whitelisted metadata and replays the owner result without another task or charge', async () => {
    const state = fixture(); const fetch = successfulTransport();
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result).toMatchObject({ taskMetadata: expectedMetadata, chargedCredits: '25.000000' });
    expect(result.images).toHaveLength(4);
    expect(new Set(result.images).size).toBe(4);
    expect(state.getRow()).toMatchObject({ status: 'SUCCEEDED', result: { taskMetadata: expectedMetadata } });
    expect(JSON.stringify(state.getRow()?.result)).not.toMatch(/private-(?:provider|auth|header|action|prompt)-canary/);
    const read = await getWalletImageGenerationByRequest(state.prisma, 'owner', clientRequestId);
    expect(read).toMatchObject({ status: 'succeeded', ...result });
    expect(await getWalletImageGenerationByRequest(state.prisma, 'another-owner', clientRequestId)).toBeNull();
    expect(await executeWalletImageGeneration(state.prisma, state.input)).toEqual(result);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.balance()).toEqual({ available: '75', reserved: '0' });
  });

  it.each([{ preserve: false, generic: true }, { preserve: true, generic: false }])('keeps the exact old result shape when metadata is not opted in on a Generic route: %j', async ({ preserve, generic }) => {
    const state = fixture(preserve, generic); successfulTransport();
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    const images = [1, 2, 3, 4].map(index => `https://persisted.example/metadata-${index}.png`);
    expect(result).toEqual({ images, imageAssets: images.map(url => ({ assetType: 'image', url })), provider: 'NEW_API',
      providerChannelId: 'metadata-channel', providerChannelName: 'Metadata fixture', model: 'configured-metadata-image', chargedCredits: '25.000000' });
    expect(state.getRow()?.result).not.toHaveProperty('taskMetadata');
  });

  it('retains accepted submission metadata when the successful image response omits those optional fields', async () => {
    const state = fixture();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: taskId, status: 'processing', ...documentedMetadata() })
      : Response.json({ task_id: taskId, status: 'success', data: outputData }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result).toMatchObject({ taskMetadata: expectedMetadata });
    const journalWrites = state.transaction.aiRequest.updateMany.mock.calls.map(([call]) => call.data.result)
      .filter(result => result && typeof result === 'object' && 'kind' in result && result.kind === 'image_task_submission');
    expect(JSON.stringify(journalWrites)).toContain('upscale-one');
    expect(JSON.stringify(journalWrites)).not.toMatch(/private-(?:provider|auth|header|action|prompt)-canary/);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
  });

  it('accepts the documented nested Midjourney asset response without exposing upstream billing fields', async () => {
    const state = fixture();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: taskId, status: 'processing' });
      const asset = String(url).match(/\/assets\/result-(\d)\.png/);
      if (asset) return new Response(new Uint8Array(Buffer.from(outputData[Number(asset[1])]!.b64_json, 'base64')), { headers: { 'content-type': 'image/png' } });
      const persistedImage = String(url).match(/^https:\/\/persisted\.example\/metadata-(\d+)\.png$/);
      if (persistedImage) return new Response(new Uint8Array(Buffer.from(outputData[(Number(persistedImage[1]) - 1) % outputData.length]!.b64_json, 'base64')), { headers: { 'content-type': 'image/png' } });
      return Response.json({ task_id: taskId, status: 'success', charged_amount: 0.4, currency: 'USD',
        assets: outputData.map((_image, index) => ({ url: `/v1/images/tasks/${taskId}/assets/result-${index}.png`,
          download_url: `/v1/images/tasks/${taskId}/assets/result-${index}.png?download=1`, width: 1024, height: 1024 })),
        midjourney: { operation: 'imagine', speed: 'fast', actions: [{ action_id: 'documented-action-id', label: 'U1',
          operation: 'upscale', requires_prompt: false, requires_mask: false }] } });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result).toMatchObject({ chargedCredits: '25.000000', taskMetadata: { version: 1, taskId,
      operation: 'imagine', speed: 'fast', actions: [{ actionId: 'documented-action-id', label: 'U1', operation: 'upscale', requiresPrompt: false, requiresMask: false }] } });
    expect(result.images).toHaveLength(4);
    expect(result).not.toHaveProperty('charged_amount'); expect(result).not.toHaveProperty('currency');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const downloads = fetch.mock.calls.filter(([url]) => String(url).includes('/assets/'));
    expect(downloads).toHaveLength(4);
    expect(downloads.every(([url]) => String(url).startsWith(`https://1.1.1.1/v1/images/tasks/${taskId}/assets/`))).toBe(true);
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.balance()).toEqual({ available: '75', reserved: '0' });
  });

  it('bounds public actions without truncating opaque IDs or leaking oversized and unknown fields', async () => {
    const state = fixture();
    successfulTransport({ ...upstreamMetadata, operation: 'x'.repeat(65), speed: 'x'.repeat(65),
      parent_task_id: 'x'.repeat(513), actions: Array.from({ length: 40 }, (_, index) => ({
        action_id: `opaque-action-${index}`, operation: 'upscale', label: 'x'.repeat(201), requires_prompt: false,
        secret: 'private-action-canary', payload: { token: 'private-provider-canary' },
      })) });
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    const metadata = (result as typeof result & { taskMetadata?: { actions: Array<{ actionId: string }> } }).taskMetadata;
    expect(metadata?.actions).toHaveLength(32);
    expect(metadata?.actions[0]?.actionId).toBe('opaque-action-0');
    expect(metadata?.actions.at(-1)?.actionId).toBe('opaque-action-31');
    expect(metadata).not.toHaveProperty('operation');
    expect(metadata).not.toHaveProperty('speed');
    expect(metadata).not.toHaveProperty('parentTaskId');
    expect(JSON.stringify(metadata)).not.toContain('private-');
    expect(JSON.stringify(metadata)).not.toContain('label');
    expect(result.images).toHaveLength(4);
  });

  it('projects persisted metadata again on owner lookup and same-ID replay', async () => {
    const state = fixture(); const fetch = successfulTransport();
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    state.getRow()!.result = { ...result, taskMetadata: { ...expectedMetadata, authorization: 'private-auth-canary',
      actions: expectedMetadata.actions.map(action => ({ ...action, api_key: 'private-action-canary' })) },
      tasks: [{ statusUrl: 'https://private.example/status?token=private-header-canary' }], raw: { api_key: 'private-provider-canary' } };
    const read = await getWalletImageGenerationByRequest(state.prisma, 'owner', clientRequestId);
    expect(read).toMatchObject({ taskMetadata: expectedMetadata });
    expect(read).not.toHaveProperty('tasks'); expect(read).not.toHaveProperty('raw');
    expect(JSON.stringify(read)).not.toContain('private-');
    expect(await executeWalletImageGeneration(state.prisma, state.input)).toEqual(result);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
  });

  it('keeps a mismatched task pending and recovers only the accepted task by GET with its metadata and original tariff', async () => {
    const state = fixture();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: taskId, status: 'processing' })
      : Response.json({ task_id: 'another-users-task', status: 'success', data: outputData,
        midjourney: { actions: [{ action_id: 'another-users-action', operation: 'another-users-operation' }] } }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(state.prisma, state.input)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
    expect(state.getRow()?.status).toBe('PROCESSING');
    expect(JSON.stringify(state.getRow()?.result)).not.toContain('another-users-action');
    expect(state.transaction.wallet.update).not.toHaveBeenCalled();
    expect(state.balance()).toEqual({ available: '75', reserved: '25' });
    fetch.mockImplementation(async (_url, init) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      return Response.json({ task_id: taskId, status: 'success', data: outputData, ...documentedMetadata() });
    });
    const recovered = await recoverWalletImageGeneration(state.prisma, 'owner', clientRequestId);
    expect(recovered).toMatchObject({ status: 'succeeded', taskMetadata: expectedMetadata, chargedCredits: '25.000000' });
    expect(recovered?.images).toHaveLength(4);
    expect(await executeWalletImageGeneration(state.prisma, state.input)).toMatchObject({ taskMetadata: expectedMetadata, images: recovered?.images });
    expect(await recoverWalletImageGeneration(state.prisma, 'owner', clientRequestId)).toEqual(recovered);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'GET']);
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.balance()).toEqual({ available: '75', reserved: '0' });
  });

  it.each([null, 'not-an-array', [{ action_id: {}, operation: [] }], [{ action_id: 'x'.repeat(10000), operation: 'oversized' }]])('does not fail image delivery when optional actions are malformed: %#', async actions => {
    const state = fixture(); successfulTransport({ actions, api_key: 'private-provider-canary' });
    const result = await executeWalletImageGeneration(state.prisma, state.input);
    expect(result.images).toHaveLength(4);
    expect(state.getRow()?.status).toBe('SUCCEEDED');
    expect(JSON.stringify(result)).not.toContain('private-provider-canary');
    expect(JSON.stringify(result).length).toBeLessThan(4000);
  });
});

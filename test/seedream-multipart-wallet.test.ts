import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import Fastify from 'fastify';
import { aiRoutes } from '../src/modules/ai/routes.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';
import { executeWalletImageGeneration, getWalletImageGenerationByRequest, recoverWalletImageGeneration, scheduleGeneratedImageResultStorageMirror } from '../src/modules/ai/image-service.js';
import { getImageResult } from '../src/modules/ai/image-result-store.js';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }));
vi.mock('../src/modules/storage/service.js', () => ({ storageService: {
  rewriteStoredUrls: (value: unknown) => value,
  tryResolveObjectKeyFromUrl: () => null, uploadMedia: vi.fn(async () => 'generated-images/mock.png'),
  getDownloadUrl: vi.fn(async () => 'https://storage.example/generated-images/mock.png'),
} }));
vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
const clientRequestId = 'seedream55-wallet-request';
const files: string[] = [];
let reference: string;
let output: Buffer;
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

function setup() {
  const f = fixture(false);
  Object.assign(f.route, { upstreamModelId: 'seedream-5.5', adapterConfig: {
    referenceSerializer: 'multipart_image_array', maxReferenceImages: 10, maxPromptCharacters: 8000,
    resolutionParameter: 'resolution', aspectRatioParameter: 'aspect_ratio', async: true,
    idempotencyHeader: 'Idempotency-Key', requestParameters: { n: 1, response_format: 'url' },
  }, executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
    statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary', resultEndpointTemplate: '/v1/images/tasks/{taskId}',
    asyncParameterName: 'async', asyncParameterValue: true } });
  Object.assign(f.model.capabilities, { outputMode: 'single_asset', maxOutputImages: 1, maxReferenceImages: 10, supportsReferenceImages: true });
  return f;
}
beforeAll(async () => {
  reference = 'data:image/png;base64,' + (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
  output = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
});
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => {
  for (const url of files.splice(0)) { await scheduleGeneratedImageResultStorageMirror(url); const value = await getImageResult(url.split('/').at(-1)!); if (value) await rm(value.path, { force: true }); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const final = () => Response.json({ data: [{ b64_json: output.toString('base64') }] });
async function consume(init: RequestInit) { return new Request('https://1.1.1.1/v1/images/edits', init as RequestInit & { duplex: 'half' }).formData(); }
describe('Seedream file-array wallet dispatch, validation and original receipt recovery', () => {
  it('submits ten ordered files, charges one image once and replays the same business request without another POST', async () => {
    const f = setup(); const request = { ...f.input, inputImages: Array.from({ length: 10 }, () => reference) };
    const fetch = vi.fn(async (_url, init) => { expect((await consume(init)).getAll('image[]')).toHaveLength(10); return final(); });
    vi.stubGlobal('fetch', fetch);
    const result = await executeWalletImageGeneration(f.prisma, request); files.push(...result.images);
    expect(result.images).toHaveLength(1); expect(f.getRow()?.status).toBe('SUCCEEDED');
    expect(f.transaction.wallet.updateMany).toHaveBeenCalledOnce(); expect(f.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(f.balance()).toEqual({ available: '75', reserved: '0' });
    expect((await executeWalletImageGeneration(f.prisma, request)).images).toEqual(result.images);
    expect(fetch).toHaveBeenCalledOnce(); expect(f.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
  });
  it.each(['eleven', 'canonical-nine', 'route-two', 'output-count', 'long-prompt'])('rejects %s before source reads, wallet reservation and any POST', async kind => {
    const f = setup(); const request = { ...f.input, inputImages: [reference] };
    if (kind === 'eleven') request.inputImages = Array(11).fill(reference);
    if (kind === 'canonical-nine') { request.inputImages = Array(10).fill(reference); f.model.capabilities.maxReferenceImages = 9; }
    if (kind === 'route-two') { request.inputImages = Array(3).fill(reference); f.route.capabilitiesOverride = { maxReferenceImages: 2 } as never; f.route.metadata = { capabilitiesOverrideSource: 'MANUAL' } as never; }
    if (kind === 'output-count') request.count = 2;
    if (kind === 'long-prompt') request.prompt = 'x'.repeat(8001);
    // A bogus upload key verifies validation happens before upload ownership IO.
    request.inputImages = request.inputImages.map(() => 'reference-images/not-authorized.png');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(f.prisma, request)).rejects.toMatchObject({ statusCode: 400 });
    expect(fetch).not.toHaveBeenCalled(); expect(f.transaction.wallet.updateMany).not.toHaveBeenCalled(); expect(f.getRow()).toBeNull();
  });
  it.each([500, 503, 0])('holds uncertain submission %i without releasing credits, failover, second reservation or settlement', async status => {
    const f = setup(); const fetch = vi.fn(async (_url, init) => { await consume(init);
      if (!status) throw new TypeError('fetch failed'); return new Response('uncertain', { status }); }); vi.stubGlobal('fetch', fetch);
    const request = { ...f.input, inputImages: [reference] };
    await expect(executeWalletImageGeneration(f.prisma, request)).rejects.toMatchObject({ code: 'AMBIGUOUS_SUBMIT' });
    expect(fetch).toHaveBeenCalledOnce(); expect(f.getRow()?.status).toBe('PROCESSING');
    expect(f.transaction.wallet.update).not.toHaveBeenCalled(); expect(f.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
    await expect(executeWalletImageGeneration(f.prisma, request)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(fetch).toHaveBeenCalledOnce(); expect(f.transaction.wallet.updateMany).toHaveBeenCalledOnce();
  });
  it('preserves a paused original task and recovers it by GET with the captured price, settling only once', async () => {
    const f = setup(); let recovering = false;
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') { await consume(init); return Response.json({ task_id: 'owned-task', status: 'processing', auto_poll: false }, { status: 202 }); }
      expect(recovering).toBe(true); expect(String(url)).toBe('https://1.1.1.1/v1/images/tasks/owned-task?view=summary');
      return Response.json({ task_id: 'owned-task', status: 'success', data: [{ b64_json: output.toString('base64') }] });
    }); vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(f.prisma, { ...f.input, inputImages: [reference] })).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce(); expect(f.getRow()?.status).toBe('PROCESSING');
    expect(f.transaction.wallet.update).not.toHaveBeenCalled(); expect(f.transaction.aiBillingSettlement.create).not.toHaveBeenCalled();
    recovering = true;
    const [result, concurrent] = await Promise.all([recoverWalletImageGeneration(f.prisma, f.input.userId, clientRequestId),
      recoverWalletImageGeneration(f.prisma, f.input.userId, clientRequestId)]); files.push(...result!.images);
    expect(concurrent).toEqual(result);
    expect(result?.status).toBe('succeeded'); expect(f.balance()).toEqual({ available: '75', reserved: '0' });
    await recoverWalletImageGeneration(f.prisma, f.input.userId, clientRequestId);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce(); expect(f.transaction.wallet.updateMany).toHaveBeenCalledOnce();
  });
  it('retains a final synchronous URL receipt after download failure and retries only that download', async () => {
    const f = setup(); const url = 'https://1.1.1.1/assets/result.png?signature=unchanged'; let recovering = false;
    const fetch = vi.fn(async (target, init) => {
      if (init?.method === 'POST') { await consume(init); return Response.json({ data: [{ url }] }); }
      expect(String(target)).toBe(url); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture');
      return recovering ? new Response(output, { headers: { 'content-type': 'image/png' } }) : new Response('temporarily not allowed', { status: 403 });
    }); vi.stubGlobal('fetch', fetch);
    await expect(executeWalletImageGeneration(f.prisma, { ...f.input, inputImages: [reference] })).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
    expect(f.transaction.aiBillingSettlement.create).not.toHaveBeenCalled(); expect(f.transaction.wallet.update).not.toHaveBeenCalled();
    recovering = true;
    const result = await recoverWalletImageGeneration(f.prisma, f.input.userId, clientRequestId); files.push(...result!.images);
    expect(result?.status).toBe('succeeded'); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce(); expect(f.balance()).toEqual({ available: '75', reserved: '0' });
  });
  it('admits ten references through the HTTP schema and clearly rejects eleven before any dispatch', async () => {
    const f = setup(); const app = Fastify(); app.decorate('prisma', f.prisma);
    app.decorate('authenticateAccessToken', async (request: { user: { sub: string } }) => { request.user = { sub: f.input.userId }; });
    await app.register(aiRoutes, { prefix: '/v1/ai' });
    const fetch = vi.fn(async (_url, init) => { expect((await consume(init)).getAll('image[]')).toHaveLength(10); return final(); });
    vi.stubGlobal('fetch', fetch);
    const { userId: _user, ...payload } = f.input;
    try {
      const invalid = await app.inject({ method: 'POST', url: '/v1/ai/images/generations', payload: { ...payload, inputImages: Array(11).fill(reference) } });
      expect(invalid.statusCode).toBe(400); expect(invalid.json().message).toMatch(/10/); expect(fetch).not.toHaveBeenCalled();
      const valid = await app.inject({ method: 'POST', url: '/v1/ai/images/generations', payload: { ...payload, inputImages: Array(10).fill(reference) } });
      expect(valid.statusCode).toBe(200); files.push(...valid.json().images); expect(fetch).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

});

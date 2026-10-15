import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';
import { IMAGE_OPERATIONS } from '../src/modules/ai/image-operation-pricing.js';
import { imageOperationProviderFingerprint, type ImageOperationInput } from '../src/modules/ai/image-operation-protocol.js';

const persistence = vi.hoisted(() => ({ index: 0 }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }));
vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => `https://persisted.example/operation-${++persistence.index}.png`),
  createImageResultFromFile: vi.fn(async () => `https://persisted.example/operation-${++persistence.index}.png`),
}));

import { getWalletImageOperation, submitWalletImageOperation } from '../src/modules/ai/image-operation-service.js';

type Row = Record<string, unknown>;
type Where = { id?: string; userId?: string; status?: string | { in: string[] }; result?: { equals: unknown }; userId_clientRequestId?: { userId: string; clientRequestId: string } };
type WalletChange = { availableCredits?: { increment?: unknown; decrement?: unknown }; reservedCredits?: { increment?: unknown; decrement?: unknown }; lifetimeConsumed?: { increment: unknown } };
let png: Buffer;
let mask: string;
const record = (value: unknown) => value as Record<string, unknown>;

function fixture() {
  const provider = { id: 'operation-channel', name: 'Operation fixture', kind: 'NEW_API', baseUrl: 'https://1.1.1.1', status: 'ACTIVE',
    encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture-only', headers: {} }) };
  const route = { id: 'operation-route', canonicalModelId: 'operation-model', provider: 'NEW_API', channelId: provider.id,
    upstreamModelId: 'arbitrary-upstream-model', adapterKey: 'GENERIC_OPENAI_IMAGE', executionMode: 'TASK',
    adapterConfig: { enableTaskOperations: true, preserveTaskMetadata: true, idempotencyHeader: 'Idempotency-Key',
      requestParameters: { operation: 'imagine', speed: 'fast', n: 1 } } as Record<string, unknown>,
    executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}' },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0, channel: provider };
  const model = { id: 'operation-model', canonicalModelKey: 'configured-operation-model', displayName: 'Operation fixture', modality: 'image',
    billingType: 'image_flat', routingMode: 'MANAGED', enabled: true, visible: true, status: 'PUBLISHED', defaultRouteId: route.id, capabilities: {}, routes: [route] };
  const prices = Object.fromEntries(IMAGE_OPERATIONS.map(operation => [operation, { fast: operation === 'modal' ? '7' : operation === 'upscale_subtile' ? '0' : '2', relax: '1', turbo: '3' }]));
  const rows = new Map<string, Row>();
  const parent: Row = { id: 'original-parent', userId: 'owner', clientRequestId: 'parent-request', logicalModel: model.canonicalModelKey,
    canonicalModelId: model.id, routeId: route.id, capability: 'IMAGE', status: 'SUCCEEDED',
    result: { images: ['https://persisted.example/parent.png'], taskMetadata: { version: 1, taskId: 'owned-parent-task',
      actions: ['upscale', 'upscale_subtile', 'inpaint', 'custom_zoom'].map(operation => ({ actionId: `action-${operation}`, operation })) },
    imageOperationContext: { version: 1, protocol: 'GENERIC_TASK', providerId: provider.id, routeId: route.id,
      submittedModel: route.upstreamModelId, taskId: 'owned-parent-task', operation: 'imagine', speed: 'fast',
      providerConnectionFingerprint: imageOperationProviderFingerprint(provider), imageDimensions: { width: 2, height: 2 }, originalImageDimensions: { width: 2, height: 2 } } } };
  rows.set(String(parent.id), parent);
  let available = creditDecimal(100); let reserved = creditDecimal(0); let consumed = creditDecimal(0);
  const ledger: Row[] = [];
  const settlements: Row[] = [];
  const snapshot = (row: Row | null | undefined): Row | null => row ? { ...row,
    result: structuredClone(row.result), pricingSnapshot: structuredClone(row.pricingSnapshot) } : null;
  const find = ({ where }: { where: Where }) => {
    if (where.id) return snapshot(rows.get(where.id));
    const identity = where.userId_clientRequestId;
    return snapshot([...rows.values()].find(row => identity && row.userId === identity.userId && row.clientRequestId === identity.clientRequestId));
  };
  const changeWallet = (data: WalletChange) => {
    available = available.plus(String(data.availableCredits?.increment ?? 0)).minus(String(data.availableCredits?.decrement ?? 0));
    reserved = reserved.plus(String(data.reservedCredits?.increment ?? 0)).minus(String(data.reservedCredits?.decrement ?? 0));
    consumed = consumed.plus(String(data.lifetimeConsumed?.increment ?? 0));
  };
  const tx = {
    aiRequest: { findUnique: vi.fn(async (query: { where: Where }) => find(query)),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `operation-${rows.size}`, chargedCredits: creditDecimal(0), completedAt: null, ...data };
        rows.set(String(row.id), row); return snapshot(row)!;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const row = where.id ? rows.get(where.id) : undefined;
        const statuses = typeof where.status === 'string' ? [where.status] : where.status?.in;
        if (!row || where.userId && row.userId !== where.userId || statuses && !statuses.includes(String(row.status))) return { count: 0 };
        if (where.result && JSON.stringify(row.result) !== JSON.stringify(where.result.equals)) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }),
    },
    wallet: { updateMany: vi.fn(async ({ where, data }: { where: { availableCredits: { gte: unknown } }; data: WalletChange }) => {
      if (available.lt(String(where.availableCredits.gte))) return { count: 0 };
      changeWallet(data); return { count: 1 };
    }), findUniqueOrThrow: vi.fn(async () => ({ availableCredits: available })),
    update: vi.fn(async ({ data }: { data: WalletChange }) => { changeWallet(data); return { availableCredits: available }; }) },
    walletLedger: { create: vi.fn(async ({ data }: { data: Row }) => { ledger.push(data); return data; }) },
    aiBillingSettlement: { create: vi.fn(async ({ data }: { data: Row }) => { settlements.push(data); return data; }) },
  };
  let transactionQueue: Promise<unknown> = Promise.resolve();
  const prisma = { ...tx, aiModel: { findUnique: vi.fn(async () => model) }, aiModelAlias: { findUnique: vi.fn(async () => null) },
    aiModelRoute: { findUnique: vi.fn(async () => route) },
    aiModelPricing: { findUnique: vi.fn(async () => ({ currentVersion: { id: 'operation-price', version: 1,
      pricing: { billingType: 'image_flat', creditsPerRequest: '99', creditsPerOperation: prices } } })) },
    userMembership: { findFirst: vi.fn(async () => null) },
    $transaction: (callback: (transaction: typeof tx) => unknown) => {
      const pending = transactionQueue.then(() => callback(tx)); transactionQueue = pending.catch(() => {}); return pending;
    },
  } as unknown as PrismaClient;
  const input: ImageOperationInput = { userId: 'owner', clientRequestId: 'fresh-operation', model: model.canonicalModelKey, operation: 'imagine', prompt: 'Fixture prompt' };
  const rowFor = (receipt = input.clientRequestId) => [...rows.values()].find(row => row.userId === 'owner' && row.clientRequestId === receipt)!;
  const permitRefresh = (receipt = input.clientRequestId) => { record(rowFor(receipt).result).nextRefreshAt = 0; };
  return { prisma, input, rows, parent, provider, route, model, prices, tx, ledger, settlements, rowFor, permitRefresh,
    setAvailable: (value: string) => { available = creditDecimal(value); },
    balances: () => ({ available: available.toString(), reserved: reserved.toString(), consumed: consumed.toString() }) };
}

beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#345678' } }).png().toBuffer();
  mask = `data:image/png;base64,${(await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64')}`;
});
beforeEach(() => { persistence.index = 0; vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const postedBody = (fetch: ReturnType<typeof vi.fn>) => JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1].body)) as Record<string, unknown>;
const imageResponse = () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
const resultAsset = (name = 'final') => ({ assets: [{ url: `/assets/${name}.png` }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('image operations through real catalog, pricing and transactional wallet helpers', () => {
  it('submits one accepted task, GETs four images and settles the captured operation price once', async () => {
    const state = fixture();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: 'accepted-operation', status: 'queued' });
      if (String(url).includes('/assets/') || String(url).startsWith('https://persisted.example/')) return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
      return Response.json({ task_id: 'accepted-operation', status: 'success', assets: [0, 1, 2, 3].map(index => ({ url: `/assets/output-${index}.png` })),
        midjourney: { operation: 'imagine', speed: 'fast', actions: [{ action_id: 'an-upscale-action', operation: 'upscale', label: 'U1' }] } });
    });
    vi.stubGlobal('fetch', fetch);
    const accepted = await submitWalletImageOperation(state.prisma, state.input);
    expect(accepted).toMatchObject({ status: 'queued', taskId: 'accepted-operation', chargedCredits: '0.000000' });
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
    await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    state.permitRefresh();
    state.prices.imagine!.fast = '99';
    const complete = await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true });
    expect(complete).toMatchObject({ status: 'success', chargedCredits: '2.000000', taskMetadata: { taskId: 'accepted-operation' } });
    expect(complete?.images).toHaveLength(4);
    expect(postedBody(fetch)).toEqual({ model: 'arbitrary-upstream-model', operation: 'imagine', speed: 'fast', n: 1, prompt: 'Fixture prompt' });
    expect(await submitWalletImageOperation(state.prisma, state.input)).toEqual(complete);
    expect(await getWalletImageOperation(state.prisma, 'other-owner', state.input.clientRequestId, { refresh: true })).toBeNull();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.settlements).toHaveLength(1);
    expect(state.balances()).toEqual({ available: '98', reserved: '0', consumed: '2' });
    expect(JSON.stringify(complete)).not.toMatch(/imageOperationContext|providerConnectionFingerprint|receiptKey|fingerprint|fixture-only/);
  });

  it.each(['describe', 'shorten', 'uploads'] as const)('settles one %s result with zero images', async operation => {
    const state = fixture();
    const input: ImageOperationInput = { ...state.input, operation, ...(operation === 'shorten' ? { prompt: 'A long fixture prompt' } : { inputImages: [`data:image/png;base64,${png.toString('base64')}`] }) };
    if (operation !== 'shorten') delete input.prompt;
    const fetch = vi.fn(async () => Response.json({ task_id: `${operation}-task`, status: 'success', midjourney: operation === 'uploads'
      ? { uploaded_urls: ['https://uploads.example/one.png'] } : { texts: ['A safe text result'] } }));
    vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, input);
    expect(result).toMatchObject({ status: 'success', images: [], chargedCredits: '2.000000' });
    if (operation === 'uploads') expect(result.uploadedUrls).toEqual(['https://uploads.example/one.png']);
    else expect(result.texts).toEqual(['A safe text result']);
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '0', consumed: '2' });
    if (operation !== 'shorten') expect(postedBody(fetch)).toMatchObject({ images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }] });
  });

  it.each(['inpaint', 'custom_zoom'] as const)('requires a separate owned %s modal action and charges each confirmed submission at its own price', async operation => {
    const state = fixture();
    const posts: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return imageResponse();
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return posts.length === 1 ? Response.json({ task_id: 'new-inpaint-window', status: 'success', midjourney: { requires_modal: true,
        actions: [{ action_id: 'confirm-inpaint', operation: 'modal', requires_prompt: true, requires_mask: true }] } })
        : Response.json({ task_id: 'confirmed-inpaint', status: 'success', ...resultAsset('modal') });
    });
    vi.stubGlobal('fetch', fetch);
    const windowInput: ImageOperationInput = { ...state.input, clientRequestId: 'window-request', operation, parentClientRequestId: 'parent-request', actionId: `action-${operation}` };
    delete windowInput.prompt;
    const window = await submitWalletImageOperation(state.prisma, windowInput);
    expect(window).toMatchObject({ status: 'success', requiresModal: true, chargedCredits: '2.000000' });
    expect(posts).toHaveLength(1);
    const confirmed = await submitWalletImageOperation(state.prisma, { ...state.input, clientRequestId: 'confirm-request', operation: 'modal',
      parentClientRequestId: 'window-request', actionId: 'confirm-inpaint', prompt: 'Apply the edit', ...(operation === 'inpaint' ? { maskBase64: mask } : { zoom: 1.5 }) });
    expect(confirmed).toMatchObject({ status: 'success', chargedCredits: '7.000000' });
    expect(confirmed.images).toHaveLength(1);
    expect(posts[0]).toMatchObject({ parent_task_id: 'owned-parent-task', action_id: `action-${operation}`, operation, speed: 'fast' });
    expect(posts[1]).toMatchObject({ parent_task_id: 'new-inpaint-window', action_id: 'confirm-inpaint', operation: 'modal',
      ...(operation === 'inpaint' ? { mask_base64: mask } : { zoom: 1.5 }) });
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE', 'RESERVE', 'CHARGE']);
    expect(state.settlements).toHaveLength(2);
    expect(state.balances()).toEqual({ available: '91', reserved: '0', consumed: '9' });
  });

  it.each(['owner', 'action', 'model', 'expired', 'route', 'account', 'speed'] as const)('rejects an invalid parent %s before reservation or POST', async kind => {
    const state = fixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const input: ImageOperationInput = { ...state.input, operation: 'upscale', parentClientRequestId: 'parent-request', actionId: 'action-upscale' };
    delete input.prompt;
    if (kind === 'owner') input.userId = 'other-owner';
    if (kind === 'action') input.actionId = 'not-an-owned-action';
    if (kind === 'model') state.parent.canonicalModelId = 'another-model';
    if (kind === 'expired') record(record(state.parent.result).taskMetadata).expiresAt = '2000-01-01T00:00:00Z';
    if (kind === 'route') delete state.route.adapterConfig.enableTaskOperations;
    if (kind === 'account') state.provider.baseUrl = 'https://2.2.2.2';
    if (kind === 'speed') input.speed = 'turbo';
    await expect(submitWalletImageOperation(state.prisma, input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(state.tx.wallet.updateMany).not.toHaveBeenCalled(); expect(state.ledger).toEqual([]);
  });

  it('holds an uncertain submission and only recovers the exact hashed receipt by GET without reposting', async () => {
    const state = fixture();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Fixture connection dropped after upload'));
    vi.stubGlobal('fetch', fetch);
    const uncertain = await submitWalletImageOperation(state.prisma, state.input);
    expect(uncertain).toMatchObject({ status: 'uncertain', chargedCredits: '0.000000' });
    expect(await submitWalletImageOperation(state.prisma, state.input)).toEqual(uncertain);
    expect(fetch).toHaveBeenCalledOnce();
    const receiptKey = record(state.rowFor().result).receiptKey;
    expect(receiptKey).toMatch(/^[a-f0-9]{64}$/);
    state.permitRefresh();
    fetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      if (String(url).includes('/assets/') || String(url).startsWith('https://persisted.example/')) return imageResponse();
      return Response.json({ data: [
        { client_request_id: 'foreign-hash', task_id: 'foreign-task', status: 'success', midjourney: { texts: ['Foreign result'] } },
        { client_request_id: receiptKey, task_id: 'accepted-uncertain-task', status: 'success', ...resultAsset('recovered') },
      ] });
    });
    const recovered = await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true });
    expect(recovered).toMatchObject({ status: 'success', taskId: 'accepted-uncertain-task', chargedCredits: '2.000000' });
    expect(recovered?.images).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toContain('Foreign');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '0', consumed: '2' });
  });

  it('refunds a definite rejection once and never recycles the failed operation ID', async () => {
    const state = fixture(); const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Fixture rejected' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const failed = await submitWalletImageOperation(state.prisma, state.input);
    expect(failed).toMatchObject({ status: 'failed', chargedCredits: '0.000000' });
    expect(await submitWalletImageOperation(state.prisma, state.input)).toEqual(failed);
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'RELEASE']);
    expect(state.settlements).toEqual([]);
    expect(state.balances()).toEqual({ available: '100', reserved: '0', consumed: '0' });
  });

  it('rejects changed payloads under an existing ID without a second reservation or request', async () => {
    const state = fixture(); const fetch = vi.fn().mockResolvedValue(Response.json({ task_id: 'pending-task', status: 'running' }));
    vi.stubGlobal('fetch', fetch);
    await submitWalletImageOperation(state.prisma, state.input);
    await expect(submitWalletImageOperation(state.prisma, { ...state.input, prompt: 'A changed prompt' })).rejects.toMatchObject({ code: 'image_operation_id_conflict' });
    expect(fetch).toHaveBeenCalledOnce(); expect(state.tx.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
  });

  it('allows a configured zero-price action with an empty wallet', async () => {
    const state = fixture(); state.setAvailable('0');
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: 'free-action', status: 'success', ...resultAsset('free') }) : imageResponse());
    vi.stubGlobal('fetch', fetch);
    const input: ImageOperationInput = { ...state.input, operation: 'upscale_subtile', parentClientRequestId: 'parent-request', actionId: 'action-upscale_subtile' };
    delete input.prompt;
    expect(await submitWalletImageOperation(state.prisma, input)).toMatchObject({ status: 'success', chargedCredits: '0.000000' });
    expect(state.balances()).toEqual({ available: '0', reserved: '0', consumed: '0' });
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects missing operation prices before reservation and never falls back to the legacy flat price', async () => {
    const state = fixture(); delete record(state.prices.imagine).fast;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(submitWalletImageOperation(state.prisma, state.input)).rejects.toMatchObject({ code: 'PRICING_NOT_AVAILABLE' });
    expect(state.tx.wallet.updateMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(state.balances()).toEqual({ available: '100', reserved: '0', consumed: '0' });
  });

  it('does not submit or create a request when the atomic reservation finds insufficient credits', async () => {
    const state = fixture(); state.setAvailable('1'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(submitWalletImageOperation(state.prisma, state.input)).rejects.toMatchObject({ code: 'insufficient_credits' });
    expect(state.tx.aiRequest.create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(state.ledger).toEqual([]);
    expect(state.balances()).toEqual({ available: '1', reserved: '0', consumed: '0' });
  });

  it('keeps the accepted task reserved on a foreign GET result without using its actions or creating another task', async () => {
    const state = fixture(); const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: 'accepted-task', status: 'running' })
      : Response.json({ task_id: 'foreign-task', status: 'success', midjourney: { texts: ['Foreign result'], actions: [{ action_id: 'foreign-action', operation: 'upscale' }] } }));
    vi.stubGlobal('fetch', fetch);
    await submitWalletImageOperation(state.prisma, state.input); state.permitRefresh();
    const result = await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true });
    expect(result).toMatchObject({ status: 'uncertain', taskId: 'accepted-task', images: [], texts: [], chargedCredits: '0.000000' });
    expect(JSON.stringify(state.rowFor().result)).not.toContain('foreign-action');
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
  });

  it('rejects a modal submission against the original image or a mismatched mask before charging', async () => {
    const state = fixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const metadata = record(record(state.parent.result).taskMetadata);
    metadata.requiresModal = true; metadata.actions = [{ actionId: 'confirm', operation: 'modal', requiresPrompt: true, requiresMask: true }];
    const input: ImageOperationInput = { ...state.input, operation: 'modal', parentClientRequestId: 'parent-request', actionId: 'confirm', maskBase64: mask };
    await expect(submitWalletImageOperation(state.prisma, input)).rejects.toMatchObject({ code: 'invalid_image_operation' });
    record(record(state.parent.result).imageOperationContext).operation = 'inpaint';
    const wrongMask = `data:image/png;base64,${(await sharp({ create: { width: 3, height: 3, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64')}`;
    await expect(submitWalletImageOperation(state.prisma, { ...input, maskBase64: wrongMask })).rejects.toMatchObject({ code: 'invalid_image_operation' });
    expect(state.tx.wallet.updateMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('submits blend references in the configured object format without adding a prompt', async () => {
    const state = fixture(); const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: 'blend-task', status: 'success', ...resultAsset('blend') }) : imageResponse());
    vi.stubGlobal('fetch', fetch);
    const reference = `data:image/png;base64,${png.toString('base64')}`;
    const input: ImageOperationInput = { ...state.input, operation: 'blend', inputImages: [reference, reference], dimensions: 'LANDSCAPE' }; delete input.prompt;
    expect(await submitWalletImageOperation(state.prisma, input)).toMatchObject({ status: 'success', chargedCredits: '2.000000' });
    expect(postedBody(fetch)).toEqual({ model: 'arbitrary-upstream-model', operation: 'blend', speed: 'fast', n: 1,
      images: [{ image_url: reference }, { image_url: reference }], dimensions: 'LANDSCAPE' });
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
  });

  it('does not let a delayed empty task-list response erase an accepted original POST receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const state = fixture(); const postStarted = deferred<void>(); const postResponse = deferred<Response>();
    const listStarted = deferred<void>(); const listResponse = deferred<Response>();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { postStarted.resolve(undefined); return postResponse.promise; }
      if (String(url).includes('?limit=100')) { listStarted.resolve(undefined); return listResponse.promise; }
      if (String(url).includes('/assets/') || String(url).startsWith('https://persisted.example/')) return imageResponse();
      return Response.json({ task_id: 'accepted-original-post', status: 'success', ...resultAsset('race') });
    });
    vi.stubGlobal('fetch', fetch);
    const submitting = submitWalletImageOperation(state.prisma, state.input); await postStarted.promise;
    vi.setSystemTime(Date.now() + 6_000);
    const lookup = getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true }); await listStarted.promise;
    postResponse.resolve(Response.json({ task_id: 'accepted-original-post', status: 'running' }));
    expect(await submitting).toMatchObject({ taskId: 'accepted-original-post' });
    listResponse.resolve(Response.json({ data: [] })); await lookup;
    expect(record(state.rowFor().result)).toMatchObject({ taskId: 'accepted-original-post',
      imageOperationContext: { taskId: 'accepted-original-post', operation: 'imagine', speed: 'fast' } });
    expect(record(record(state.rowFor().pricingSnapshot).request).operationUnitCredits).toBe('2.000000');
    vi.setSystemTime(Date.now() + 6_000);
    expect(await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true }))
      .toMatchObject({ status: 'success', taskId: 'accepted-original-post', chargedCredits: '2.000000' });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('?limit=100'))).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => String(url) === 'https://1.1.1.1/v1/images/tasks/accepted-original-post')).toBe(true);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
  });

  it('settles one ledger charge when two independent service replicas finish the same accepted task', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const replicaPath = '../src/modules/ai/image-operation-service.js?replica=second-process-fixture';
    const replica = await import(replicaPath) as typeof import('../src/modules/ai/image-operation-service.js');
    const state = fixture(); const started = [deferred<void>(), deferred<void>()]; const responses = [deferred<Response>(), deferred<Response>()];
    let reads = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: 'shared-terminal-task', status: 'running' });
      const index = reads++; started[index]!.resolve(undefined); return responses[index]!.promise;
    });
    vi.stubGlobal('fetch', fetch);
    await submitWalletImageOperation(state.prisma, { ...state.input, operation: 'shorten' });
    vi.setSystemTime(Date.now() + 6_000);
    const first = getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true }); await started[0]!.promise;
    vi.setSystemTime(Date.now() + 6_000);
    const second = replica.getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true }); await started[1]!.promise;
    for (const response of responses) response.resolve(Response.json({ task_id: 'shared-terminal-task', status: 'success', midjourney: { texts: ['One final text'] } }));
    await Promise.all([first, second]);
    expect(state.rowFor().status).toBe('SUCCEEDED'); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.settlements).toHaveLength(1); expect(state.balances()).toEqual({ available: '98', reserved: '0', consumed: '2' });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each(['imagine', 'describe', 'shorten', 'uploads', 'upscale', 'inpaint', 'modal'] as const)('does not charge a successful %s status with the wrong result modality', async operation => {
    const state = fixture();
    const input: ImageOperationInput = { ...state.input, operation };
    if (operation === 'describe' || operation === 'uploads') { delete input.prompt; input.inputImages = [`data:image/png;base64,${png.toString('base64')}`]; }
    if (['upscale', 'inpaint', 'modal'].includes(operation)) { input.parentClientRequestId = 'parent-request'; input.actionId = `action-${operation}`; }
    if (operation === 'modal') {
      record(record(state.parent.result).imageOperationContext).operation = 'inpaint';
      Object.assign(record(record(state.parent.result).taskMetadata), { requiresModal: true, actions: [{ actionId: 'action-modal', operation: 'modal', requiresMask: true }] });
      input.maskBase64 = mask;
    }
    const midjourney = operation === 'shorten' ? { uploaded_urls: ['https://uploads.example/wrong.png'] }
      : operation === 'inpaint' ? { requires_modal: true, actions: [] } : { texts: ['Wrong text-only result'] };
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: 'wrong-modality-task', status: 'success', ...(operation === 'describe' ? resultAsset('wrong') : { midjourney }) }) : imageResponse());
    vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, input);
    expect(result.status).not.toBe('success'); expect(result.chargedCredits).toBe('0.000000');
    expect(state.rowFor().status).toBe('PROCESSING'); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.settlements).toEqual([]); expect(state.balances().consumed).toBe('0');
  });

  it('maps a terminal failed database row to failed even when its historical journal says running', async () => {
    const state = fixture(); const fetch = vi.fn().mockResolvedValue(Response.json({ task_id: 'stale-status-task', status: 'running' }));
    vi.stubGlobal('fetch', fetch); await submitWalletImageOperation(state.prisma, state.input);
    state.rowFor().status = 'FAILED'; record(state.rowFor().result).status = 'running'; state.permitRefresh();
    expect(await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true })).toMatchObject({ status: 'failed' });
    expect(fetch).toHaveBeenCalledOnce(); expect(state.settlements).toEqual([]);
  });

  it.each([503, 307, 'timeout'] as const)('keeps an uncertain %s submission reserved without retrying or refunding', async outcome => {
    const state = fixture(); const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      if (outcome === 'timeout') throw new DOMException('Fixture response deadline exceeded', 'TimeoutError');
      return Response.json({ error: { message: 'Fixture uncertain submission' } }, { status: outcome });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, state.input);
    expect(result).toMatchObject({ status: 'uncertain', chargedCredits: '0.000000' });
    expect(await submitWalletImageOperation(state.prisma, state.input)).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce(); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
  });

  it('retains an accepted task and its credits when an asset GET returns a definite 400', async () => {
    const state = fixture(); const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ task_id: 'accepted-before-asset-failure', status: 'success', ...resultAsset('rejected') })
      : Response.json({ error: { message: 'Fixture asset not ready' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, state.input);
    expect(result).toMatchObject({ status: 'uncertain', taskId: 'accepted-before-asset-failure', chargedCredits: '0.000000' });
    expect(await submitWalletImageOperation(state.prisma, state.input)).toEqual(result);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']); expect(state.settlements).toEqual([]);
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
  });

  it.each(['operation', 'speed', 'model', 'parent'] as const)('does not use a successful response with mismatched %s identity', async mismatch => {
    const state = fixture();
    const midjourney: Record<string, unknown> = { operation: 'upscale', speed: 'fast', parent_task_id: 'owned-parent-task' };
    if (mismatch === 'operation') midjourney.operation = 'variation';
    if (mismatch === 'speed') midjourney.speed = 'turbo';
    if (mismatch === 'parent') midjourney.parent_task_id = 'foreign-parent';
    const fetch = vi.fn().mockResolvedValue(Response.json({ task_id: 'mismatched-result', status: 'success',
      model: mismatch === 'model' ? 'another-model' : state.route.upstreamModelId, ...resultAsset('mismatched'), midjourney }));
    vi.stubGlobal('fetch', fetch);
    const input: ImageOperationInput = { ...state.input, operation: 'upscale', parentClientRequestId: 'parent-request', actionId: 'action-upscale' }; delete input.prompt;
    expect(await submitWalletImageOperation(state.prisma, input)).toMatchObject({ status: 'uncertain', chargedCredits: '0.000000' });
    expect(fetch).toHaveBeenCalledOnce(); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.settlements).toEqual([]); expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
  });

  it.each([
    { name: 'canonical disabled overrides route true', canonical: { supportsReferenceImages: false }, route: { supportsReferenceImages: true }, count: 1 },
    { name: 'canonical singular alias disabled', canonical: { supportsReferenceImage: false }, route: {}, count: 1 },
    { name: 'route disabled overrides canonical true', canonical: { supportsReferenceImages: true }, route: { supportsReferenceImages: false }, count: 1 },
    { name: 'canonical maximum zero', canonical: { maxReferenceImages: 0 }, route: { maxReferenceImages: 5 }, count: 1 },
    { name: 'route maximum zero', canonical: { maxReferenceImages: 5 }, route: { maxReferenceImages: 0 }, count: 1 },
    { name: 'canonical smaller maximum', canonical: { maxReferenceImages: 2 }, route: { maxReferenceImages: 5 }, count: 3 },
    { name: 'route smaller maximum', canonical: { maxReferenceImages: 5 }, route: { maxReferenceImages: 2 }, count: 3 },
    { name: 'canonical minimum without references', canonical: { minReferenceImages: 1 }, route: {}, count: 0 },
    { name: 'route minimum with too few references', canonical: {}, route: { minReferenceImages: 2 }, count: 1 },
    { name: 'canonical aspect ratio', canonical: { supportedAspectRatios: ['16:9'] }, route: {}, count: 0, aspectRatio: '1:1' },
    { name: 'route aspect ratio alias', canonical: { supportedAspectRatios: ['1:1', '16:9'] }, route: { aspectRatios: ['16:9'] }, count: 0, aspectRatio: '1:1' },
  ])('rejects $name before reference download, reservation or POST', async test => {
    const state = fixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    state.model.capabilities = test.canonical;
    Object.assign(state.route, { capabilitiesOverride: test.route });
    const input: ImageOperationInput = { ...state.input, ...(test.count ? { inputImages: Array.from({ length: test.count }, () => 'https://references.example/image.png') } : {}),
      ...(test.aspectRatio ? { aspectRatio: test.aspectRatio } : {}) };
    await expect(submitWalletImageOperation(state.prisma, input)).rejects.toMatchObject({ code: 'invalid_image_operation' });
    expect(fetch).not.toHaveBeenCalled(); expect(state.tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(state.tx.aiRequest.create).not.toHaveBeenCalled(); expect(state.ledger).toEqual([]);
    expect(state.balances()).toEqual({ available: '100', reserved: '0', consumed: '0' });
  });

  it('allows ordinary imagine without references when reference support is disabled', async () => {
    const state = fixture(); state.model.capabilities = { supportsReferenceImages: false, maxReferenceImages: 0 };
    Object.assign(state.route, { capabilitiesOverride: { supportsReferenceImages: false, maxReferenceImages: 0 } });
    const fetch = vi.fn().mockResolvedValue(Response.json({ task_id: 'text-only-imagine', status: 'running' })); vi.stubGlobal('fetch', fetch);
    expect(await submitWalletImageOperation(state.prisma, state.input)).toMatchObject({ taskId: 'text-only-imagine', status: 'running' });
    expect(fetch).toHaveBeenCalledOnce(); expect(postedBody(fetch)).not.toHaveProperty('images');
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
  });

  it('does not refund a late rejected POST after a concurrent exact receipt lookup has accepted the task', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const state = fixture(); const postStarted = deferred<void>(); const postResponse = deferred<Response>();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { postStarted.resolve(undefined); return postResponse.promise; }
      return Response.json({ data: [{ client_request_id: record(state.rowFor().result).receiptKey, task_id: 'accepted-by-list', status: 'running' }] });
    }); vi.stubGlobal('fetch', fetch);
    const submitting = submitWalletImageOperation(state.prisma, state.input); await postStarted.promise;
    vi.setSystemTime(Date.now() + 6_000);
    expect(await getWalletImageOperation(state.prisma, 'owner', state.input.clientRequestId, { refresh: true })).toMatchObject({ taskId: 'accepted-by-list' });
    postResponse.resolve(Response.json({ error: { message: 'Late fixture rejection' } }, { status: 400 }));
    expect(await submitting).toMatchObject({ taskId: 'accepted-by-list', chargedCredits: '0.000000' });
    expect(record(state.rowFor().result)).toMatchObject({ taskId: 'accepted-by-list', imageOperationContext: { taskId: 'accepted-by-list' } });
    expect(state.rowFor().status).toBe('PROCESSING'); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']); expect(state.settlements).toEqual([]);
  });

  it('downloads and delivers all eleven distinct declared images before charging one operation', async () => {
    const state = fixture();
    const images = await Promise.all(Array.from({ length: 11 }, (_, index) => sharp({ create: { width: 2, height: 2, channels: 3,
      background: { r: index * 20, g: 40, b: 70 } } }).png().toBuffer()));
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: 'eleven-images', status: 'success', assets: images.map((_, index) => ({ url: `/assets/eleven-${index}.png` })) });
      const index = /\/assets\/eleven-(\d+)\.png$/.exec(String(url))?.[1];
      return new Response(new Uint8Array(index === undefined ? png : images[Number(index)]!), { headers: { 'content-type': 'image/png' } });
    }); vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, state.input);
    expect(result).toMatchObject({ status: 'success', chargedCredits: '2.000000' }); expect(result.images).toHaveLength(11);
    expect(fetch.mock.calls.filter(([url]) => /\/assets\/eleven-\d+\.png$/.test(String(url)))).toHaveLength(11);
    expect(state.ledger.map(row => row.type)).toEqual(['RESERVE', 'CHARGE']); expect(state.settlements).toHaveLength(1);
  });

  it.each(['seventeen', 'missing-url', 'malformed-assets', 'partial-download'] as const)('holds a %s image result without charging an incomplete delivery', async kind => {
    const state = fixture();
    const assets: unknown = kind === 'seventeen' ? Array.from({ length: 17 }, (_, index) => ({ url: `/assets/overflow-${index}.png` }))
      : kind === 'missing-url' ? [{ url: '/assets/valid.png' }, { width: 2, height: 2 }]
      : kind === 'malformed-assets' ? { url: '/assets/invalid-container.png' }
      : [{ url: '/assets/valid.png' }, { url: '/assets/missing.png' }];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: `incomplete-${kind}`, status: 'success', assets });
      return String(url).endsWith('/missing.png') ? Response.json({ error: 'Fixture missing asset' }, { status: 404 }) : imageResponse();
    }); vi.stubGlobal('fetch', fetch);
    const result = await submitWalletImageOperation(state.prisma, state.input);
    expect(result).toMatchObject({ status: 'uncertain', chargedCredits: '0.000000' });
    expect(state.rowFor().status).toBe('PROCESSING'); expect(state.ledger.map(row => row.type)).toEqual(['RESERVE']);
    expect(state.balances()).toEqual({ available: '98', reserved: '2', consumed: '0' }); expect(state.settlements).toEqual([]);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    if (kind !== 'partial-download') expect(fetch).toHaveBeenCalledOnce();
  });
});

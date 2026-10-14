import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import { recoverWalletImageGeneration } from '../src/modules/ai/image-service.js';
import { getImageResult } from '../src/modules/ai/image-result-store.js';
import { storageService } from '../src/modules/storage/service.js';

vi.mock('../src/lib/provider-secrets.js', () => ({ decryptProviderSecrets: () => ({ apiKey: 'fixture-secret', headers: {} }) }));
vi.mock('../src/modules/providers/url.js', async importOriginal => ({ ...await importOriginal<object>(), assertPublicProviderUrl: vi.fn() }));
let row: any;
let db: any;
let tx: any;
let available: Prisma.Decimal;
let reserved: Prisma.Decimal;
const receiptId = 'original-image-request';
const taskId = 'imgtask-accepted';
const stored: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(storageService, 'uploadMedia').mockResolvedValue('generated-images/fixture.png');
  vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue('https://storage.example/fixture.png');
  const provider = { id: 'channel', name: 'Fixture', kind: 'NEW_API', baseUrl: 'https://provider.example', encryptedSecrets: 'fixture' };
  const route = { id: 'route', canonicalModelId: 'model-id', channel: provider, adapterKey: 'GENERIC_OPENAI_IMAGE', upstreamModelId: 'vendor-future-v8',
    executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}' } };
  row = { id: 'db-request', userId: 'owner', clientRequestId: receiptId, status: 'PROCESSING', capability: 'IMAGE',
    routeId: 'route', route, canonicalModelId: 'model-id', estimatedCredits: new Prisma.Decimal(20), completedAt: null,
    pricingSnapshot: { schemaVersion: 1, canonicalModelId: 'model-id', canonicalModelKey: 'arbitrary-image', modality: 'image',
      routeId: 'route', priceVersionId: 'old-price', priceVersion: 1, billingType: 'image_resolution',
      pricing: { billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '20' } },
      request: { count: 4, resolution: '2k', billingMode: 'per_request' }, capturedAt: '2026-10-14T17:00:00Z' },
    result: { kind: 'image_task_submission', tasks: [{ taskId, profile: 'GENERIC_TASK', clientRequestId: receiptId }],
      recovery: { version: 1, state: 'manual_confirmation_required', providerId: 'channel', stage: 'status', reason: 'task_identity_mismatch',
        identity: { taskId, statusUrl: `https://provider.example/v1/images/tasks/${taskId}`, resultUrl: '' } } } };
  available = new Prisma.Decimal(80); reserved = new Prisma.Decimal(20);
  tx = {
    aiRequest: { findUnique: vi.fn(async () => row), findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status);
        if (!matches) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }) },
    wallet: { update: vi.fn(async ({ data }: any) => {
      reserved = reserved.minus(data.reservedCredits.decrement);
      available = available.plus(data.availableCredits?.increment || 0);
      return { availableCredits: available };
    }) },
    walletLedger: { create: vi.fn(async () => ({})) }, aiBillingSettlement: { create: vi.fn(async () => ({})) },
  };
  db = { aiRequest: { ...tx.aiRequest, findUnique: vi.fn(async ({ where }: any) => where.userId_clientRequestId.userId === row.userId ? row : null) },
    $transaction: async (fn: (tx: any) => unknown) => fn(tx) };
});
afterEach(async () => {
  for (const source of stored.splice(0)) {
    const image = await getImageResult(source.split('/').at(-1)!);
    if (image) await rm(image.path, { force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('resumes the accepted GET, delivers four distinct images and settles the old 20-credit price once', async () => {
  const images = await Promise.all(['#ff0000', '#00ff00', '#0000ff', '#ffffff'].map(async background => ({
    b64_json: (await sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toBuffer()).toString('base64'),
    url: 'https://cdn.example/redundant.png',
  })));
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    return new Response(JSON.stringify({ created: 1791998040, task_id: 'internal-renderer-id', data: images }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const [first, concurrent] = await Promise.all([
    recoverWalletImageGeneration(db, 'owner', receiptId), recoverWalletImageGeneration(db, 'owner', receiptId),
  ]);
  stored.push(...(first?.images || []));
  expect(first).toMatchObject({ status: 'succeeded', chargedCredits: '20.000000' });
  expect(first?.images).toHaveLength(4);
  expect(concurrent).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain(taskId);
  expect(reserved.toString()).toBe('0'); expect(available.toString()).toBe('80');
  expect(tx.walletLedger.create.mock.calls.map(([entry]: any) => entry.data.type)).toEqual(['CHARGE']);
  expect(await recoverWalletImageGeneration(db, 'owner', receiptId)).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(tx.wallet.update).toHaveBeenCalledTimes(1);
});
it('never queries a task owned by another user', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await expect(recoverWalletImageGeneration(db, 'other-user', receiptId)).rejects.toMatchObject({ code: 'image_request_not_found' });
  expect(fetch).not.toHaveBeenCalled(); expect(tx.wallet.update).not.toHaveBeenCalled();
});
it('does not change channels or invent a tariff when the saved identity is incomplete', async () => {
  vi.stubGlobal('fetch', vi.fn());
  row.pricingSnapshot = null;
  await expect(recoverWalletImageGeneration(db, 'owner', receiptId)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
  expect(fetch).not.toHaveBeenCalled(); expect(reserved.toString()).toBe('20');
});
it('keeps the reserve on an explicit task mismatch rather than acquiring or submitting another task', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ task_id: 'different-task', status: 'success', data: [{ url: 'https://cdn.example/wrong.png' }] }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await expect(recoverWalletImageGeneration(db, 'owner', receiptId)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
  expect(row.result.recovery.reason).toBe('task_identity_mismatch');
  expect(fetch).toHaveBeenCalledTimes(1); expect(tx.wallet.update).not.toHaveBeenCalled();
  expect(reserved.toString()).toBe('20');
});
it('releases the existing reserve once only when the upstream explicitly confirms task failure', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ task_id: taskId, status: 'failed' }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  expect(await recoverWalletImageGeneration(db, 'owner', receiptId)).toMatchObject({ status: 'failed' });
  expect(available.toString()).toBe('100'); expect(reserved.toString()).toBe('0');
  expect(tx.walletLedger.create.mock.calls.map(([entry]: any) => entry.data.type)).toEqual(['RELEASE']);
  await expect(recoverWalletImageGeneration(db, 'owner', receiptId)).rejects.toMatchObject({ code: 'image_recovery_unavailable' });
  expect(fetch).toHaveBeenCalledTimes(1); expect(tx.wallet.update).toHaveBeenCalledTimes(1);
});

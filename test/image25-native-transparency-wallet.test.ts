import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { creditDecimal } from '../src/modules/wallets/credit-amount.js';

const persisted = vi.hoisted(() => ({ images: [] as Array<{ bytes: Uint8Array; mime: string }> }));

vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => true) }));
vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async (response: Response) => {
    persisted.images.push({
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime: response.headers.get('content-type') ?? '',
    });
    return `https://persisted.example/native-alpha-${persisted.images.length}.png`;
  }),
}));

import { executeWalletImageGeneration } from '../src/modules/ai/image-service.js';

const modelKey = 'gpt-image-2-5-sunburst';
const upstreamModel = 'gpt-image-2.5-sunburst';
const referencePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const reference = `data:image/png;base64,${referencePng}`;
const alphaPixels = Buffer.from([
  255, 0, 255, 0, 255, 0, 255, 255,
  20, 80, 120, 128, 30, 140, 60, 255,
]);

function fixture(generic: boolean) {
  const channel: AiProviderChannel = {
    id: 'alpha-channel', name: 'Native alpha fixture', kind: generic ? 'NEW_API' : 'USELG',
    status: 'ACTIVE', priority: 0, baseUrl: 'https://1.1.1.1', defaultModel: null,
    allowInsecureHttp: false, encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture', headers: {} }),
    apiKeyLast4: 'ture', capabilities: ['IMAGE'], lastTestStatus: null, lastTestMessage: null,
    lastTestModelCount: null, lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
  };
  const route = {
    id: 'alpha-route', canonicalModelId: 'alpha-model', provider: channel.kind, channelId: channel.id,
    upstreamModelId: upstreamModel, adapterKey: generic ? 'GENERIC_OPENAI_IMAGE' : 'LEGACY',
    adapterConfig: generic ? { referenceSerializer: 'json_images' } : null, executionMode: 'TASK',
    executionConfig: generic
      ? { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}' }
      : { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations' },
    enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', priority: 0,
    capabilitiesOverride: null, metadata: null, channel,
  };
  const model = {
    id: 'alpha-model', canonicalModelKey: modelKey, displayName: 'Image 2.5', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', routingMode: 'MANAGED', billingType: 'image_resolution',
    capabilities: {
      supportedResolutions: ['2k'], supportedAspectRatios: ['16:9'], supportsReferenceImages: true,
      supportsImageEdit: true, supportsTransparentBackground: true, supportedOutputFormats: ['png'],
      supportedQualities: ['max'], qualityParameter: 'quality',
      outputMode: 'single_asset', maxOutputImages: 1, billingMode: 'per_request',
    },
    defaultRouteId: route.id, routes: [route],
  };
  let row: Record<string, unknown> | null = null;
  let available = creditDecimal(100);
  let reserved = creditDecimal(0);
  const transaction = {
    aiRequest: {
      findUnique: vi.fn(async () => row), findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { id: 'alpha-wallet-request', ...data,
          estimatedCredits: creditDecimal(data.estimatedCredits as string), chargedCredits: creditDecimal(0) };
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
      update: vi.fn(async ({ data }: { data: {
        availableCredits?: { increment: unknown }; reservedCredits: { decrement: unknown };
      } }) => {
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
      id: 'alpha-price', version: 1, publishedAt: new Date(0), pricing: {
        billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '25' },
      },
    } })) },
    aiProviderChannel: { findMany: legacyProviders },
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
  } as unknown as PrismaClient;
  return { prisma, transaction, legacyProviders, getRow: () => row,
    balances: () => ({ available: available.toString(), reserved: reserved.toString() }) };
}

afterEach(() => {
  persisted.images.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Image 2.5 native transparency through real wallet dispatch', () => {
  it.each([
    { name: 'Legacy USELG TASK text generation JSON', generic: false, withReference: false, multipart: false },
    { name: 'Legacy USELG TASK native edit multipart', generic: false, withReference: true, multipart: true },
    { name: 'Generic TASK native edit JSON references', generic: true, withReference: true, multipart: false },
  ])('$name requests native alpha and settles the unchanged PNG once', async testCase => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = fixture(testCase.generic);
    const transparentPng = await sharp(alphaPixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    const requests: Array<{ url: string; method: string; contentType: string; bytes: Uint8Array }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ url: String(url), method,
        contentType: new Headers(init?.headers).get('content-type') ?? '',
        bytes: init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array(),
      });
      const payload = method === 'POST'
        ? { task_id: 'native-alpha-task', status: 'processing', poll_after_ms: 1 }
        : { task_id: 'native-alpha-task', status: 'success', data: [{ b64_json: transparentPng.toString('base64') }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(executeWalletImageGeneration(state.prisma, {
      userId: 'owner', clientRequestId: `native-alpha-${testCase.generic ? 'generic' : 'legacy'}-${testCase.withReference ? 'ref' : 'text'}`,
      model: modelKey, prompt: 'fixture subject with a transparent background',
      inputImages: testCase.withReference ? [reference] : [], aspectRatio: '16:9', resolution: '2k', quality: 'max',
      outputFormat: 'png', background: 'transparent', count: 1,
    })).resolves.toMatchObject({
      images: ['https://persisted.example/native-alpha-1.png'],
      imageAssets: [{ assetType: 'image', url: 'https://persisted.example/native-alpha-1.png' }],
      chargedCredits: '25.000000',
    });

    expect(requests.map(request => request.method)).toEqual(['POST', 'GET']);
    const posted = requests[0]!;
    expect(posted.url).toBe(`https://1.1.1.1/v1/images/${testCase.withReference ? 'edits' : 'generations'}`);
    expect(requests[1]!.url).toBe(testCase.generic
      ? 'https://1.1.1.1/tasks/native-alpha-task'
      : 'https://1.1.1.1/v1/images/tasks/native-alpha-task?view=summary');
    let prompt: string;
    if (testCase.multipart) {
      expect(posted.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const form = await new Response(new Uint8Array(posted.bytes), { headers: { 'content-type': posted.contentType } }).formData();
      expect(form.get('model')).toBe(upstreamModel);
      expect(form.get('background')).toBe('transparent');
      expect(form.get('output_format')).toBe('png');
      expect(form.get('async')).toBe('true');
      const image = form.get('image');
      expect(image).toBeInstanceOf(Blob);
      expect(Buffer.from(await (image as Blob).arrayBuffer())).toEqual(Buffer.from(referencePng, 'base64'));
      prompt = String(form.get('prompt'));
    } else {
      expect(posted.contentType).toContain('application/json');
      const body = JSON.parse(Buffer.from(posted.bytes).toString('utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({ model: upstreamModel, background: 'transparent', output_format: 'png' });
      if (testCase.withReference) expect(body.images).toEqual([reference]);
      else expect(body).not.toHaveProperty('image');
      prompt = String(body.prompt);
    }
    expect(prompt).toContain('fixture subject');
    expect(prompt).not.toMatch(/RGB\s*\(\s*255\s*,\s*0\s*,\s*255\s*\)|chroma.key|solid.*magenta|紫底/i);

    expect(persisted.images).toHaveLength(1);
    expect(persisted.images[0]!.mime).toBe('image/png');
    expect(Buffer.from(persisted.images[0]!.bytes)).toEqual(transparentPng);
    const delivered = await sharp(persisted.images[0]!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(delivered.info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect(delivered.data).toEqual(alphaPixels);
    expect([delivered.data[3], delivered.data[7], delivered.data[11], delivered.data[15]]).toEqual([0, 255, 128, 255]);
    expect(state.getRow()).toMatchObject({ status: 'SUCCEEDED', routeId: 'alpha-route', chargedCredits: creditDecimal(25) });
    expect(state.balances()).toEqual({ available: '75', reserved: '0' });
    expect(state.transaction.wallet.updateMany).toHaveBeenCalledOnce();
    expect(state.transaction.wallet.update).toHaveBeenCalledOnce();
    expect(state.transaction.aiBillingSettlement.create).toHaveBeenCalledOnce();
    expect(state.transaction.walletLedger.create.mock.calls.map(([entry]) => entry.data.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(state.legacyProviders).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith('[image_provider_failover]', expect.anything());
  });
});

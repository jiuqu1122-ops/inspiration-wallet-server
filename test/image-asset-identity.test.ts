import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectImageStrings, generatePreparedImageAdapterImages, summarizeUselgImageStatus,
  uniqueImages, uniqueImagesPreferUrls, executeWalletImageGeneration, getWalletImageGenerationByRequest,
} from '../src/modules/ai/image-service.js';
import { getImageModelAdapter, prepareImageAdapterRequest } from '../src/modules/ai/image-adapters/registry.js';

const capabilities = { outputMode: 'multiple_assets', maxOutputImages: 4, billingMode: 'per_request' };
const descriptors = Array.from({ length: 4 }, (_, index) => ({
  b64_json: Buffer.from(`distinct-fixture-image-${index}`).toString('base64'),
  url: `https://cdn.example/new-result-${index}.png`, output_format: 'png',
}));
const bytes = descriptors.map(asset => `data:image/png;base64,${asset.b64_json}`);
const urls = descriptors.map(asset => asset.url);

afterEach(() => { vi.restoreAllMocks(); });

describe('one image asset with alternate representations', () => {
  it('counts each OpenAI descriptor once before limiting results', () => {
    expect(uniqueImages({ data: descriptors }, [], 4)).toEqual(bytes);
    expect(uniqueImagesPreferUrls({ data: descriptors }, [], 4)).toEqual(urls);
    expect(collectImageStrings({ data: descriptors })).toEqual(bytes);
  });

  it('does not collect aliases again through a normalized envelope or its raw copy', () => {
    const payload = { status: 'success', task_id: 'accepted-task', data: descriptors };
    const envelope = { ...payload, raw: structuredClone(payload), assets: descriptors.map(asset => ({ url: asset.url })) };
    expect(uniqueImages(envelope, [], 4)).toEqual(bytes);
    expect(summarizeUselgImageStatus(envelope, [], 4).images).toEqual(urls);
    expect(payload.data).toEqual(descriptors);
  });

  it('keeps URL-only and inline-only models and inline MIME descriptors compatible', () => {
    expect(uniqueImages({ data: urls.map(url => ({ url })) }, [], 4)).toEqual(urls);
    expect(uniqueImages({ data: descriptors.map(({ b64_json }) => ({ b64_json })) }, [], 4)).toEqual(bytes);
    expect(uniqueImages({ data: [{ mime_type: 'image/png', data: descriptors[0]!.b64_json,
      signed_url: urls[0], download_url: 'https://cdn.example/download-0', url: 'https://cdn.example/alias-0' }] }, [], 4)).toEqual([bytes[0]]);
  });

  it.each([
    ['DIRECT', undefined, undefined],
    ['TASK', 'GENERIC_TASK', 'success'],
    ['TASK', 'GENERIC_TASK', undefined],
    ['TASK', 'USELG_IMAGE_TASK', 'success'],
    ['TASK', 'USELG_IMAGE_TASK', undefined],
  ] as const)('delivers four different assets in %s / %s / %s', async (executionMode, profile, state) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const input = {
      requestedCanonicalModel: 'ordinary-image', resolvedCanonicalModel: 'ordinary-image',
      canonicalModelId: 'model', canonicalModelKey: 'ordinary-image', routeId: 'route', channelId: 'channel',
      upstreamModel: 'vendor-future', prompt: 'new request', references: [], resolution: '2k',
      aspectRatio: '1:1', count: 1, outputFormat: 'png' as const, capabilities,
    };
    const prepared = prepareImageAdapterRequest(getImageModelAdapter('GENERIC_OPENAI_IMAGE'), input)!;
    const final = { ...(state ? { status: state } : {}), task_id: 'accepted-task', data: descriptors };
    const request = vi.fn(async (_path: string, body?: unknown) => executionMode === 'DIRECT' || body === undefined
      ? final
      : { task_id: 'accepted-task', status: 'processing', status_url: '/v1/images/tasks/accepted-task' });
    const images = await generatePreparedImageAdapterImages(
      { id: 'channel', name: 'Fixture', kind: profile === 'USELG_IMAGE_TASK' ? 'USELG' : 'NEW_API', baseUrl: 'https://provider.example' } as never,
      { apiKey: 'fixture-secret', headers: {} },
      { userId: 'owner', clientRequestId: 'fresh-request', model: input.upstreamModel, prompt: input.prompt,
        inputImages: [], aspectRatio: '1:1', outputFormat: 'png', count: 1, imageCapabilities: capabilities },
      prepared,
      { ...input, adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: {}, executionMode,
        ...(profile ? { executionConfig: { profile, submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}' } } : {}) } as never,
      { request, wait: async () => {} },
    );
    expect(images).toHaveLength(4);
    expect(new Set(images)).toHaveLength(4);
    // Each representation maps to its one fixture asset, not four candidates
    // containing the URL and bytes of only the first two assets.
    expect(images.map(image => bytes.indexOf(image) >= 0 ? bytes.indexOf(image) : urls.indexOf(image))).toEqual([0, 1, 2, 3]);
    expect(request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(executionMode === 'DIRECT' ? 1 : 2);
    if (executionMode !== 'DIRECT') expect(request.mock.calls[1]![0]).toContain('/v1/images/tasks/accepted-task');
  });
});

it('replays only the completed receipt owned by this user and exact client request ID', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch');
  const resultFor = (name: string) => ({ images: [`https://cdn.example/${name}.png`], provider: 'NEW_API',
    providerChannelId: 'channel', providerChannelName: 'Fixture', model: 'ordinary-image', chargedCredits: '20' });
  const rows = new Map([
    ['owner:old-request', resultFor('old')],
    ['owner:fresh-request', resultFor('fresh')],
    ['another-owner:fresh-request', resultFor('another-owner')],
  ]);
  const findUnique = vi.fn(async ({ where }: { where: { userId_clientRequestId: { userId: string; clientRequestId: string } } }) => {
    const key = where.userId_clientRequestId;
    const result = rows.get(`${key.userId}:${key.clientRequestId}`);
    return result ? { capability: 'IMAGE', status: 'SUCCEEDED', completedAt: new Date(), result } : null;
  });
  const transaction = vi.fn();
  const prisma = { aiRequest: { findUnique }, $transaction: transaction };
  const input = { userId: 'owner', clientRequestId: 'fresh-request', model: 'ordinary-image', prompt: 'fresh request',
    inputImages: [], aspectRatio: '1:1', outputFormat: 'png' as const, count: 1 };
  expect(await executeWalletImageGeneration(prisma as never, input)).toEqual(resultFor('fresh'));
  expect(await executeWalletImageGeneration(prisma as never, { ...input, clientRequestId: 'old-request' })).toEqual(resultFor('old'));
  expect(await getWalletImageGenerationByRequest(prisma as never, 'another-owner', 'fresh-request')).toMatchObject(resultFor('another-owner'));
  expect(await getWalletImageGenerationByRequest(prisma as never, 'unrelated-owner', 'fresh-request')).toBeNull();
  expect(findUnique.mock.calls.map(call => call[0].where.userId_clientRequestId)).toEqual([
    { userId: 'owner', clientRequestId: 'fresh-request' }, { userId: 'owner', clientRequestId: 'old-request' },
    { userId: 'another-owner', clientRequestId: 'fresh-request' }, { userId: 'unrelated-owner', clientRequestId: 'fresh-request' },
  ]);
  expect(transaction).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

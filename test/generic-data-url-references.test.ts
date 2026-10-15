import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
const storage = vi.hoisted(() => ({
  tryResolveObjectKeyFromUrl: vi.fn(), getObjectStream: vi.fn(), headObject: vi.fn(), getDownloadUrl: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
vi.mock('../src/modules/storage/service.js', () => ({ storageService: storage }));

import { prepareRouteImageAdapterRequest, generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';
import { imageAdapterConfig } from '../src/modules/ai/image-adapters/types.js';
import { prepareGenericImageDataUrlReference, prepareSeedreamReference } from '../src/modules/ai/seedream-references.js';
import { createProviderReference, removeProviderReference } from '../src/modules/ai/provider-reference-store.js';
import { resolveReferenceImageSources } from '../src/modules/ai/reference-upload-service.js';
import { updateAdminAiRoute } from '../src/modules/ai/model-admin.js';

const model = 'arbitrary-upstream-model';
const provider = { id: 'fixture-provider', name: 'Fixture', kind: 'NEW_API', baseUrl: 'https://relay.example' } as never;
const cosUrl = 'https://bucket.cos.ap-singapore.myqcloud.com/reference-images/input.png?q-signature=fixture-private';
const config = { referenceSerializer: 'object_image_url', referenceTransport: 'data_url',
  referenceRequestCount: 1, referenceResponseFormat: 'b64_json', resolutionParameter: 'size',
  resolutionValueMode: 'exact', exactDimensions: { '1K': { '16:9': '1280x720' } } };
const route = (adapterConfig: Record<string, unknown> = config) => ({
  adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig,
  requestedCanonicalModel: 'canonical-fixture', resolvedCanonicalModel: 'canonical-fixture', canonicalModelId: 'model',
  canonicalModelKey: 'canonical-fixture', routeId: 'route', channelId: 'fixture-provider', upstreamModel: model,
  executionMode: 'TASK', executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
    statusEndpointTemplate: '/tasks/{taskId}', asyncParameterName: 'async', asyncParameterValue: true },
});
const input = (inputImages: string[]) => ({ userId: 'owner', clientRequestId: 'generic-data-url-receipt', model,
  prompt: 'retain the existing prompt contract', inputImages, aspectRatio: '16:9', resolution: '1k',
  outputFormat: 'jpg' as const, count: 1,
  imageCapabilities: { supportsImageEdit: true, outputMode: 'multiple_assets', maxOutputImages: 4 } });
let png: Buffer;
let jpeg: Buffer;
let webp: Buffer;
let gif: Buffer;
const cachedReferences: string[] = [];
const dataUrl = (bytes = png, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const imageResponse = (bytes = png, mime = 'image/png') => new Response(new Uint8Array(bytes), {
  headers: { 'content-type': mime, 'content-length': String(bytes.length) },
});

beforeAll(async () => {
  const image = () => sharp({ create: { width: 3, height: 2, channels: 3, background: '#347863' } });
  [png, jpeg, webp, gif] = await Promise.all([image().png().toBuffer(), image().jpeg().toBuffer(),
    image().webp().toBuffer(), image().gif().toBuffer()]);
});
beforeEach(() => {
  dns.lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  storage.tryResolveObjectKeyFromUrl.mockReset().mockReturnValue(null);
  storage.getObjectStream.mockReset().mockImplementation(async () => ({
    statusCode: 200, stream: Readable.from([png]), headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
  }));
  storage.headObject.mockReset().mockResolvedValue({ contentLength: png.length, contentType: 'image/png' });
  storage.getDownloadUrl.mockReset().mockReturnValue(cosUrl);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const url of cachedReferences.splice(0)) await removeProviderReference(url);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('explicit Generic Data URL routes through preparation and actual HTTP serialization', () => {
  it.each([1, 2, 5])('reads %i safe references and submits one JSON edit POST, then delivers four task images', async referenceCount => {
    const outputs = await Promise.all(['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map(background =>
      sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toBuffer()));
    const fetch = vi.fn(async (url: string | URL, request?: RequestInit) => {
      if (String(url) === cosUrl) return imageResponse();
      if (request?.method === 'POST') return Response.json({ task_id: 'accepted-receipt', status: 'queued' });
      return Response.json({ task_id: 'accepted-receipt', status: 'success',
        data: outputs.map(bytes => ({ b64_json: bytes.toString('base64') })) });
    });
    vi.stubGlobal('fetch', fetch);
    const sources = Array.from({ length: referenceCount }, (_, index) => index === 0 ? cosUrl
      : index % 2 ? dataUrl(jpeg, 'image/jpeg') : dataUrl());
    const prepared = await prepareRouteImageAdapterRequest(provider, input(sources), route());
    const result = await generatePreparedImageAdapterImages(provider, { apiKey: 'test-only', headers: {} },
      input(sources), prepared!, route(), { wait: async () => {} });
    expect(result).toHaveLength(4);
    expect(new Set(result).size).toBe(4);
    const postCalls = fetch.mock.calls.filter(([, request]) => request?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(String(postCalls[0]![0])).toBe('https://relay.example/v1/images/edits');
    const body = JSON.parse(postCalls[0]![1]!.body as string);
    expect(body).toEqual({ model, prompt: `${input([]).prompt}\n\nStrict image constraints: must output exactly 16:9 aspect ratio, target resolution 1k.`,
      size: '1280x720', n: 1, response_format: 'b64_json', async: true,
      images: sources.map((source, index) => ({ image_url: index === 0 ? dataUrl() : source })) });
    expect(JSON.stringify(body)).not.toContain(cosUrl);
    expect(fetch.mock.calls.filter(([url]) => String(url) === cosUrl)).toHaveLength(1);
    expect(fetch.mock.calls.some(([url, request]) => String(url) === 'https://relay.example/tasks/accepted-receipt'
      && request?.method === 'GET')).toBe(true);
  });

  it('authorizes uploaded object keys and reads the COS SDK instead of fetching its URL', async () => {
    const key = 'reference-images/upload.png';
    const prisma = { referenceUpload: { findFirst: vi.fn().mockResolvedValue({ id: 'ticket', sizeBytes: png.length,
      contentType: 'image/png', status: 'UPLOADED' }), update: vi.fn() } };
    storage.tryResolveObjectKeyFromUrl.mockImplementation((url: string) => url === cosUrl ? key : null);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const sources = await resolveReferenceImageSources(prisma as never, 'owner', [key]);
    const prepared = await prepareRouteImageAdapterRequest(provider, input(sources), route());
    expect(prisma.referenceUpload.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'owner', objectKey: key }),
    }));
    expect(storage.getObjectStream).toHaveBeenCalledWith(key);
    expect(prepared!.body.images).toEqual([{ image_url: dataUrl() }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers known cached reference bytes without DNS or remote reads', async () => {
    const cached = await createProviderReference(png, 'image/png'); cachedReferences.push(cached);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([cached]), route());
    expect(prepared!.body.images).toEqual([{ image_url: dataUrl() }]);
    expect(fetch).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it.each(['unconfigured', 'public_https'])('preserves the original URL contract when %s', async transport => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const adapterConfig = { referenceSerializer: 'object_image_url', ...(transport === 'public_https' ? { referenceTransport: transport } : {}) };
    const prepared = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), route(adapterConfig));
    expect(prepared!.body.images).toEqual([{ image_url: cosUrl }]);
    expect(prepared!.body).not.toHaveProperty('n'); expect(prepared!.body).not.toHaveProperty('response_format');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the entire successful no-reference body unchanged despite the opt-in fields', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { referenceTransport: _transport, referenceRequestCount: _count, referenceResponseFormat: _format, ...oldConfig } = config;
    for (const count of [1, 4]) {
      const without = await prepareRouteImageAdapterRequest(provider, { ...input([]), count }, route(oldConfig));
      const withOptIn = await prepareRouteImageAdapterRequest(provider, { ...input([]), count }, route());
      expect(withOptIn).toEqual(without);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the established endpoint selection when native editing is disabled', async () => {
    const prepared = await prepareRouteImageAdapterRequest(provider, {
      ...input([dataUrl()]), imageCapabilities: { supportsImageEdit: false, outputMode: 'multiple_assets', maxOutputImages: 4 },
    }, route());
    expect(prepared!.endpoint).toBe('/v1/images/generations');
    expect(prepared!.body.images).toEqual([{ image_url: dataUrl() }]);
  });

  it.each(['url', 'b64_json'])('only sends the explicit reference response format %s', async responseFormat => {
    const prepared = await prepareRouteImageAdapterRequest(provider, input([dataUrl()]),
      route({ referenceSerializer: 'object_image_url', referenceResponseFormat: responseFormat }));
    expect(prepared!.body.response_format).toBe(responseFormat);
    expect(prepared!.body).not.toHaveProperty('n');
  });

  it('does not let cached prepared HTTPS references bypass materialization or the five-image bound', async () => {
    const fetch = vi.fn().mockImplementation(async () => imageResponse()); vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route(), [cosUrl]);
    expect(prepared!.body.images).toEqual([{ image_url: dataUrl() }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route(), Array(6).fill(cosUrl)))
      .rejects.toThrow(/5/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects incompatible fixed-count requests and excess references before any GET or POST', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareRouteImageAdapterRequest(provider, { ...input([cosUrl]), count: 2 }, route())).rejects.toThrow(/数量设为 1/);
    await expect(prepareRouteImageAdapterRequest(provider, input(Array(6).fill(cosUrl)), route())).rejects.toThrow(/5/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an independent custom TASK submit endpoint and never adds a paid retry', async () => {
    const requestRoute = { ...route(), executionConfig: { ...route().executionConfig, submitEndpoint: '/independent/tasks' } };
    const prepared = await prepareRouteImageAdapterRequest(provider, input([dataUrl()]), requestRoute);
    const request = vi.fn().mockResolvedValue({ task_id: 'accepted', status: 'success', data: [{ url: 'https://cdn.example/output.png' }] });
    await generatePreparedImageAdapterImages(provider, { apiKey: 'test-only', headers: {} }, input([dataUrl()]), prepared!, requestRoute, { request });
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]![0]).toBe('/independent/tasks');
    request.mockReset().mockRejectedValue(new Error('submission outcome unknown'));
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'test-only', headers: {} },
      input([dataUrl()]), prepared!, requestRoute, { request })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('scoped PNG/JPEG Data URL validation without changing the default reader', () => {
  it('preserves original PNG/JPEG bytes and converts WebP to a verified PNG', async () => {
    for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg']] as const) {
      expect(await prepareGenericImageDataUrlReference(dataUrl(bytes, mime))).toEqual({ value: dataUrl(bytes, mime), mime, sizeBytes: bytes.length });
    }
    const converted = await prepareGenericImageDataUrlReference(dataUrl(webp, 'image/webp'));
    expect(converted.mime).toBe('image/png'); expect(converted.value).toMatch(/^data:image\/png;base64,/);
    expect((await sharp(Buffer.from(converted.value.split(',')[1]!, 'base64')).metadata()).format).toBe('png');
    await expect(prepareGenericImageDataUrlReference(dataUrl(gif, 'image/gif'))).rejects.toThrow(/PNG\/JPEG/);
    expect((await prepareSeedreamReference(dataUrl(webp, 'image/webp'), 'data_url')).mime).toBe('image/webp');
    expect((await prepareSeedreamReference(dataUrl(gif, 'image/gif'), 'data_url')).mime).toBe('image/gif');
  });

  it('allows a known cached 11 MiB PNG only on the new 20 MiB path', async () => {
    const large = Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]);
    const cached = await createProviderReference(large, 'image/png'); cachedReferences.push(cached);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await prepareGenericImageDataUrlReference(cached);
    expect(result.sizeBytes).toBe(large.length);
    await expect(prepareSeedreamReference(cached, 'data_url')).rejects.toThrow(/10 MiB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized cached prepared reference before submission', async () => {
    const cached = await createProviderReference(Buffer.alloc(20 * 1024 * 1024 + 1), 'image/png');
    cachedReferences.push(cached);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route(), [cached])).rejects.toThrow(/20 MiB/);
    expect(fetch).not.toHaveBeenCalled(); expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('checks both declared and streaming byte limits at 20 MiB', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('oversized', { headers: { 'content-length': String(20 * 1024 * 1024 + 1) } }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareGenericImageDataUrlReference('https://cdn.example/a.png')).rejects.toThrow(/20 MiB/);
    fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    } })));
    await expect(prepareGenericImageDataUrlReference('https://cdn.example/a.png')).rejects.toThrow(/20 MiB/);
  });

  it('checks converted PNG size before accepting the inline result', async () => {
    vi.spyOn(sharp.prototype, 'png').mockReturnValue({ toBuffer: async () => Buffer.alloc(20 * 1024 * 1024 + 1) } as never);
    await expect(prepareGenericImageDataUrlReference(dataUrl(webp, 'image/webp'))).rejects.toThrow(/20 MiB/);
  });

  it.each(['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'http://public.example/a.png', 'E:/private/user.png'])
    ('rejects unsafe or local sources before any transport: %s', async source => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      await expect(prepareGenericImageDataUrlReference(source)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled(); expect(storage.getObjectStream).not.toHaveBeenCalled();
    });

  it('pins validated DNS and revalidates redirects without forwarding credentials', async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'https://cdn2.example/b.png' } }))
      .mockImplementationOnce(async () => imageResponse());
    vi.stubGlobal('fetch', fetch);
    await expect(prepareGenericImageDataUrlReference('https://cdn.example/a.png')).resolves.toMatchObject({ value: dataUrl() });
    expect(dns.lookup.mock.calls.map(call => call[0])).toEqual(['cdn.example', 'cdn2.example']);
    for (const [, request] of fetch.mock.calls) {
      expect(request).toMatchObject({ method: 'GET', redirect: 'manual', dispatcher: expect.anything() });
      expect(new Headers(request.headers).has('authorization')).toBe(false);
    }
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }));
    await expect(prepareGenericImageDataUrlReference('https://cdn.example/a.png')).rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects private DNS results, corrupt image bytes and MIME spoofing', async () => {
    const fetch = vi.fn().mockImplementation(async () => imageResponse()); vi.stubGlobal('fetch', fetch);
    dns.lookup.mockResolvedValue([{ address: '192.168.1.2', family: 4 }]);
    await expect(prepareGenericImageDataUrlReference('https://cdn.example/a.png')).rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(prepareGenericImageDataUrlReference(dataUrl(png.subarray(0, 30)))).rejects.toThrow(/invalid|unsupported/);
    await expect(prepareGenericImageDataUrlReference(dataUrl(png, 'image/jpeg'))).rejects.toThrow(/MIME/);
  });

  it('bounds preparation time without starting any generation request', async () => {
    vi.useFakeTimers(); dns.lookup.mockImplementation(() => new Promise(() => {}));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = expect(prepareRouteImageAdapterRequest(provider, input([cosUrl]), route()))
      .rejects.toMatchObject({ code: 'reference_image_timeout', statusCode: 504 });
    await vi.advanceTimersByTimeAsync(30_000); await result;
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reference-only configuration validation and persistence', () => {
  it.each([{ referenceRequestCount: 2 }, { referenceRequestCount: '1' }, { referenceResponseFormat: 'png' },
    { referenceResponseFormat: true }, { unknownReferenceOption: true }])('rejects invalid config %j', value => {
    expect(() => imageAdapterConfig(value)).toThrow();
  });

  it('persists validated route options and rejects unknown fields before updating the route', async () => {
    const current = { id: 'route', updatedAt: new Date(0), canonicalModel: { modality: 'image' },
      adapterKey: 'GENERIC_OPENAI_IMAGE', costProfile: null };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = { aiModelRoute: { findUnique: vi.fn().mockResolvedValue(current), updateMany,
      findUniqueOrThrow: vi.fn().mockResolvedValue(current) } };
    const prisma = { $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction) };
    await updateAdminAiRoute(prisma as never, 'route', { adapterConfig: config as Prisma.InputJsonValue });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { adapterConfig: config } }));
    updateMany.mockClear();
    await expect(updateAdminAiRoute(prisma as never, 'route', { adapterConfig: { ...config, unknownReferenceOption: true } as Prisma.InputJsonValue })).rejects.toThrow(/Unsupported/);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

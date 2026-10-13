import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import sharp from 'sharp';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
const storage = vi.hoisted(() => ({
  tryResolveObjectKeyFromUrl: vi.fn(), getObjectStream: vi.fn(), headObject: vi.fn(), getDownloadUrl: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
vi.mock('../src/modules/storage/service.js', () => ({ storageService: storage }));

import { aiRoutes } from '../src/modules/ai/routes.js';
import { prepareRouteImageAdapterRequest, generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';
import { imageAdapterConfig } from '../src/modules/ai/image-adapters/types.js';
import { prepareSeedreamReference, referenceSourceType } from '../src/modules/ai/seedream-references.js';
import { resolveReferenceImageSources } from '../src/modules/ai/reference-upload-service.js';
import {
  createProviderReference, getProviderReference, providerReferenceKey, removeProviderReference, PROVIDER_REFERENCE_TTL_MS,
} from '../src/modules/ai/provider-reference-store.js';

const model = 'seedream-5.0-pro';
const prompt = 'private fixture prompt';
const constrainedPrompt = `${prompt}\n\nStrict image constraints: must output exactly 1:1 aspect ratio, target resolution 2k.`;
const cosUrl = 'https://bucket.cos.ap-singapore.myqcloud.com/reference-images/upload.png?q-signature=private-signature';
const input = (sources: string[]) => ({
  userId: 'fixture-user', clientRequestId: 'reference-request', model, prompt,
  inputImages: sources, aspectRatio: '1:1', resolution: '2k', outputFormat: 'png' as const, count: 1,
});
const provider = { id: 'fixture-provider', name: 'Seedream', kind: 'NEW_API', baseUrl: 'https://provider.example' } as never;
const route = (config: Record<string, unknown> = {}, adapterKey = 'SEEDREAM_IMAGES_API') => ({
  adapterKey, adapterConfig: { referenceSerializer: 'json_images', referenceTransport: 'data_url', ...config },
  requestedCanonicalModel: model, resolvedCanonicalModel: model, canonicalModelId: 'seedream-canonical',
  canonicalModelKey: model, routeId: 'seedream-route', channelId: 'fixture-provider', upstreamModel: model,
});
let png: Buffer;
const createdUrls: string[] = [];
const pngResponse = (mime = 'image/png') => new Response(png, {
  headers: { 'content-type': mime, 'content-length': String(png.length) },
});
const dataUrl = () => `data:image/png;base64,${png.toString('base64')}`;

beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
});
beforeEach(() => {
  dns.lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  storage.tryResolveObjectKeyFromUrl.mockReset().mockReturnValue(null);
  storage.getObjectStream.mockReset().mockImplementation(async () => ({
    statusCode: 200, stream: Readable.from([png]),
    headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
  }));
  storage.headObject.mockReset().mockResolvedValue({ contentLength: png.length, contentType: 'image/png' });
  storage.getDownloadUrl.mockReset().mockReturnValue(cosUrl);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const url of createdUrls.splice(0)) await removeProviderReference(url);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('Seedream reference preparation and edit serialization', () => {
  it('reads a public COS image and submits verified bytes instead of the original URL', async () => {
    const fetch = vi.fn().mockImplementation(async () => pngResponse());
    vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), route());
    expect(prepared).toMatchObject({ adapterKey: 'SEEDREAM_IMAGES_API', endpoint: '/v1/images/edits', body: { model, images: [dataUrl()] } });
    expect(dns.lookup).toHaveBeenCalledWith('bucket.cos.ap-singapore.myqcloud.com', { all: true, verbatim: true });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(JSON.stringify(prepared!.body)).not.toContain(cosUrl);
    // Dispatch uses the converted payload without retrying a paid POST.
    const request = vi.fn().mockResolvedValue({ data: [{ b64_json: png.toString('base64') }] });
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-secret', headers: {} }, input([cosUrl]), prepared!, {
      ...route(), executionMode: 'DIRECT',
    }, { request })).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/v1/images/edits');
    expect(request.mock.calls[0][1]).toMatchObject({ images: [dataUrl()] });
  });

  it('resolves a local client upload under its ownership ticket and reads through the Storage SDK', async () => {
    const key = 'reference-images/upload.png';
    const prisma = { referenceUpload: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ticket', sizeBytes: png.length, contentType: 'image/png', status: 'UPLOADED' }),
      update: vi.fn(),
    } };
    storage.tryResolveObjectKeyFromUrl.mockImplementation((url: string) => url === cosUrl ? key : null);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const sources = await resolveReferenceImageSources(prisma as never, 'fixture-user', [key]);
    const prepared = await prepareRouteImageAdapterRequest(provider, { ...input(sources), referenceSourceTypes: [referenceSourceType(key)] }, route());
    expect(prepared!.body.images).toEqual([dataUrl()]);
    expect(prisma.referenceUpload.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'fixture-user', objectKey: key }) }));
    expect(storage.getObjectStream).toHaveBeenCalledWith(key);
    expect(fetch).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[image_adapter_reference_prepared]', expect.objectContaining({ referenceSourceType: 'local' }));
  });

  it('accepts a validated local image Data URL without downloading it', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route());
    expect(prepared!.body.images).toEqual([dataUrl()]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['png', 'jpeg', 'webp', 'gif'] as const)('validates and preserves %s reference bytes', async format => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).toFormat(format).toBuffer();
    const source = `data:image/${format};base64,${bytes.toString('base64')}`;
    await expect(prepareSeedreamReference(source, 'data_url')).resolves.toEqual({ value: source, mime: `image/${format}`, sizeBytes: bytes.length });
  });

  it.each(['json_image', 'json_images', 'object_image_url'])('builds the explicitly configured %s edit format', async serializer => {
    const prepared = await prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route({ referenceSerializer: serializer }));
    expect(prepared!.endpoint).toBe('/v1/images/edits');
    expect(prepared!.body).toEqual({ model, prompt: constrainedPrompt, ...(serializer === 'json_image'
      ? { image: dataUrl() } : { images: serializer === 'json_images' ? [dataUrl()] : [{ image_url: dataUrl() }] }) });
  });

  it('supports existing Generic Seedream routes without changing their adapter or model mapping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => pngResponse()));
    const prepared = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), route({}, 'GENERIC_OPENAI_IMAGE'));
    expect(prepared).toMatchObject({ adapterKey: 'GENERIC_OPENAI_IMAGE', submittedModel: model, body: { model, images: [dataUrl()] } });
  });

  it('submits Generic Seedream TASK edits to the prepared edit endpoint instead of the configured generation endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => pngResponse()));
    const selectedRoute = { ...route({}, 'GENERIC_OPENAI_IMAGE'), executionMode: 'TASK', executionConfig: {
      profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
      statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary',
    } };
    const prepared = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), selectedRoute);
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/images/edits') return { task_id: 'edit-task' };
      if (path.includes('/v1/images/tasks/edit-task')) {
        return { data: { id: 'edit-task', status: 'success', assets: [{ url: dataUrl() }] } };
      }
      throw new Error(`Unexpected fixture endpoint: ${path}`);
    });
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-secret', headers: {} }, input([cosUrl]), prepared!, selectedRoute, {
      request, wait: async () => undefined,
    })).resolves.toHaveLength(1);
    expect(request.mock.calls[0][0]).toBe('/v1/images/edits');
    expect(request).toHaveBeenNthCalledWith(1, '/v1/images/edits', expect.objectContaining({ model, images: [dataUrl()], async: true }),
      expect.any(Number), undefined, undefined, expect.any(Object));
    expect(request.mock.calls.filter(call => call[0] === '/v1/images/edits')).toHaveLength(1);
    expect(request.mock.calls.some(call => call[0].includes('/v1/images/generations'))).toBe(false);
  });

  it('reuses converted references between preflight and dispatch without reading expired signed URLs again', async () => {
    const fetch = vi.fn().mockImplementation(async () => pngResponse()); vi.stubGlobal('fetch', fetch);
    const selectedRoute = route({ referenceSerializer: 'object_image_url' });
    const first = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), selectedRoute);
    const dispatch = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), selectedRoute, first!.preparedReferences);
    expect(dispatch!.body).toEqual(first!.body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps text-to-image payload, size mapping and TASK configuration unchanged', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const selectedRoute = { ...route({ resolutionParameter: 'size', resolutionValueMode: 'exact', exactDimensions: { '2K': { '1:1': '2048x2048' } }, async: true }),
      executionMode: 'TASK', executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary' },
    };
    const before = JSON.stringify(selectedRoute);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([]), selectedRoute);
    expect(prepared!.body).toEqual({ model, prompt: constrainedPrompt, size: '2048x2048', async: true });
    expect(prepared!.endpoint).toBe('/v1/images/generations');
    expect(JSON.stringify(selectedRoute)).toBe(before);
    expect(fetch).not.toHaveBeenCalled(); expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it('does not change reference serialization for an unrelated Generic model', async () => {
    const other = 'grok-imagine-image';
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const selectedRoute = { ...route({}, 'GENERIC_OPENAI_IMAGE'), requestedCanonicalModel: other, resolvedCanonicalModel: other, upstreamModel: other };
    const prepared = await prepareRouteImageAdapterRequest(provider, { ...input([cosUrl]), model: other }, selectedRoute);
    expect(prepared!.body.images).toEqual([cosUrl]); expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing/unsupported serializers before reading a reference', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareRouteImageAdapterRequest(provider, input([cosUrl]), route({ referenceSerializer: undefined })))
      .rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_EDIT_UNSUPPORTED' });
    expect(() => imageAdapterConfig({ referenceTransport: 'private_url' })).toThrow();
    expect(() => imageAdapterConfig({ referenceSerializer: 'object_url' })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('logs source types and validated metadata without URLs, signatures, prompt, bytes or paths', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => pngResponse()));
    await prepareRouteImageAdapterRequest(provider, input([cosUrl]), route());
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const value of [cosUrl, 'private-signature', prompt, png.toString('base64'), 'reference-images/']) expect(logs).not.toContain(value);
    expect(logs).toContain('"referenceSourceType":"cos"');
    expect(referenceSourceType('https://cdn.example/a.png?X-Amz-Signature=hidden')).toBe('signed_url');
    expect(referenceSourceType('https://cdn.example/a.png')).toBe('public_url');
  });
});

describe('Seedream reference SSRF and image validation', () => {
  it.each([
    'https://192.168.1.1/a.png', 'https://10.0.0.1/a.png', 'https://172.16.1.1/a.png', 'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data', 'https://localhost/a.png', 'https://host.local/a.png',
    'https://[::1]/a.png', 'https://[fc00::1]/a.png', 'https://[fe80::1]/a.png', 'https://[::ffff:192.168.1.1]/a.png',
    'http://public.example/a.png', 'file:///C:/private/image.png', 'https://user:secret@public.example/a.png',
  ])('rejects forbidden reference %s without any network request', async url => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference(url, 'data_url')).rejects.toMatchObject({ code: expect.stringMatching(/reference/) });
    expect(fetch).not.toHaveBeenCalled(); expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('rejects DNS with any private answer, including mixed public/private answers', async () => {
    dns.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a redirect whose hostname resolves to cloud metadata without fetching the target', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://redirect.example/a.png' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['https://10.0.0.1/a.png', 'http://public.example/a.png', 'https://metadata.google.internal/a'])('rejects redirect to %s', async target => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: target } })); vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates DNS again for public redirects and accepts valid redirected image bytes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn2.example/a.png' } }))
      .mockImplementation(async () => pngResponse()); vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).resolves.toMatchObject({ value: dataUrl() });
    expect(dns.lookup.mock.calls.map(call => call[0])).toEqual(['cdn.example', 'cdn2.example']);
  });

  it('rejects an invalid image URL returning HTML, even when its MIME says image/png', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login required</html>', { headers: { 'content-type': 'image/png' } })));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/invalid|unsupported/);
  });

  it('rejects wrong MIME, truncated images, oversized images and HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => pngResponse('text/html')));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/MIME/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png.subarray(0, 30), { headers: { 'content-type': 'image/png' } })));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/invalid|unsupported/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oversized', { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } })));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/10 MiB/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/404/);
  });

  it('enforces the byte limit even without a Content-Length header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); },
    }))));
    await expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url')).rejects.toThrow(/10 MiB/);
  });

  it('bounds DNS/preparation time without retrying the reference or submitting a task', async () => {
    vi.useFakeTimers(); dns.lookup.mockImplementation(() => new Promise(() => {}));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = expect(prepareSeedreamReference('https://cdn.example/a.png', 'data_url'))
      .rejects.toMatchObject({ code: 'reference_image_timeout', statusCode: 504 });
    await vi.advanceTimersByTimeAsync(30_000); await result;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects corrupt inline base64, MIME spoofing and arbitrary user filesystem paths', async () => {
    await expect(prepareSeedreamReference('data:image/png;base64,AAAA=garbage', 'data_url')).rejects.toThrow();
    await expect(prepareSeedreamReference(dataUrl().replace('image/png', 'image/jpeg'), 'data_url')).rejects.toThrow(/MIME/);
    await expect(prepareSeedreamReference('E:\\user-private\\reference.png', 'data_url')).rejects.toThrow();
  });

  it('removes URL/path details from DNS and download errors', async () => {
    dns.lookup.mockRejectedValue(new Error(`ENOTFOUND ${cosUrl} E:\\private\\secret.png`));
    try { await prepareRouteImageAdapterRequest(provider, input([cosUrl]), route()); throw new Error('expected failure'); }
    catch (error) {
      expect((error as Error).message).toBe('Reference image could not be read or validated');
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private-signature|secret.png|https:/);
    }
  });
});

describe('public HTTPS temporary Seedream references', () => {
  it('rehosts COS bytes in the default public HTTPS mode, serves anonymously, and expires in 30 minutes', async () => {
    const app = Fastify(); app.decorate('prisma', {} as never);
    app.decorate('authenticateAccessToken', vi.fn(async () => { throw new Error('must not need login'); }));
    await app.register(aiRoutes, { prefix: '/v1/ai' });
    storage.tryResolveObjectKeyFromUrl.mockImplementation((url: string) => url === cosUrl ? 'reference-images/upload.png' : null);
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      createdUrls.push(String(url));
      const response = await app.inject({ method: 'GET', url: url.pathname });
      return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers as Record<string, string> });
    }));
    try {
      const selectedRoute = route({ referenceTransport: undefined });
      const prepared = await prepareRouteImageAdapterRequest(provider, input([cosUrl]), selectedRoute);
      const url = (prepared!.body.images as string[])[0]!;
      expect(url).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/provider-references\/[a-f0-9]{64}\.png$/);
      const reference = await getProviderReference(providerReferenceKey(url)!);
      expect(await readFile(reference!.path)).toEqual(png);
      const response = await app.inject({ method: 'GET', url: new URL(url).pathname });
      expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(png);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(app.authenticateAccessToken).not.toHaveBeenCalled();
      expect(storage.getObjectStream).toHaveBeenCalledWith('reference-images/upload.png');
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + PROVIDER_REFERENCE_TTL_MS + 1000);
      expect((await app.inject({ method: 'GET', url: new URL(url).pathname })).statusCode).toBe(404);
    } finally { vi.useRealTimers(); await app.close(); }
  });

  it('blocks a temporary URL redirected to a private host before any upstream submission', async () => {
    const fetch = vi.fn().mockImplementation(async (url: URL) => {
      createdUrls.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/a.png' } });
    }); vi.stubGlobal('fetch', fetch);
    await expect(prepareRouteImageAdapterRequest(provider, input([dataUrl()]), route({ referenceTransport: 'public_https' })))
      .rejects.toMatchObject({ code: 'reference_image_url_blocked' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getProviderReference(providerReferenceKey(createdUrls[0]!)!)).toBeNull();
  });

  it('reads an existing server cached reference through its bounded store rather than URL fetch', async () => {
    const url = await createProviderReference(png, 'image/png'); createdUrls.push(url);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareSeedreamReference(url, 'data_url')).resolves.toMatchObject({ value: dataUrl() });
    expect(fetch).not.toHaveBeenCalled();
    expect(await getProviderReference('../private.png')).toBeNull();
  });
});

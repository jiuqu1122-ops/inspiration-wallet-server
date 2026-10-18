import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { generatePreparedImageAdapterImages, prepareRouteImageAdapterRequest } from '../src/modules/ai/image-service.js';
import { isUselgMidjourneyFull, uselgMidjourneyFullHeaders, validateUselgMidjourneyFullSubmission } from '../src/modules/ai/uselg-midjourney-full.js';

const model = 'midjourney-v8.2-full';
const provider = (kind = 'NEW_API') => ({ id: 'full-provider', kind, name: 'Full offline fixture', baseUrl: 'https://api.uselg.top' });
const route = () => ({
  requestedCanonicalModel: 'midjourney-v8-2-full', resolvedCanonicalModel: 'midjourney-v8-2-full',
  canonicalModelId: 'full-model', canonicalModelKey: 'midjourney-v8-2-full', routeId: 'full-route', channelId: 'full-provider',
  upstreamModel: model, adapterKey: 'GENERIC_OPENAI_IMAGE', executionMode: 'TASK',
  adapterConfig: { generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/edits',
    resolutionParameter: 'size', resolutionValueMode: 'exact', aspectRatioParameter: 'none',
    exactDimensions: { '1K': { '1:1': '1024x1024', '16:9': '1600x900' } },
    referenceSerializer: 'object_image_url', referenceTransport: 'data_url', referenceRequestCount: 1,
    requestParameters: { n: 1, response_format: 'b64_json' } },
  executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
    statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary', asyncParameterName: 'async', asyncParameterValue: true,
    processingStatuses: ['queued', 'dispatching', 'running'], completedStatuses: ['success'],
    failedStatuses: ['failed', 'canceled', 'client_disconnected'] },
});
let reference: string;
let images: Buffer[];
const input = (references = 0, prompt = 'a playful cat --stylize 100') => ({
  userId: 'full-owner', clientRequestId: 'full-logical-request', model, prompt, inputImages: Array(references).fill(reference) as string[],
  aspectRatio: '16:9', resolution: '1k', count: 1, outputFormat: 'png' as const,
  imageCapabilities: { supportsImageEdit: true, supportsTransparentBackground: false, outputMode: 'multiple_assets', maxOutputImages: 4 },
});
beforeAll(async () => {
  const png = (background: string) => sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer();
  reference = `data:image/png;base64,${(await png('#123456')).toString('base64')}`;
  images = await Promise.all(['#ab1000', '#00ab10', '#1000ab', '#abab00'].map(png));
});
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function transport(mode = 'async') {
  let polls = 0;
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return mode === 'sync'
      ? Response.json({ created: 1792252800, data: images.map(bytes => ({ b64_json: bytes.toString('base64') })) })
      : Response.json({ task_id: 'imgtask_full', status: 'queued', status_url: '/v1/images/tasks/imgtask_full?view=summary',
        poll_after_ms: 2000, assets: [] }, { status: 202 });
    const path = new URL(url).pathname;
    const asset = path.match(/^\/v1\/images\/tasks\/imgtask_full\/assets\/variant-(\d)\.png$/);
    if (asset) return new Response(new Uint8Array(images[Number(asset[1])]!), { headers: { 'content-type': 'image/png' } });
    if (path === '/v1/images/tasks/imgtask_full') {
      polls += 1;
      return Response.json({ task_id: 'imgtask_full', status: ['dispatching', 'running', 'success'][Math.min(2, polls - 1)],
        assets: polls < 3 ? [] : images.map((_bytes, index) => ({
          download_url: `/v1/images/tasks/imgtask_full/assets/variant-${index}.png?download=1`, width: 2, height: 2 })) });
    }
    throw new Error('Unexpected offline fixture URL');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function generate(requestInput = input(), requestRoute = route(), kind = 'NEW_API', onTaskSubmitted = vi.fn()) {
  const channel = provider(kind);
  const prepared = await prepareRouteImageAdapterRequest(channel as never, requestInput, requestRoute);
  return generatePreparedImageAdapterImages(channel as never, { apiKey: 'offline-full-fixture', headers: {} }, requestInput,
    prepared!, requestRoute, { wait: async () => {}, onTaskSubmitted });
}

describe('confirmed USELG V8.2-full text and reference contract', () => {
  it.each(['other-vendor', 'other-port', 'ordinary-v82', 'v7-full', 'niji', 'other-adapter', 'invalid-url'])(
    'does not activate the full-specific contract for %s', scenario => {
      const channel = provider(); const requestRoute = route();
      if (scenario === 'other-vendor') channel.baseUrl = 'https://vendor.example';
      if (scenario === 'other-port') channel.baseUrl = 'https://api.uselg.top:8443';
      if (scenario === 'ordinary-v82') requestRoute.upstreamModel = 'midjourney-v8.2';
      if (scenario === 'v7-full') requestRoute.upstreamModel = 'midjourney-v7-full';
      if (scenario === 'niji') requestRoute.upstreamModel = 'niji-v7-full';
      if (scenario === 'other-adapter') requestRoute.adapterKey = 'GROK_IMAGES_API';
      if (scenario === 'invalid-url') channel.baseUrl = 'invalid';
      expect(isUselgMidjourneyFull(channel, requestRoute)).toBe(false);
      expect(uselgMidjourneyFullHeaders(channel, input(), requestRoute)).toBeUndefined();
      expect(() => validateUselgMidjourneyFullSubmission(channel, requestRoute, '/unrelated', {})).not.toThrow();
    });

  it('keeps the receipt stable for the same owned request and distinct for another request, owner, route or provider', () => {
    const first = uselgMidjourneyFullHeaders(provider(), input(), route());
    expect(uselgMidjourneyFullHeaders(provider(), { ...input(1), prompt: 'refreshed source URL' }, route())).toEqual(first);
    const alternatives = [
      uselgMidjourneyFullHeaders(provider(), { ...input(), clientRequestId: 'another-request' }, route()),
      uselgMidjourneyFullHeaders(provider(), { ...input(), userId: 'another-owner' }, route()),
      uselgMidjourneyFullHeaders({ ...provider(), id: 'another-provider' }, input(), route()),
      uselgMidjourneyFullHeaders(provider(), input(), { ...route(), routeId: 'another-route' }),
    ];
    expect(new Set([first, ...alternatives].map(headers => headers!['Idempotency-Key'])).size).toBe(5);
  });

  it.each(['1024x1024', '1536x1024', '1024x1536', '1024x768', '768x1024', '1280x1024', '1024x1280', '1600x900', '900x1600', '2100x900', 'auto'])(
    'accepts documented ratio dimensions without treating %s as a promised output resolution', size => {
      expect(() => validateUselgMidjourneyFullSubmission(provider(), route(), '/v1/images/generations', {
        model, prompt: 'a cat', n: 1, async: true, size,
      })).not.toThrow();
    });

  it('accepts a consistent optional string version while preserving the user prompt', async () => {
    const fetch = transport('sync'); const requestRoute = route();
    Object.assign(requestRoute.adapterConfig.requestParameters, { mj_version: '8.2' });
    await expect(generate(input(), requestRoute)).resolves.toHaveLength(4);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ mj_version: '8.2', prompt: input().prompt });
  });

  it('converts a local WebP into PNG before the full API receives it', async () => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp().toBuffer();
    const requestInput = input(); requestInput.inputImages = [`data:image/webp;base64,${bytes.toString('base64')}`];
    const fetch = transport('sync');
    await expect(generate(requestInput)).resolves.toHaveLength(4);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).images[0].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it('retains synchronous URL descriptors without assuming only the first image is a result', async () => {
    const urls = images.map((_image, index) => `https://cdn.example/full-${index}.png`);
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ data: urls.map(url => ({ url })) }));
    vi.stubGlobal('fetch', fetch);
    await expect(generate()).resolves.toEqual(urls);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['NEW_API', 'USELG'].flatMap(kind => ['async', 'sync'].flatMap(mode => [0, 1, 5].map(count => [kind, mode, count] as const))))(
    'delivers all four %s %s results with %i references after exactly one generation POST', async (kind, mode, count) => {
      const fetch = transport(mode);
      const requestInput = input(count);
      const onTaskSubmitted = vi.fn();
      const result = await generate(requestInput, route(), kind, onTaskSubmitted);
      expect(result).toHaveLength(4); expect(new Set(result).size).toBe(4);
      const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(String(posts[0]![0])).toBe(`https://api.uselg.top/v1/images/${count ? 'edits' : 'generations'}`);
      expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ model, prompt: requestInput.prompt, size: '1600x900',
        n: 1, async: true, response_format: 'b64_json', ...(count ? { images: requestInput.inputImages.map(image_url => ({ image_url })) } : {}) });
      expect(new Headers(posts[0]![1]!.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9]{64}$/);
      if (mode === 'async') {
        expect(onTaskSubmitted).toHaveBeenCalledOnce();
        expect(fetch.mock.calls.filter(([url]) => String(url).includes('/assets/'))).toHaveLength(4);
        expect(fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer offline-full-fixture')).toBe(true);
      } else { expect(onTaskSubmitted).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); }
    });

  it.each(['x'.repeat(1002), '\u{1f431}'.repeat(1002), `${'x'.repeat(1002)} --v 8.2`, `${'x'.repeat(996)} --version 8.2`])(
    'preserves a document-compliant prompt without appending resolution or background instructions', async prompt => {
      const prepared = await prepareRouteImageAdapterRequest(provider() as never, input(0, prompt), route());
      expect(prepared!.body.prompt).toBe(prompt);
      expect(Array.from(String(prepared!.body.prompt)).length).toBeLessThanOrEqual(1010);
    });

  it.each(['x'.repeat(1003), '\u{1f431}'.repeat(1003), `${'x'.repeat(1003)} --v 8.2`, 'a cat --v 7', 'a cat --niji 7', 'a cat --v 8.2 --version 8.2'])(
    'rejects an excessive or conflicting prompt before any paid POST', async prompt => {
      const fetch = transport();
      await expect(generate(input(0, prompt))).rejects.toMatchObject({ code: 'IMAGE_ADAPTER_CONFIG_INVALID' });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each(['old-operation', 'old-reference-endpoint', 'resolution-label', 'missing-async', 'mask', 'size-ratio', 'wrong-version', 'count', 'direct'])(
    'rejects incompatible %s settings before a generation POST', async scenario => {
      const fetch = transport();
      const requestInput = input(scenario === 'old-reference-endpoint' ? 1 : 0);
      const requestRoute = route();
      if (scenario === 'old-operation') Object.assign(requestRoute.adapterConfig.requestParameters, { operation: 'imagine', speed: 'fast' });
      if (scenario === 'old-reference-endpoint') requestRoute.adapterConfig.editEndpoint = '/v1/images/generations';
      if (scenario === 'resolution-label') requestRoute.adapterConfig.resolutionValueMode = 'label';
      if (scenario === 'missing-async') requestRoute.executionConfig.asyncParameterValue = false;
      if (scenario === 'mask') Object.assign(requestRoute.adapterConfig.requestParameters, { mask: 'invalid' });
      if (scenario === 'size-ratio') requestRoute.adapterConfig.exactDimensions['1K']['16:9'] = '1000x700';
      if (scenario === 'wrong-version') Object.assign(requestRoute.adapterConfig.requestParameters, { mj_version: 8.2 });
      if (scenario === 'count') requestInput.count = 2;
      if (scenario === 'direct') requestRoute.executionMode = 'DIRECT';
      await expect(generate(requestInput, requestRoute)).rejects.toMatchObject({ code: 'IMAGE_ADAPTER_CONFIG_INVALID' });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each([400, 403, 409, 429, 500])('never retries a rejected HTTP %i generation POST', async status => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ error: { message: 'Fixture rejection' } }, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(generate()).rejects.toBeDefined(); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { data: [] }, { data: [{ text: 'not an image' }] }, { data: [{ b64_json: 'plain text' }] },
    { status: 'running', data: [{ url: 'https://cdn.example/unconfirmed.png' }] },
    { error: { message: 'failed' }, data: [{ url: 'https://cdn.example/unconfirmed.png' }] },
  ])('does not fabricate synchronous success for an invalid or unfinished response (%j)', async payload => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json(payload));
    vi.stubGlobal('fetch', fetch);
    await expect(generate()).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
});

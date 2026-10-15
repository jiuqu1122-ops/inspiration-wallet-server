import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { prepareRouteImageAdapterRequest, generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';
import { ImageTaskTerminalFailureError } from '../src/modules/ai/image-task-retry.js';
import { buildFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';
import { isUselgMidjourneyImagine, uselgMidjourneyImagineHeaders, validateUselgMidjourneyImagineSubmission } from '../src/modules/ai/uselg-midjourney-imagine.js';

const prompt = 'a quiet mountain village at sunrise --stylize 100';
const adapterConfig = {
  generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/generations',
  requestParameters: { n: 1, speed: 'fast', operation: 'imagine' },
  referenceTransport: 'data_url', referenceSerializer: 'object_image_url', referenceRequestCount: 1,
  aspectRatioParameter: 'aspect_ratio',
};
const executionConfig = {
  profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
  statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary', taskIdPath: 'task_id', statusPath: 'status',
  pollAfterMsPath: 'poll_after_ms', assetArrayPath: 'assets', signedUrlPath: 'signed_url',
  downloadUrlPath: 'download_url', urlPath: 'url', processingStatuses: ['queued', 'dispatching', 'running'],
  completedStatuses: ['success'], failedStatuses: ['failed', 'canceled', 'client_disconnected'],
};
const provider = (kind = 'NEW_API') => ({ id: 'mj-provider', kind, name: 'MJ fixture', baseUrl: 'https://api.uselg.top' });
const route = () => ({ adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: structuredClone(adapterConfig),
  requestedCanonicalModel: 'midjourney-v8-2', resolvedCanonicalModel: 'midjourney-v8-2',
  canonicalModelId: 'mj-model', canonicalModelKey: 'midjourney-v8-2', routeId: 'mj-route', channelId: 'mj-provider',
  upstreamModel: 'midjourney-v8.2', executionMode: 'TASK', executionConfig: structuredClone(executionConfig) });
const input = (inputImages: string[] = [], clientRequestId = 'logical-request') => ({
  userId: 'fixture-user', clientRequestId, model: 'midjourney-v8.2', prompt, inputImages,
  aspectRatio: '16:9', resolution: '1k', outputFormat: 'png' as const, count: 1,
  imageCapabilities: { supportsImageEdit: true, supportsTransparentBackground: false, maxOutputImages: 1 },
});
let bytes: Buffer;
let reference: string;
beforeAll(async () => {
  bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aa6633' } }).png().toBuffer();
  const referenceBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#112244' } }).png().toBuffer();
  reference = `data:image/png;base64,${referenceBytes.toString('base64')}`;
});
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function successfulTransport() {
  let reads = 0;
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST') return Response.json({ task_id: 'imgtask_fixture', object: 'image.task',
      model: 'midjourney-v8.2', status: 'queued', status_url: '/v1/images/tasks/imgtask_fixture?view=summary',
      poll_after_ms: 2000, assets: [], midjourney: { operation: 'imagine', speed: 'fast', actions: [] } }, { status: 202 });
    if (path.endsWith('/assets/result.png')) return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
    if (path === '/v1/images/tasks/imgtask_fixture') {
      reads += 1;
      return Response.json({ task_id: 'imgtask_fixture', status: ['dispatching', 'running', 'success'][Math.min(2, reads - 1)],
        assets: reads < 3 ? [] : [{ url: '/v1/images/tasks/imgtask_fixture/assets/result.png',
          download_url: '/v1/images/tasks/imgtask_fixture/assets/result.png?download=1', width: 2, height: 2 }] });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function generate(kind: string, requestInput = input(), requestRoute = route()) {
  const channel = provider(kind);
  const prepared = await prepareRouteImageAdapterRequest(channel as never, requestInput, requestRoute);
  return generatePreparedImageAdapterImages(channel as never, { apiKey: 'fixture-only-key', headers: {} },
    requestInput, prepared!, requestRoute, { wait: async () => {} });
}

// The exact screenshot configuration is exercised through the actual HTTP boundary.
describe('USELG Midjourney V8.2 imagine contract', () => {
  it.each(['other-host', 'other-port', 'v7', 'follow-up-operation', 'other-adapter', 'invalid-url'])(
    'does not apply the supplier-specific contract to %s', scenario => {
      const channel = provider();
      const requestRoute = route();
      if (scenario === 'other-host') channel.baseUrl = 'https://relay.example';
      if (scenario === 'other-port') channel.baseUrl = 'https://api.uselg.top:8443';
      if (scenario === 'v7') requestRoute.upstreamModel = 'midjourney-v7';
      if (scenario === 'follow-up-operation') requestRoute.adapterConfig.requestParameters.operation = 'upscale';
      if (scenario === 'other-adapter') requestRoute.adapterKey = 'GROK_IMAGES_API';
      if (scenario === 'invalid-url') channel.baseUrl = 'not a URL';
      expect(isUselgMidjourneyImagine(channel, requestRoute)).toBe(false);
      expect(uselgMidjourneyImagineHeaders(channel, input(), requestRoute)).toBeUndefined();
      expect(() => validateUselgMidjourneyImagineSubmission(channel, requestRoute, '/v1/images/edits', {})).not.toThrow();
    });

  it('scopes the receipt to its owner, provider and route as well as the logical request', () => {
    const receipts = [
      uselgMidjourneyImagineHeaders(provider(), input(), route()),
      uselgMidjourneyImagineHeaders(provider(), { ...input(), userId: 'another-owner' }, route()),
      uselgMidjourneyImagineHeaders({ ...provider(), id: 'another-provider' }, input(), route()),
      uselgMidjourneyImagineHeaders(provider(), input(), { ...route(), routeId: 'another-route' }),
    ].map(headers => headers!['Idempotency-Key']);
    expect(new Set(receipts).size).toBe(4);
  });

  it.each([400, 403, 409, 429, 500])('never retries a rejected HTTP %i generation POST', async status => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ error: { message: 'Fixture rejection' } }, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(generate('NEW_API')).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.method).toBe('POST');
  });

  it.each(['NEW_API', 'USELG'].flatMap(kind => [0, 1, 5].map(count => [kind, count] as const)))(
    'submits document JSON for %s with %s references, polls and downloads using the same key', async (kind, count) => {
      const fetch = successfulTransport();
      const references = Array.from({ length: count }, () => reference);
      await expect(generate(kind, input(references))).resolves.toEqual([expect.stringMatching(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\//)]);
      const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(1);
      const [url, post] = posts[0]!;
      expect(String(url)).toBe('https://api.uselg.top/v1/images/generations');
      expect(JSON.parse(post!.body as string)).toEqual({ model: 'midjourney-v8.2', prompt, operation: 'imagine',
        speed: 'fast', n: 1, aspect_ratio: '16:9', ...(count ? { images: references.map(image_url => ({ image_url })) } : {}) });
      const headers = new Headers(post!.headers);
      expect(headers.get('Idempotency-Key')).toMatch(/^[a-f0-9]{64}$/);
      expect(headers.get('content-type')).toBe('application/json');
      for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-only-key');
      const gets = fetch.mock.calls.filter(([, init]) => init?.method === 'GET');
      expect(gets.filter(([url]) => !String(url).includes('/assets/')).map(([url]) => String(url)))
        .toEqual(Array(3).fill('https://api.uselg.top/v1/images/tasks/imgtask_fixture?view=summary'));
      expect(String(gets.at(-1)![0])).toBe('https://api.uselg.top/v1/images/tasks/imgtask_fixture/assets/result.png?download=1');
      expect(gets.every(([, init]) => !new Headers(init?.headers).has('Idempotency-Key'))).toBe(true);
    });

  it.each(['NEW_API', 'USELG'])('keeps a logical receipt stable and distinguishes a new request on %s', async kind => {
    const receipts: string[] = [];
    for (const requestInput of [input(), input([reference]), input([], 'another-request')]) {
      const fetch = successfulTransport();
      await generate(kind, requestInput);
      receipts.push(new Headers(fetch.mock.calls[0]![1]?.headers).get('Idempotency-Key') ?? '');
    }
    expect(receipts[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[1]).toBe(receipts[0]);
    expect(receipts[2]).not.toBe(receipts[0]);
  });

  it.each(['edit-endpoint', 'size', 'async', 'direct', 'count', 'too-many-references'])(
    'rejects an incompatible %s configuration before any generation POST', async scenario => {
      const fetch = successfulTransport();
      const requestInput = input(scenario === 'edit-endpoint' ? [reference] : []);
      const requestRoute = route();
      if (scenario === 'edit-endpoint') requestRoute.adapterConfig.editEndpoint = '/v1/images/edits';
      if (scenario === 'size') Object.assign(requestRoute.adapterConfig, { resolutionParameter: 'size' });
      if (scenario === 'async') Object.assign(requestRoute.executionConfig, { asyncParameterName: 'async', asyncParameterValue: true });
      if (scenario === 'direct') requestRoute.executionMode = 'DIRECT';
      if (scenario === 'count') requestInput.count = 2;
      if (scenario === 'too-many-references') requestInput.inputImages = Array(6).fill(reference);
      await expect(generate('NEW_API', requestInput, requestRoute)).rejects.toMatchObject({ code: 'IMAGE_ADAPTER_CONFIG_INVALID' });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each(['quota_not_enough', 'content_policy_violation'].flatMap(reason => ['message', 'code-only', 'code-and-message'].map(form => [reason, form] as const)))(
    'retains a safe %s failure in %s form and never resubmits', async (reason, form) => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => Response.json({ task_id: 'imgtask_fixture',
      status: init?.method === 'POST' ? 'queued' : 'failed', ...(init?.method === 'POST' ? {} : {
        error: form === 'message' ? { message: `${reason} https://private.example/prompt-secret.png Bearer private-token` }
          : { code: reason, ...(form === 'code-only' ? {} : { message: 'https://private.example/prompt-secret.png Bearer private-token' }) } }) }));
    vi.stubGlobal('fetch', fetch);
    const failure = await generate('NEW_API').catch(error => error);
    expect(failure).toBeInstanceOf(ImageTaskTerminalFailureError);
    expect(failure.message).not.toMatch(/private-token|prompt-secret|private\.example/);
    const diagnostic = buildFailureDiagnostic(failure, { stage: 'image_generation' });
    expect(diagnostic.code).toBe(reason === 'quota_not_enough' ? 'PROVIDER_QUOTA_EXCEEDED' : 'PROVIDER_CONTENT_REJECTED');
    expect(failure.message).toContain(diagnostic.message);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls).toHaveLength(2);
  });
});

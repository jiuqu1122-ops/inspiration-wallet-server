import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { prepareRouteImageAdapterRequest, generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';
import { getImageModelAdapter, prepareImageAdapterRequest } from '../src/modules/ai/image-adapters/registry.js';
import { imageAdapterConfig, type ImageAdapterInput } from '../src/modules/ai/image-adapters/types.js';
import { genericImageRequestHeaders } from '../src/modules/ai/image-adapters/generic-request-headers.js';

const provider = { id: 'parameter-provider', name: 'Parameter fixture', kind: 'NEW_API', baseUrl: 'https://relay.example' } as never;
const requestParameters = { type: 'imagine', n: 1, response_format: 'url' };
const adapterConfig = {
  generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/generations',
  referenceSerializer: 'object_image_url', referenceTransport: 'data_url', requestParameters,
  resolutionParameter: 'size', resolutionValueMode: 'exact', exactDimensions: { '1K': { '16:9': '1280x720' } },
};
const route = (config: Record<string, unknown> = adapterConfig, model = 'opaque-upstream-fixture') => ({
  adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: config, requestedCanonicalModel: 'canonical-fixture',
  resolvedCanonicalModel: 'canonical-fixture', canonicalModelId: 'model', canonicalModelKey: 'canonical-fixture',
  routeId: 'route', channelId: 'parameter-provider', upstreamModel: model, executionMode: 'TASK',
  executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}',
    asyncParameterName: 'async', asyncParameterValue: true },
});
const input = (references: string[], count = 1) => ({ userId: 'owner', clientRequestId: 'static-parameter-receipt',
  model: 'opaque-upstream-fixture', prompt: 'Fixture prompt', inputImages: references, aspectRatio: '16:9', resolution: '1k',
  outputFormat: 'jpg' as const, count, imageCapabilities: { supportsImageEdit: true, outputMode: 'multiple_assets', maxOutputImages: 4 } });
let png: Buffer;
let outputImages: string[];
const pngDataUrl = () => `data:image/png;base64,${png.toString('base64')}`;

beforeAll(async () => {
  const outputs = await Promise.all(['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map(background =>
    sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toBuffer()));
  png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#808080' } }).png().toBuffer();
  outputImages = outputs.map(bytes => `data:image/png;base64,${bytes.toString('base64')}`);
});
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit Generic static request parameters at the actual HTTP boundary', () => {
  it.each([false, true])('submits the exact configured imagine JSON with references=%s and returns four task assets', async withReferences => {
    const fetch = vi.fn(async (_url: string | URL, request?: RequestInit) => request?.method === 'POST'
      ? Response.json({ task_id: 'one-accepted-task', status: 'queued' })
      : Response.json({ task_id: 'one-accepted-task', status: 'success', data: outputImages.map(image => ({ b64_json: image.split(',')[1] })) }));
    vi.stubGlobal('fetch', fetch);
    const references = withReferences ? [pngDataUrl()] : [];
    const requestInput = input(references);
    const prepared = await prepareRouteImageAdapterRequest(provider, requestInput, route());
    const outputs = await generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-only', headers: {} }, requestInput, prepared!, route(), { wait: async () => {} });
    expect(outputs).toEqual(outputImages);
    expect(fetch.mock.calls).toHaveLength(2);
    const [postUrl, post] = fetch.mock.calls[0]!;
    expect(String(postUrl)).toBe('https://relay.example/v1/images/generations');
    expect(post!.method).toBe('POST');
    expect(new Headers(post!.headers).has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(post!.body as string)).toEqual({
      model: 'opaque-upstream-fixture',
      prompt: 'Fixture prompt\n\nStrict image constraints: must output exactly 16:9 aspect ratio, target resolution 1k.',
      type: 'imagine', n: 1, response_format: 'url', size: '1280x720', async: true,
      ...(withReferences ? { images: [{ image_url: pngDataUrl() }] } : {}),
    });
    expect(fetch.mock.calls[1]![0]).toBe('https://relay.example/tasks/one-accepted-task');
    expect(fetch.mock.calls[1]![1]!.method).toBe('GET');
  });

  it('applies an explicit route configuration to an unrelated upstream model without model-name matching', async () => {
    const requestRoute = route(adapterConfig, 'another-model-2029');
    const prepared = await prepareRouteImageAdapterRequest(provider, { ...input([]), model: requestRoute.upstreamModel }, requestRoute);
    expect(prepared!.submittedModel).toBe('another-model-2029');
    expect(prepared!.body).toMatchObject({ model: 'another-model-2029', ...requestParameters });
  });

  it('serializes operation and speed only from the selected route instead of adding implicit values', async () => {
    const parameters = { operation: 'route-owned-operation', speed: 'route-owned-speed', enabled: false, seed: 0, empty: '' };
    const configured = await prepareRouteImageAdapterRequest(provider, input([]), route({ ...adapterConfig, requestParameters: parameters }));
    expect(configured!.body).toMatchObject(parameters);
    expect(configured!.body).not.toHaveProperty('type');
    expect(configured!.body).not.toHaveProperty('n');
    const defaultConfig: Record<string, unknown> = { ...adapterConfig };
    delete defaultConfig.requestParameters;
    const ordinary = await prepareRouteImageAdapterRequest(provider, input([]), route(defaultConfig));
    for (const key of Object.keys(parameters)) expect(ordinary!.body).not.toHaveProperty(key);
  });

  it.each([false, true])('rejects a fixed count mismatch before any network activity with references=%s', async withReferences => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareRouteImageAdapterRequest(provider, input(withReferences ? [pngDataUrl()] : [], 2), route()))
      .rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not repeat a paid POST or poll when the submission fails', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Fixture upstream rejection' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([pngDataUrl()]), route());
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-only', headers: {} }, input([pngDataUrl()]), prepared!, route(), { wait: async () => {} }))
      .rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].method).toBe('POST');
  });

  it('does not automatically resubmit after an ambiguous transport failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Fixture connection closed after submission'));
    vi.stubGlobal('fetch', fetch);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([]), route());
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-only', headers: {} }, input([]), prepared!, route(), { wait: async () => {} }))
      .rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].method).toBe('POST');
  });

  it('preserves the existing Generic body when no static parameters are configured', async () => {
    const existingConfig: Record<string, unknown> = { ...adapterConfig };
    delete existingConfig.requestParameters;
    const prepared = await prepareRouteImageAdapterRequest(provider, input([]), route(existingConfig));
    expect(prepared!.body).toEqual({ model: 'opaque-upstream-fixture',
      prompt: 'Fixture prompt\n\nStrict image constraints: must output exactly 16:9 aspect ratio, target resolution 1k.', size: '1280x720' });
  });

  it('preserves the default Legacy and GPT adapter contracts', () => {
    const request: ImageAdapterInput = { requestedCanonicalModel: 'gpt-image-2', resolvedCanonicalModel: 'gpt-image-2',
      canonicalModelId: 'gpt', canonicalModelKey: 'gpt-image-2', routeId: 'route', channelId: 'channel', upstreamModel: 'gpt-image-2',
      prompt: 'Fixture prompt', references: [], aspectRatio: '1:1', count: 1, outputFormat: 'png' };
    expect(prepareImageAdapterRequest(getImageModelAdapter('LEGACY'), request)).toBeNull();
    expect(prepareImageAdapterRequest(getImageModelAdapter('GPT_IMAGE'), request)).toBeNull();
    expect(prepareImageAdapterRequest(getImageModelAdapter('GPT_IMAGE'), { ...request, adapterConfig })).toBeNull();
  });

  it.each(['GROK_IMAGES_API', 'SEEDREAM_IMAGES_API'])('does not apply Generic static fields to the %s adapter', key => {
    const model = key === 'GROK_IMAGES_API' ? 'grok-image' : 'seedream-5';
    const request: ImageAdapterInput = { requestedCanonicalModel: model, resolvedCanonicalModel: model,
      canonicalModelId: 'model', canonicalModelKey: model, routeId: 'route', channelId: 'channel', upstreamModel: model,
      prompt: 'Fixture prompt', references: [], aspectRatio: '1:1', count: 1, outputFormat: 'jpg' };
    const ordinary = prepareImageAdapterRequest(getImageModelAdapter(key), request);
    const configured = prepareImageAdapterRequest(getImageModelAdapter(key), { ...request,
      adapterConfig: { requestParameters: { type: 'imagine', operation: 'configured-operation', speed: 'fast', n: 1, response_format: 'url' } } });
    expect(configured).toEqual(ordinary);
    expect(configured!.body).not.toHaveProperty('type');
    expect(configured!.body).not.toHaveProperty('operation');
  });
});

describe('static request parameter validation', () => {
  it('accepts only an explicit true task-metadata opt-in and preserves the unconfigured shape', () => {
    expect(imageAdapterConfig({ preserveTaskMetadata: true })).toEqual({ preserveTaskMetadata: true });
    expect(imageAdapterConfig({})).toEqual({});
    for (const preserveTaskMetadata of [false, 'true', 1, null, {}]) {
      expect(() => imageAdapterConfig({ preserveTaskMetadata })).toThrow();
    }
  });

  it('round-trips bounded primitive values, explicit count and response format without coercion', () => {
    const values = { type: 'imagine', operation: 'route-operation', speed: 'relaxed', empty: '', n: 10, response_format: 'b64_json', enabled: false, seed: -1.5, caption: 'x'.repeat(1000), ['a'.repeat(64)]: true };
    expect(imageAdapterConfig({ requestParameters: values })).toEqual({ requestParameters: values });
    expect(imageAdapterConfig({ requestParameters: {} })).toEqual({});
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, index]));
    expect(imageAdapterConfig({ requestParameters: twenty })).toEqual({ requestParameters: twenty });
  });

  it.each(['model', 'prompt', 'image', 'images', 'input', 'input_images', 'mask', 'mask_base64', 'size', 'resolution',
    'aspect_ratio', 'quality', 'background', 'output_format', 'output_compression', 'stream', 'async', '__proto__', 'prototype', 'constructor',
    'MODEL', 'Prompt', 'ASYNC', ...Object.getOwnPropertyNames(Object.prototype)])('rejects protected parameter %s', key => {
    const values = JSON.parse(`{"${key}":"fixture"}`);
    expect(() => imageAdapterConfig({ requestParameters: values })).toThrow();
  });

  it.each([
    null, [], 'not-an-object',
    { nested: { value: true } }, { values: [1] }, { absent: null }, { absent: undefined },
    { seed: Number.NaN }, { seed: Number.POSITIVE_INFINITY }, { label: 'x'.repeat(1001) },
    { '1invalid': true }, { 'bad-key': true }, { 'bad.key': true }, { ['a'.repeat(65)]: true },
    Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field_${index}`, index])),
    { n: 0 }, { n: 11 }, { n: 1.5 }, { n: '1' }, { response_format: 'png' }, { response_format: true },
  ])('rejects malformed static parameters %#', values => {
    expect(() => imageAdapterConfig({ requestParameters: values })).toThrow();
  });

  it.each([
    { referenceRequestCount: 1, requestParameters: { n: 2 } },
    { referenceResponseFormat: 'url', requestParameters: { response_format: 'b64_json' } },
  ])('rejects competing reference-only and static settings %#', config => {
    expect(() => imageAdapterConfig(config)).toThrow();
  });

  it('accepts matching reference-only and static settings without changing either value', () => {
    const config = { referenceRequestCount: 1, referenceResponseFormat: 'url', requestParameters: { n: 1, response_format: 'url' } };
    expect(imageAdapterConfig(config)).toEqual(config);
  });
});

describe('explicit Generic submit-only idempotency', () => {
  const headerConfig = { ...adapterConfig, idempotencyHeader: 'Idempotency-Key' };

  it('round-trips only the literal opt-in header name', () => {
    expect(imageAdapterConfig({ idempotencyHeader: 'Idempotency-Key' })).toEqual({ idempotencyHeader: 'Idempotency-Key' });
    for (const idempotencyHeader of ['idempotency-key', 'X-Request-ID', '', true, null]) {
      expect(() => imageAdapterConfig({ idempotencyHeader })).toThrow();
    }
  });

  it('hashes only the stable user/provider/route/request identity and keeps other adapters opt-out', () => {
    const identity = { userId: 'owner', clientRequestId: 'receipt-a' };
    const scopedRoute = route(headerConfig);
    const expected = createHash('sha256').update(JSON.stringify(['generic-image-idempotency-v1', 'owner', 'parameter-provider', 'route', 'receipt-a'])).digest('hex');
    expect(genericImageRequestHeaders({ id: 'parameter-provider' }, identity, scopedRoute)).toEqual({ 'Idempotency-Key': expected });
    expect(genericImageRequestHeaders({ id: 'parameter-provider' }, identity, route())).toBeUndefined();
    expect(genericImageRequestHeaders({ id: 'parameter-provider' }, identity, { ...scopedRoute, adapterKey: 'GPT_IMAGE' })).toBeUndefined();
    expect(genericImageRequestHeaders({ id: 'parameter-provider' }, identity, undefined)).toBeUndefined();
  });

  it('uses one stable key for refreshed reference URLs, distinct keys for new identity scopes, and no key on polls', async () => {
    const fetch = vi.fn(async (_url: string | URL, request?: RequestInit) => request?.method === 'POST'
      ? Response.json({ task_id: 'idempotent-task', status: 'queued' })
      : Response.json({ task_id: 'idempotent-task', status: 'success', data: [{ b64_json: outputImages[0]!.split(',')[1] }] }));
    vi.stubGlobal('fetch', fetch);
    const base = input([]);
    const keyByAttempt: string[] = [];
    const attempts = [
      { requestInput: { ...base, inputImages: ['https://cdn.example/reference.png?v=1'] }, requestRoute: route({ ...headerConfig, referenceTransport: 'public_https' }), requestProvider: provider },
      { requestInput: { ...base, inputImages: ['https://cdn.example/reference.png?v=2'] }, requestRoute: route({ ...headerConfig, referenceTransport: 'public_https' }), requestProvider: provider },
      { requestInput: { ...base, clientRequestId: 'a-new-logical-request' }, requestRoute: route(headerConfig), requestProvider: provider },
      { requestInput: { ...base, userId: 'another-owner' }, requestRoute: route(headerConfig), requestProvider: provider },
      { requestInput: base, requestRoute: { ...route(headerConfig), routeId: 'another-route' }, requestProvider: provider },
      { requestInput: base, requestRoute: route(headerConfig), requestProvider: Object.assign({}, provider, { id: 'another-provider' }) as never },
    ];
    for (const { requestInput, requestRoute, requestProvider } of attempts) {
      const prepared = await prepareRouteImageAdapterRequest(requestProvider, requestInput, requestRoute);
      await generatePreparedImageAdapterImages(requestProvider, { apiKey: 'fixture-only', headers: {} }, requestInput, prepared!, requestRoute, { wait: async () => {} });
      const post = fetch.mock.calls.filter(([, request]) => request?.method === 'POST').at(-1)![1]!;
      keyByAttempt.push(new Headers(post.headers).get('Idempotency-Key') || '');
    }
    expect(keyByAttempt.every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(keyByAttempt[0]).toBe(keyByAttempt[1]);
    expect(new Set([keyByAttempt[0], ...keyByAttempt.slice(2)]).size).toBe(5);
    const polls = fetch.mock.calls.filter(([, request]) => request?.method === 'GET');
    expect(polls).toHaveLength(attempts.length);
    expect(polls.every(([, request]) => !new Headers(request!.headers).has('Idempotency-Key'))).toBe(true);
    expect(fetch.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(attempts.length);
  });

  it('does not add a retry after an idempotent submission is rejected', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Fixture upstream rejection' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const requestRoute = route(headerConfig);
    const prepared = await prepareRouteImageAdapterRequest(provider, input([]), requestRoute);
    await expect(generatePreparedImageAdapterImages(provider, { apiKey: 'fixture-only', headers: {} }, input([]), prepared!, requestRoute, { wait: async () => {} })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('Idempotency-Key')).toMatch(/^[a-f0-9]{64}$/);
  });
});

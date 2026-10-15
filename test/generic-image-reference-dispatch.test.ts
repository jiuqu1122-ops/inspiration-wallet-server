import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNewApiImageGenerationBody, generatePreparedImageAdapterImages, prepareRouteImageAdapterRequest, resolveNewApiImageModel } from '../src/modules/ai/image-service.js';
import { defaultModelCapabilities, normalizePublicModelCapabilities } from '../src/modules/ai/model-catalog.js';

const provider = { id: 'image-channel', name: 'Fixture', kind: 'NEW_API', baseUrl: 'https://provider.example', capabilities: ['IMAGE'] };
const references = ['https://assets.example/reference-a.png', 'https://assets.example/reference-b.png'];
const capabilities = { supportedQualities: ['low', 'high'], qualityParameter: 'render_quality', supportsImageEdit: true };
const input = { userId: 'owner', clientRequestId: 'new-image-request', model: 'gpt-image-2.5', prompt: 'change the handle',
  inputImages: references, aspectRatio: '16:9', resolution: '2k', outputFormat: 'jpg' as const, count: 1,
  imageCapabilities: capabilities, quality: 'high' };
const route = { adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: { referenceSerializer: 'json_images' },
  executionMode: 'TASK', executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}' },
  requestedCanonicalModel: 'gpt-image-2.5', resolvedCanonicalModel: 'gpt-image-2.5', canonicalModelId: 'model',
  canonicalModelKey: 'gpt-image-2.5', routeId: 'route', channelId: provider.id, upstreamModel: input.model };

afterEach(() => { vi.restoreAllMocks(); });

describe('generic Images API reference contract at TASK dispatch', () => {
  it.each([
    ['/v1/images/edits', { referenceSerializer: 'json_images' }, references, { images: references }],
    ['/custom/image-edits', { referenceSerializer: 'json_image', editEndpoint: '/custom/image-edits' }, references.slice(0, 1), { image: references[0] }],
    ['/v1/images/edits', { referenceSerializer: 'object_image_url' }, references, { images: references.map(image_url => ({ image_url })) }],
  ])('submits native reference editing to its prepared %s endpoint', async (endpoint, adapterConfig, inputImages, referenceBody) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const requestInput = { ...input, inputImages };
    const requestRoute = { ...route, adapterConfig };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, requestInput, requestRoute as never);
    expect(prepared?.endpoint).toBe(endpoint);
    const request = vi.fn(async (_endpoint: string, body?: unknown) => body === undefined
      ? { task_id: 'accepted-task', status: 'success', data: [{ url: 'https://cdn.example/result.png' }] }
      : { task_id: 'accepted-task', status: 'processing' });
    expect(await generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} }, requestInput, prepared!, requestRoute as never,
      { request, wait: async () => {} })).toEqual(['https://cdn.example/result.png']);
    expect(request.mock.calls[0]![0]).toBe(endpoint);
    expect(request.mock.calls[0]![1]).toMatchObject({ model: input.model, render_quality: 'high', ...referenceBody });
    expect(request.mock.calls[1]![0]).toBe('/v1/images/tasks/accepted-task');
    expect(request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
  });

  it.each([capabilities, undefined])('preserves an independent unified task endpoint with reference images (%j)', async imageCapabilities => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const requestInput = { ...input, imageCapabilities };
    const requestRoute = { ...route, executionConfig: { ...route.executionConfig, submitEndpoint: '/tasks/submit' } };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, requestInput, requestRoute as never);
    expect(prepared?.endpoint).toBe('/v1/images/edits');
    const request = vi.fn(async (_path: string, body?: unknown) => body === undefined
      ? { task_id: 'accepted-task', status: 'success', data: [{ url: 'https://cdn.example/result.png' }] }
      : { task_id: 'accepted-task', status: 'processing' });
    expect(await generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} }, requestInput, prepared!, requestRoute as never,
      { request, wait: async () => {} })).toEqual(['https://cdn.example/result.png']);
    expect(request.mock.calls[0]![0]).toBe('/tasks/submit');
    expect(request.mock.calls[0]![1]).toMatchObject({ model: input.model, images: references });
    expect(request.mock.calls[1]![0]).toBe('/v1/images/tasks/accepted-task');
    expect(request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
  });

  it.each([
    { inputImages: references, expectedEndpoint: '/custom/images/edits' },
    { inputImages: [], expectedEndpoint: '/custom/images/generations' },
  ])('matches a custom ordinary generation endpoint before selecting $expectedEndpoint', async ({ inputImages, expectedEndpoint }) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const requestInput = { ...input, inputImages };
    const requestRoute = { ...route,
      adapterConfig: { referenceSerializer: 'json_images', generationEndpoint: '/custom/images/generations', editEndpoint: '/custom/images/edits' },
      executionConfig: { ...route.executionConfig, submitEndpoint: '/custom/images/generations' } };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, requestInput, requestRoute as never);
    const request = vi.fn(async (_path: string, _body?: unknown) => ({ task_id: 'accepted-task', status: 'success', data: [{ url: 'https://cdn.example/result.png' }] }));
    await generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} }, requestInput, prepared!, requestRoute as never, { request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(expectedEndpoint);
    if (inputImages.length) expect(request.mock.calls[0]![1]).toMatchObject({ images: references });
    else expect(request.mock.calls[0]![1]).not.toHaveProperty('images');
  });

  it('keeps explicitly configured generation-with-references on the task submit contract', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const requestInput = { ...input, imageCapabilities: { ...capabilities, supportsImageEdit: false } };
    const requestRoute = { ...route, executionConfig: { ...route.executionConfig, submitEndpoint: '/custom/async/generations' } };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, requestInput, requestRoute as never);
    expect(prepared?.endpoint).toBe('/v1/images/generations');
    const request = vi.fn(async (_path: string, _body?: unknown) => ({ task_id: 'accepted-task', status: 'success', data: [{ url: 'https://cdn.example/result.png' }] }));
    await generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} }, requestInput, prepared!, requestRoute as never, { request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('/custom/async/generations');
    expect(request.mock.calls[0]![1]).toMatchObject({ images: references, render_quality: 'high' });
  });

  it('keeps text generation on its configured task endpoint and omits unsupported quality', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const requestInput = { ...input, inputImages: [], imageCapabilities: {} };
    const requestRoute = { ...route, executionConfig: { ...route.executionConfig, submitEndpoint: '/custom/async/generations' } };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, requestInput, requestRoute as never);
    const request = vi.fn(async (_path: string, _body?: unknown) => ({ task_id: 'accepted-task', status: 'success', data: [{ url: 'https://cdn.example/result.png' }] }));
    await generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} }, requestInput, prepared!, requestRoute as never, { request });
    expect(request.mock.calls[0]![0]).toBe('/custom/async/generations');
    expect(request.mock.calls[0]![1]).toMatchObject({ model: 'gpt-image-2.5' });
    for (const key of ['image', 'images', 'quality', 'render_quality']) expect(request.mock.calls[0]![1]).not.toHaveProperty(key);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails before dispatch when references have no explicit serializer', async () => {
    await expect(prepareRouteImageAdapterRequest(provider as never, input, { ...route, adapterConfig: {} } as never))
      .rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_EDIT_UNSUPPORTED', endpoint: '/v1/images/edits' });
  });
});

describe('existing Image 2.5 text-generation quality contracts', () => {
  it('distinguishes a legacy caller without capabilities from a configured model without a quality declaration', () => {
    const request = { ...input, inputImages: [], imageCapabilities: undefined };
    const withoutCatalog = buildNewApiImageGenerationBody(request, [], false, 'NEW_API');
    expect(withoutCatalog).toMatchObject({ model: 'gpt-image-2.5', quality: 'medium', size: '2048x1152' });
    const rawCatalogCapabilities = defaultModelCapabilities('gpt-image-2.5', 'image');
    expect(rawCatalogCapabilities).not.toHaveProperty('supportedQualities');
    expect(normalizePublicModelCapabilities(rawCatalogCapabilities)).not.toHaveProperty('supportedQualities');
    // executeWalletImageGeneration supplies this raw catalog JSON. Do not
    // mistake the legacy helper's absent-capability fixture for that path.
    for (const imageCapabilities of [rawCatalogCapabilities, {}, { supportedQualities: [] }]) {
      const configured = buildNewApiImageGenerationBody({ ...request, imageCapabilities }, [], false, 'NEW_API');
      expect(configured).toMatchObject({ model: 'gpt-image-2.5', size: '2048x1152' });
      expect(configured).not.toHaveProperty('quality');
    }
  });

  it('sends configured qualities using their configured key and retains each exact upstream SKU', () => {
    for (const model of ['gpt-image-2.5', 'gpt-image-2.5-high']) {
      expect(resolveNewApiImageModel(model)).toBe(model);
      for (const qualityParameter of ['quality', 'render_quality']) {
        const body = buildNewApiImageGenerationBody({ ...input, model, inputImages: [],
          imageCapabilities: { supportedQualities: ['high'], qualityParameter } }, [], false, 'NEW_API');
        expect(body).toMatchObject({ model, [qualityParameter]: 'high', size: '2048x1152' });
        if (qualityParameter !== 'quality') expect(body).not.toHaveProperty('quality');
      }
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
const resultUrl = 'https://cdn.example/final.png';
const provider = { id: 'channel', kind: 'NEW_API', baseUrl: 'https://provider.example', capabilities: ['IMAGE'] };
const input = { userId: 'owner', clientRequestId: 'fresh-image-request', model: 'gpt-image-2.5',
  prompt: 'fixture', inputImages: [] as string[], aspectRatio: '1:1', outputFormat: 'png' as const, count: 1 };
const prepared = { adapterKey: 'GENERIC_OPENAI_IMAGE', execution: 'images-api', submittedModel: input.model,
  endpoint: '/v1/images/generations', method: 'POST', contentType: 'application/json', body: { model: input.model, prompt: input.prompt } };
const route = { adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: {}, executionMode: 'TASK',
  executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}' },
  upstreamModel: input.model };

function generateFixture(profile: 'GENERIC_TASK' | 'USELG_IMAGE_TASK', payload: unknown, overrides: Partial<typeof input> & { imageCapabilities?: unknown } = {}) {
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (body === undefined) throw new Error('Unexpected read after a final submit response');
    return payload;
  });
  const onTaskSubmitted = vi.fn();
  const promise = generatePreparedImageAdapterImages({ ...provider, kind: profile === 'USELG_IMAGE_TASK' ? 'USELG' : 'NEW_API' } as never,
    { apiKey: 'fixture', headers: {} }, { ...input, ...overrides }, prepared as never,
    { ...route, executionConfig: { ...route.executionConfig, profile } } as never,
    { request, onTaskSubmitted, wait: async () => {} });
  return { request, onTaskSubmitted, promise };
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each(['GENERIC_TASK', 'USELG_IMAGE_TASK'] as const)('%s submissions returning final OpenAI images without receipts', profile => {
  const generate = (payload: unknown, overrides: Partial<typeof input> & { imageCapabilities?: unknown } = {}) => generateFixture(profile, payload, overrides);
  it.each([
    { created: 1792020000, data: [{ url: resultUrl }] },
    { status: 'completed', data: [{ url: resultUrl }] },
    { state: 'success', data: [{ url: resultUrl }] },
    { data: [{ b64_json: png }] },
    { data: [{ b64_json: png, url: resultUrl }] },
    { data: [{ url: `data:image/png;base64,${png}` }] },
  ])('delivers a final response without registering an empty task receipt (%j)', async payload => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const test = generate(payload);
    const descriptor = payload.data[0]!;
    await expect(test.promise).resolves.toEqual([
      'b64_json' in descriptor ? `data:image/png;base64,${png}` : descriptor.url,
    ]);
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls[0]![0]).toBe('/v1/images/generations');
    expect(test.request.mock.calls[0]![1]).toMatchObject(prepared.body);
    expect(test.onTaskSubmitted).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[image_adapter_submit_completed]', expect.objectContaining({
      hasTaskId: false, hasStatusUrl: false, status: 'success', assetCount: 1,
    }));
  });

  it.each([
    { count: 2, imageCapabilities: undefined, expected: 2 },
    { count: 1, imageCapabilities: { outputMode: 'multiple_assets', maxOutputImages: 4 }, expected: 4 },
  ])('keeps descriptor aliases unique within the configured output limit ($expected)', async ({ count, imageCapabilities, expected }) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/result-${index}.png`);
    const data = [{ b64_json: png, url: resultUrl }, { url: resultUrl }, ...urls.map(url => ({ url }))];
    const test = generate({ data, prompt: 'https://unrelated.example/input.png', metadata: { url: 'https://unrelated.example/debug.png' } }, { count, imageCapabilities });
    await expect(test.promise).resolves.toEqual([`data:image/png;base64,${png}`, ...urls].slice(0, expected));
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.onTaskSubmitted).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'a textual response',
    {},
    { data: [] },
    { data: ['a textual response'] },
    { data: [{ text: resultUrl }] },
    { data: [{ url: 'https://' }] },
    { data: [{ url: 'data:image/png;base64,' }] },
    { data: [{ b64_json: '' }] },
    { data: [{ b64_json: 'plain text' }] },
    { error: { message: 'render failed' }, data: [{ url: resultUrl }] },
    { errors: ['render failed'], data: [{ url: resultUrl }] },
    { data: [{ url: resultUrl, errors: ['render failed'] }] },
    { status: 'failed', data: [{ url: resultUrl }] },
    { status: 'processing', data: [{ url: resultUrl }] },
    { status: 'pending', data: [{ url: resultUrl }] },
    { status: 'unrecognized', data: [{ url: resultUrl }] },
    { status: 'success', state: 'processing', data: [{ url: resultUrl }] },
    { data: [{ url: resultUrl, status: 'pending' }] },
    { statusUrl: '/tasks/accepted', data: [{ url: resultUrl }] },
    { result_url: '/tasks/accepted/result', data: [{ url: resultUrl }] },
  ])('does not treat a nonfinal or invalid receipt-free response as success (%j)', async payload => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = generate(payload);
    await expect(test.promise).rejects.toThrow();
    expect(test.request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
  });

  it.each([
    { task_id: 'accepted-task', status: 'success', data: [{ url: resultUrl }] },
    { status_url: '/tasks/accepted-task', status: 'success', data: [{ url: resultUrl }] },
  ])('keeps explicit async receipts on the existing task registration path (%j)', async payload => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const test = generate(payload);
    await expect(test.promise).resolves.toEqual([resultUrl]);
    expect(test.onTaskSubmitted).toHaveBeenCalledTimes(1);
    expect(test.request).toHaveBeenCalledTimes(1);
  });

});

describe('prepared adapter async flags and task execution defaults', () => {
  it.each([
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations', parameters: {}, expected: { async: false } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations', parameters: { asyncParameterName: null, asyncParameterValue: null }, expected: { async: false } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/edits', parameters: {}, expected: { async: false } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations', parameters: { asyncParameterName: 'async', asyncParameterValue: true }, expected: { async: true } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations', parameters: { asyncParameterValue: true }, expected: { async: true } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations', parameters: { asyncParameterName: 'run_async', asyncParameterValue: true }, expected: { run_async: true } },
    { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', parameters: {}, expected: { async: false } },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/custom/image-tasks', parameters: {}, expected: { async: false } },
  ])('retains explicit flags before defaults for $profile $submitEndpoint ($parameters)', async ({ profile, submitEndpoint, parameters, expected }) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const request = vi.fn(async (_path: string, _body?: unknown) => ({ data: [{ url: resultUrl }] }));
    await expect(generatePreparedImageAdapterImages({ ...provider, kind: profile === 'USELG_IMAGE_TASK' ? 'USELG' : 'NEW_API' } as never,
      { apiKey: 'fixture', headers: {} }, input, { ...prepared, body: { ...prepared.body, async: false } } as never,
      { ...route, adapterConfig: { async: false }, executionConfig: { ...route.executionConfig, profile, submitEndpoint, ...parameters } } as never,
      { request })).resolves.toEqual([resultUrl]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toEqual({ ...prepared.body, ...expected });
  });
});

describe.each(['GENERIC_TASK', 'USELG_IMAGE_TASK'] as const)('%s contracts for existing models outside Image 2.5', profile => {
  const existingModels = ['gpt-image-2', 'gpt-image-1', 'gemini-3-pro-image-preview', 'midjourney-v7'];
  const modelFixture = (model: string) => ({
    provider: { ...provider, kind: profile === 'USELG_IMAGE_TASK' ? 'USELG' : 'NEW_API' },
    input: { ...input, model },
    prepared: { ...prepared, submittedModel: model, body: { model, prompt: input.prompt } },
    route: { ...route, upstreamModel: model, canonicalModelKey: model,
      executionConfig: { ...route.executionConfig, profile } },
  });

  it.each(existingModels)('keeps %s submission parameters and one-POST task delivery unchanged', async model => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = modelFixture(model);
    const request = vi.fn(async (_path: string, body?: unknown, _timeoutMs?: number) => body === undefined
      ? { task_id: 'existing-task', status: 'success', data: [{ url: resultUrl }] }
      : { task_id: 'existing-task', status: 'processing' });
    const onTaskSubmitted = vi.fn();
    await expect(generatePreparedImageAdapterImages(fixture.provider as never,
      { apiKey: 'fixture', headers: {} }, fixture.input, fixture.prepared as never, fixture.route as never,
      { request, onTaskSubmitted, wait: async () => {} })).resolves.toEqual([resultUrl]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(expect.arrayContaining([
      '/v1/images/generations', { model, prompt: input.prompt }, 60_000,
    ]));
    expect(request.mock.calls[0]![1]).not.toHaveProperty('async');
    expect(request.mock.calls[1]![0]).toBe('/tasks/existing-task');
    expect(request.mock.calls[1]![1]).toBeUndefined();
    expect(request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
    expect(onTaskSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskId: 'existing-task' }));
  });

  it.each([...existingModels, 'seedream-4.5'])('keeps the prior receipt requirement for a final %s response', async model => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = modelFixture(model);
    const request = vi.fn(async (_path: string, _body?: unknown) => ({ data: [{ url: resultUrl }] }));
    const onTaskSubmitted = vi.fn();
    await expect(generatePreparedImageAdapterImages(fixture.provider as never,
      { apiKey: 'fixture', headers: {} }, fixture.input, fixture.prepared as never, fixture.route as never,
      { request, onTaskSubmitted })).rejects.toThrow('TASK submit response contained neither task_id nor status_url');
    expect(request).toHaveBeenCalledTimes(1);
    expect(onTaskSubmitted).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])('retains Seedream protocol async=true over the prior prepared async=%s flag', async async => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = modelFixture('seedream-4.5');
    const body = { ...fixture.prepared.body, ...(async === undefined ? {} : { async }) };
    const request = vi.fn(async (_path: string, submittedBody?: unknown) => submittedBody === undefined
      ? { task_id: 'seedream-task', status: 'success', data: [{ url: resultUrl }] }
      : { task_id: 'seedream-task', status: 'processing' });
    await expect(generatePreparedImageAdapterImages(fixture.provider as never,
      { apiKey: 'fixture', headers: {} }, fixture.input, { ...fixture.prepared, body } as never, fixture.route as never,
      { request, wait: async () => {} })).resolves.toEqual([resultUrl]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![1]).toEqual({ ...fixture.prepared.body, async: true });
    expect(request.mock.calls[1]![0]).toBe('/tasks/seedream-task');
    expect(request.mock.calls[1]![1]).toBeUndefined();
    expect(request.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(1);
  });
});

it('keeps the legacy Generic task ID extraction for an existing non-Image-2.5 model', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const model = 'gpt-image-2';
  const request = vi.fn(async (_path: string, body?: unknown) => body === undefined
    ? { task_id: 'legacy-task', status: 'success', data: [{ url: resultUrl }] }
    : { data: 'legacy-task', status: 'processing', status_url: '/tasks/legacy-task' });
  const onTaskSubmitted = vi.fn();
  await expect(generatePreparedImageAdapterImages(provider as never, { apiKey: 'fixture', headers: {} },
    { ...input, model }, { ...prepared, submittedModel: model, body: { ...prepared.body, model } } as never,
    { ...route, upstreamModel: model, canonicalModelKey: model } as never,
    { request, onTaskSubmitted, wait: async () => {} })).resolves.toEqual([resultUrl]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![0]).toBe('/tasks/legacy-task');
  expect(onTaskSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskId: 'legacy-task' }));
});

import { describe, expect, it, vi } from 'vitest';
import { normalizeModelCapabilities, normalizePublicModelCapabilities } from '../src/modules/ai/model-catalog.js';
import { getImageModelAdapter, prepareImageAdapterRequest } from '../src/modules/ai/image-adapters/registry.js';
import { imageResultLimit } from '../src/modules/ai/image-capabilities.js';
import { calculateSnapshotCharge, validatePricingProfile, type PricingSnapshot } from '../src/modules/ai/pricing-center.js';
import { generatePreparedImageAdapterImages, boundProviderImageResults } from '../src/modules/ai/image-service.js';
import { updatePricingPolicy } from '../src/modules/ai/model-admin.js';

const capabilities = { supportedQualities: ['low', 'high', 'max'], qualityParameter: 'render_quality', outputMode: 'multiple_assets', maxOutputImages: 4, billingMode: 'per_request' };
const input = { requestedCanonicalModel: 'arbitrary-model', resolvedCanonicalModel: 'arbitrary-model', canonicalModelId: 'model-id', canonicalModelKey: 'arbitrary-model', routeId: 'route', channelId: 'channel', upstreamModel: 'vendor-v8.2', prompt: 'Landscape', references: [], resolution: '2k', aspectRatio: '1:1', count: 1, outputFormat: 'png' as const, capabilities, quality: 'high' };
const snapshot = (request = {}): PricingSnapshot => ({ schemaVersion: 1, canonicalModelId: 'model-id', canonicalModelKey: 'arbitrary-model', modality: 'image', routeId: 'route', priceVersionId: 'price', priceVersion: 1, billingType: 'image_resolution', pricing: { billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '10' }, creditsPerImageByResolutionQuality: { '2k': { high: '20', max: '40' } } }, request: { resolution: '2k', count: 4, ...request }, capturedAt: '' });

describe('capability configuration through request and billing', () => {
  it('keeps quality procurement costs in markup suggestions and charges the published quality price', async () => {
    const upsert = vi.fn(async (input: any) => input);
    const prisma = { aiModel: { findUnique: vi.fn(async () => ({ id: 'quality-model', modality: 'image', routes: [{ enabled: true, costProfile: { currency: 'CNY', cnyPerImageByResolution: { '2k': '0.1', '4k': '0.2' }, cnyPerImageByResolutionQuality: { '2k': { high: '0.3', max: '0.4' } } } }] })) }, aiModelPricing: { upsert } };
    await updatePricingPolicy(prisma as never, 'arbitrary-image', { pricingMode: 'MARKUP', markupMultiplier: '2' });
    const policy = upsert.mock.calls[0]![0];
    expect(policy.update.suggestedPrice).toMatchObject({ creditsPerImageByResolutionQuality: { '2k': { high: '60', max: '80' } } });
    expect(calculateSnapshotCharge({ ...snapshot({ quality: 'high', billingMode: 'per_request' }), pricing: policy.update.suggestedPrice }).totalCredits).toBe('60.000000');
  });
  it('normalizes configured qualities and projects them without model-name inference', () => {
    const stored = normalizeModelCapabilities({ ...capabilities, supportedQualities: ['high', 'high', 'max'] });
    expect(normalizePublicModelCapabilities(stored)).toMatchObject({ supportedQualities: ['high', 'max'], qualityParameter: 'render_quality', outputMode: 'multiple_assets', maxOutputImages: 4, billingMode: 'per_request' });
    expect(() => normalizeModelCapabilities({ supportedQualities: ['high'], qualityParameter: 'model' })).toThrow();
  });
  it('sends the configured quality key and omits quality for an unsupported model', () => {
    const adapter = getImageModelAdapter('GENERIC_OPENAI_IMAGE');
    expect(prepareImageAdapterRequest(adapter, input)?.body).toMatchObject({ model: 'vendor-v8.2', render_quality: 'high' });
    const body = prepareImageAdapterRequest(adapter, { ...input, capabilities: {} })?.body;
    expect(body).not.toHaveProperty('quality');
    expect(body).not.toHaveProperty('render_quality');
    expect(() => prepareImageAdapterRequest(adapter, { ...input, quality: 'unsupported' })).toThrow();
  });
  it('matches resolution and quality first, falls back to legacy prices, and charges a request once', () => {
    expect(calculateSnapshotCharge(snapshot({ quality: 'high', billingMode: 'per_request' }), { generatedCount: 4 }).totalCredits).toBe('20.000000');
    expect(calculateSnapshotCharge(snapshot({ quality: 'max', billingMode: 'per_image' }), { generatedCount: 4 }).totalCredits).toBe('160.000000');
    expect(calculateSnapshotCharge(snapshot()).totalCredits).toBe('40.000000');
    expect(() => validatePricingProfile('image', { ...snapshot().pricing, creditsPerImageByResolutionQuality: { '2k': { high: '-1' } } })).toThrow();
  });
  it('retains four assets from one generic request even when n is one', async () => {
    const prepared = prepareImageAdapterRequest(getImageModelAdapter('GENERIC_OPENAI_IMAGE'), input)!;
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example.com/result-${index}.png`);
    const request = vi.fn(async () => ({ assets: urls.map(url => ({ type: 'image', url })) }));
    const images = await generatePreparedImageAdapterImages({ id: 'channel', kind: 'NEW_API', baseUrl: 'https://example.com' } as never, { apiKey: 'test', headers: {} }, { userId: 'user', clientRequestId: 'request-id', model: input.upstreamModel, prompt: input.prompt, inputImages: [], aspectRatio: '1:1', outputFormat: 'png', count: 1, imageCapabilities: capabilities }, prepared, { ...input, upstreamModel: input.upstreamModel, adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: {}, executionMode: 'DIRECT' } as never, { request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(boundProviderImageResults(images, imageResultLimit(capabilities, 1))).toEqual(urls);
  });
  it('binds a final OpenAI image payload to the accepted GET even when it has an internal task_id', async () => {
    const prepared = prepareImageAdapterRequest(getImageModelAdapter('GENERIC_OPENAI_IMAGE'), input)!;
    const data = Array.from({ length: 4 }, (_, index) => ({
      b64_json: Buffer.from(`fixture-image-${index}`).toString('base64'), output_format: 'png',
      url: `https://cdn.example.com/result-${index}.png`,
    }));
    const request = vi.fn(async (_path: string, body?: unknown) => body === undefined
      ? { created: 1791998040, task_id: '677c22c20a86413ea819a04d8cdebbe3', data }
      : { task_id: 'imgtask-accepted', status: 'processing', status_url: '/v1/images/tasks/imgtask-accepted' });
    const images = await generatePreparedImageAdapterImages({ id: 'channel', kind: 'NEW_API', baseUrl: 'https://example.com' } as never,
      { apiKey: 'test', headers: {} },
      { userId: 'user', clientRequestId: 'request-id', model: input.upstreamModel, prompt: input.prompt, inputImages: [], aspectRatio: '1:1', outputFormat: 'png', count: 1, imageCapabilities: capabilities },
      prepared, { ...input, upstreamModel: input.upstreamModel, adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: {}, executionMode: 'TASK',
        executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/v1/images/tasks/{taskId}' } } as never,
      { request, wait: async () => {} });
    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[0]![1] as Record<string, unknown>).n ?? 1).toBe(1);
    expect(request.mock.calls[1]![0]).toBe('/v1/images/tasks/imgtask-accepted');
    expect(request.mock.calls[1]![1]).toBeUndefined();
    expect(images).toEqual(data.map(image => `data:image/png;base64,${image.b64_json}`));
  });
});

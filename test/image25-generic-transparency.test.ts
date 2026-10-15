import { describe, expect, it } from 'vitest';
import { getImageModelAdapter, prepareImageAdapterRequest, type ImageAdapterInput } from '../src/modules/ai/image-adapters/registry.js';

const input: ImageAdapterInput = {
  requestedCanonicalModel: 'gpt-image-2-5-sunburst', resolvedCanonicalModel: 'gpt-image-2-5-sunburst',
  canonicalModelId: 'image25', canonicalModelKey: 'gpt-image-2-5-sunburst', routeId: 'route', channelId: 'channel',
  upstreamModel: 'gpt-image-2.5-sunburst', prompt: 'a transparent product cutout', references: [],
  resolution: '2k', aspectRatio: '16:9', count: 1, outputFormat: 'png', background: 'transparent',
  capabilities: { supportsTransparentBackground: true },
};
const reference = 'https://assets.example/reference.png';
const prepare = (overrides: Partial<ImageAdapterInput> = {}) => prepareImageAdapterRequest(
  getImageModelAdapter('GENERIC_OPENAI_IMAGE'), { ...input, ...overrides },
)!;

describe('explicit native transparent PNG on the generic Image 2.5 adapter', () => {
  it('forwards native transparency on text generation without changing the route SKU or prompt', () => {
    const prepared = prepare();
    expect(prepared.endpoint).toBe('/v1/images/generations');
    expect(prepared.body).toEqual({ model: input.upstreamModel, prompt: input.prompt,
      output_format: 'png', background: 'transparent' });
  });

  it.each([
    { referenceSerializer: 'json_image', expected: { image: reference } },
    { referenceSerializer: 'json_images', expected: { images: [reference] } },
    { referenceSerializer: 'object_image_url', expected: { images: [{ image_url: reference }] } },
  ])('forwards native transparency without changing the $referenceSerializer edit contract', ({ referenceSerializer, expected }) => {
    const prepared = prepare({ references: [reference], adapterConfig: { referenceSerializer } });
    expect(prepared.endpoint).toBe('/v1/images/edits');
    expect(prepared.body).toEqual({ model: input.upstreamModel, prompt: input.prompt,
      ...expected, output_format: 'png', background: 'transparent' });
    expect(prepared.contentType).toBe('application/json');
  });

  it('supports an opaque upstream SKU identified by its canonical Image 2.5 model', () => {
    expect(prepare({ upstreamModel: 'opaque-upstream-sku' }).body).toMatchObject({
      model: 'opaque-upstream-sku', output_format: 'png', background: 'transparent',
    });
  });

  it('recognizes an explicit upstream Image 2.5 SKU behind a canonical alias', () => {
    expect(prepare({ canonicalModelKey: 'opaque-canonical' }).body)
      .toMatchObject({ output_format: 'png', background: 'transparent' });
  });

  it('preserves generation-with-references when native editing is explicitly disabled', () => {
    const prepared = prepare({ references: [reference], capabilities: { supportsTransparentBackground: true, supportsImageEdit: false },
      adapterConfig: { referenceSerializer: 'json_images' } });
    expect(prepared.endpoint).toBe('/v1/images/generations');
    expect(prepared.body).toMatchObject({ images: [reference], output_format: 'png', background: 'transparent' });
  });

  it.each([
    { capabilities: {} },
    { capabilities: { supportsTransparentBackground: false } },
    { capabilities: { supportsTransparentBackground: 'true' } },
    { outputFormat: 'jpg' as const },
  ])('retains the existing payload outside an explicitly supported transparent PNG request: %j', (overrides) => {
    expect(prepare(overrides).body).toEqual({ model: input.upstreamModel, prompt: input.prompt });
  });

  it('does not infer a transparent background solely from the PNG format', () => {
    const request = { ...input };
    delete request.background;
    expect(prepareImageAdapterRequest(getImageModelAdapter('GENERIC_OPENAI_IMAGE'), request)?.body)
      .toEqual({ model: input.upstreamModel, prompt: input.prompt });
  });

  it.each(['gpt-image-2', 'gpt-image-1', 'nano-banana-2', 'midjourney-v7', 'seedream-4.5'])('keeps the %s generic payload unchanged', (model) => {
    expect(prepare({ canonicalModelKey: model, upstreamModel: model }).body)
      .toEqual({ model, prompt: input.prompt });
  });
});

import { describe, expect, it } from 'vitest';
import {
  getImageModelAdapter,
  prepareImageAdapterRequest,
  type ImageAdapterInput,
} from '../src/modules/ai/image-adapters/registry.js';

const input = (overrides: Partial<ImageAdapterInput> = {}): ImageAdapterInput => ({
  requestedCanonicalModel: 'seedream-5',
  resolvedCanonicalModel: 'seedream-5',
  canonicalModelId: 'canonical-seedream-5',
  canonicalModelKey: 'seedream-5',
  routeId: 'route-seedream-5',
  channelId: 'channel-images',
  upstreamModel: 'seedream-5.0-pro',
  prompt: 'A red apple on a white table',
  references: [],
  resolution: '2K',
  aspectRatio: '16:9',
  count: 1,
  outputFormat: 'png',
  ...overrides,
});

describe('image adapter registry', () => {
  it('keeps null and explicit LEGACY routes on the real legacy execution path', () => {
    expect(getImageModelAdapter(null)).toMatchObject({ key: 'LEGACY', execution: 'legacy' });
    expect(getImageModelAdapter('LEGACY')).toMatchObject({ key: 'LEGACY', execution: 'legacy' });
  });

  it('wraps the existing GPT Image and Nano Banana paths without rebuilding their payloads', () => {
    const gpt = getImageModelAdapter('GPT_IMAGE');
    const banana = getImageModelAdapter('NANO_BANANA');
    expect(prepareImageAdapterRequest(gpt, input({ upstreamModel: 'gpt-image-2.5' }))).toBeNull();
    expect(prepareImageAdapterRequest(banana, input({ upstreamModel: 'gemini-3.1-flash-image' }))).toBeNull();
  });

  it('rejects an explicit adapter that clearly conflicts with the route model', () => {
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('GPT_IMAGE'),
      input({ upstreamModel: 'seedream-5.0-pro' }),
    )).toThrowError(expect.objectContaining({ code: 'IMAGE_ADAPTER_MODEL_MISMATCH' }));
  });

  it('builds the minimal Seedream generation payload without Banana or GPT fields', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input(),
    );
    expect(prepared).toEqual({
      adapterKey: 'SEEDREAM_IMAGES_API',
      execution: 'images-api',
      submittedModel: 'seedream-5.0-pro',
      endpoint: '/v1/images/generations',
      method: 'POST',
      contentType: 'application/json',
      body: {
        model: 'seedream-5.0-pro',
        prompt: 'A red apple on a white table',
      },
      asyncMode: 'provider',
    });
    expect(prepared?.body).not.toHaveProperty('quality');
    expect(prepared?.body).not.toHaveProperty('output_resolution');
    expect(prepared?.body).not.toHaveProperty('image_size');
    expect(prepared?.body).not.toHaveProperty('size');
  });

  it('sends only the explicitly configured Seedream resolution and ratio fields', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input({
        count: 2,
        adapterConfig: {
          resolutionParameter: 'size',
          resolutionValueMode: 'label',
          aspectRatioParameter: 'aspect_ratio',
          async: true,
        },
      }),
    );
    expect(prepared?.body).toEqual({
      model: 'seedream-5.0-pro',
      prompt: 'A red apple on a white table',
      n: 2,
      size: '2K',
      aspect_ratio: '16:9',
      async: true,
    });
    expect(prepared?.body).not.toHaveProperty('resolution');
    expect(prepared?.body).not.toHaveProperty('output_resolution');
    expect(prepared?.body).not.toHaveProperty('image_size');
    expect(JSON.stringify(prepared?.body)).not.toContain('1792x1024');
    expect(JSON.stringify(prepared?.body)).not.toContain('2048x1152');
  });

  it('builds Gemini Native generateContent with the exact route SKU and image config', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('GEMINI_NATIVE_IMAGE'),
      input({
        requestedCanonicalModel: 'nano-banana-2',
        resolvedCanonicalModel: 'nano-banana-2',
        canonicalModelId: 'canonical-nano-banana-2',
        canonicalModelKey: 'nano-banana-2',
        routeId: 'route-gemini-native',
        upstreamModel: 'gemini-3.1-flash-image',
        references: ['data:image/webp;base64,UklGRgAAAAA='],
        resolution: '4k',
        aspectRatio: '16:9',
      }),
    );

    expect(prepared).toEqual({
      adapterKey: 'GEMINI_NATIVE_IMAGE',
      execution: 'gemini-native',
      submittedModel: 'gemini-3.1-flash-image',
      endpoint: '/v1beta/models/gemini-3.1-flash-image:generateContent',
      method: 'POST',
      contentType: 'application/json',
      body: {
        contents: [{
          role: 'user',
          parts: [
            { text: 'A red apple on a white table' },
            { inlineData: { mimeType: 'image/webp', data: 'UklGRgAAAAA=' } },
          ],
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
        },
      },
      asyncMode: 'provider',
    });
    expect(prepared?.body).not.toHaveProperty('model');
    expect(prepared?.body).not.toHaveProperty('prompt');
    expect(prepared?.body).not.toHaveProperty('size');
    expect(prepared?.body).not.toHaveProperty('quality');
    expect(prepared?.body).not.toHaveProperty('output_resolution');
    expect(prepared?.body).not.toHaveProperty('image_size');
    expect(prepared?.body).not.toHaveProperty('aspect_ratio');
  });

  it('uses exact dimensions only when the route supplies an exact mapping', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input({
        adapterConfig: {
          resolutionParameter: 'resolution',
          resolutionValueMode: 'exact',
          exactDimensions: { '2K': { '16:9': '1672x941' } },
        },
      }),
    );
    expect(prepared?.body).toMatchObject({ resolution: '1672x941' });
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input({
        adapterConfig: {
          resolutionParameter: 'resolution',
          resolutionValueMode: 'exact',
        },
      }),
    )).toThrowError(expect.objectContaining({ code: 'IMAGE_ADAPTER_CONFIG_INVALID' }));
  });

  it('chooses Seedream edits for references and fails explicitly without a serializer', () => {
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input({ references: ['https://assets.example/reference.png'] }),
    )).toThrowError(expect.objectContaining({
      code: 'PROVIDER_REFERENCE_EDIT_UNSUPPORTED',
      endpoint: '/v1/images/edits',
    }));
  });

  it('uses an explicitly configured Seedream JSON reference serializer', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('SEEDREAM_IMAGES_API'),
      input({
        references: ['https://assets.example/reference.png'],
        adapterConfig: { referenceSerializer: 'json_image' },
      }),
    );
    expect(prepared?.endpoint).toBe('/v1/images/edits');
    expect(prepared?.body).toMatchObject({ image: 'https://assets.example/reference.png' });
  });

  it('keeps the Grok edit-named SKU on images/generations with its exact route model', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('GROK_IMAGES_API'),
      input({
        requestedCanonicalModel: 'grok-image',
        resolvedCanonicalModel: 'grok-image',
        canonicalModelId: 'canonical-grok',
        canonicalModelKey: 'grok-image',
        routeId: 'route-grok',
        upstreamModel: 'grok-imagine-image-edit',
      }),
    );
    expect(prepared?.endpoint).toBe('/v1/images/generations');
    expect(prepared?.body).toEqual({
      model: 'grok-imagine-image-edit',
      prompt: 'A red apple on a white table',
    });
    expect(prepared?.body).not.toHaveProperty('quality');
    expect(prepared?.body).not.toHaveProperty('size');
    expect(prepared?.body).not.toHaveProperty('output_resolution');
  });

  it('rejects unapproved adapter config fields such as quality', () => {
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('GROK_IMAGES_API'),
      input({
        requestedCanonicalModel: 'grok-image',
        resolvedCanonicalModel: 'grok-image',
        upstreamModel: 'grok-imagine-image-edit',
        adapterConfig: { quality: 'high' },
      }),
    )).toThrowError(expect.objectContaining({ code: 'IMAGE_ADAPTER_CONFIG_INVALID' }));
  });

  it('adds Grok resolution fields only when its own route config opts in', () => {
    const prepared = prepareImageAdapterRequest(
      getImageModelAdapter('GROK_IMAGES_API'),
      input({
        requestedCanonicalModel: 'grok-image',
        resolvedCanonicalModel: 'grok-image',
        upstreamModel: 'grok-imagine-image-edit',
        adapterConfig: {
          resolutionParameter: 'resolution',
          resolutionValueMode: 'label',
          aspectRatioParameter: 'aspect_ratio',
        },
      }),
    );
    expect(prepared?.body).toMatchObject({ resolution: '2K', aspect_ratio: '16:9' });
    expect(prepared?.body).not.toHaveProperty('size');
    expect(prepared?.body).not.toHaveProperty('output_resolution');
    expect(prepared?.body).not.toHaveProperty('image_size');
  });

  it('does not silently drop Grok references or change the upstream SKU', () => {
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('GROK_IMAGES_API'),
      input({
        requestedCanonicalModel: 'grok-image',
        resolvedCanonicalModel: 'grok-image',
        upstreamModel: 'grok-imagine-image-edit',
        references: ['https://assets.example/reference.png'],
      }),
    )).toThrowError(expect.objectContaining({
      code: 'PROVIDER_REFERENCE_EDIT_UNSUPPORTED',
      endpoint: '/v1/images/generations',
    }));
  });

  it('stops before dispatch when canonical or upstream identity changes', () => {
    expect(() => prepareImageAdapterRequest(
      getImageModelAdapter('GROK_IMAGES_API'),
      input({
        requestedCanonicalModel: 'canonical-a',
        resolvedCanonicalModel: 'canonical-b',
        upstreamModel: 'grok-imagine-image-edit',
      }),
    )).toThrowError(expect.objectContaining({ code: 'IMAGE_MODEL_IDENTITY_MISMATCH' }));

    const maliciousAdapter = {
      key: 'GROK_IMAGES_API' as const,
      execution: 'images-api' as const,
      buildRequest: () => ({
        adapterKey: 'GROK_IMAGES_API' as const,
        execution: 'images-api' as const,
        submittedModel: 'grok-imagine-image-edit',
        endpoint: '/v1/images/generations',
        method: 'POST' as const,
        contentType: 'application/json' as const,
        body: { model: 'another-upstream-sku', prompt: 'test' },
        asyncMode: 'provider' as const,
      }),
    };
    expect(() => prepareImageAdapterRequest(
      maliciousAdapter,
      input({
        requestedCanonicalModel: 'grok-image',
        resolvedCanonicalModel: 'grok-image',
        upstreamModel: 'grok-imagine-image-edit',
      }),
    )).toThrowError(expect.objectContaining({ code: 'IMAGE_MODEL_IDENTITY_MISMATCH' }));
  });
});

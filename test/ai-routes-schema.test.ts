import { describe, expect, it } from 'vitest';
import { normalizeImageRequestBody, normalizeVideoRequestBody } from '../src/modules/ai/routes.js';

describe('wallet AI request compatibility', () => {
  it('accepts null optional image fields sent by older desktop clients', () => {
    expect(normalizeImageRequestBody({
      clientRequestId: 'canvas-image-request-1',
      provider: 'new-api',
      model: 'gemini-3-pro-image',
      prompt: 'render a projector',
      negativePrompt: null,
      inputImages: [],
      aspectRatio: '16:9',
      resolution: '2k',
      outputFormat: 'jpg',
      count: 1,
    })).toMatchObject({
      provider: 'new-api',
      negativePrompt: undefined,
      resolution: '2k',
    });
  });

  it('accepts null optional video fields sent by older desktop clients', () => {
    expect(normalizeVideoRequestBody({
      clientRequestId: 'canvas-video-request-1',
      provider: 'new-api',
      model: 'seedance-1.5-pro',
      prompt: 'orbit camera',
      inputImages: [],
      aspectRatio: '16:9',
      resolution: null,
      duration: null,
      inputMode: null,
      count: 1,
    })).toMatchObject({
      resolution: undefined,
      duration: undefined,
      inputMode: undefined,
    });
  });

  it('accepts up to nine NewAPI image references', () => {
    const request = {
      clientRequestId: 'canvas-image-request-9refs',
      provider: 'new-api' as const,
      model: 'gemini-3-pro-image',
      prompt: 'combine the references',
      inputImages: Array.from({ length: 9 }, (_, index) => `https://example.test/${index}.png`),
      aspectRatio: '16:9' as const,
      resolution: '4k',
      outputFormat: 'jpg' as const,
      count: 1,
    };
    expect(normalizeImageRequestBody(request).inputImages).toHaveLength(9);
    expect(() => normalizeImageRequestBody({
      ...request,
      inputImages: [...request.inputImages, 'https://example.test/10.png'],
    })).toThrow();
  });
});

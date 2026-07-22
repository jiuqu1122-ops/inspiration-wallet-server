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

  it('accepts the NewAPI maximum of nine image references', () => {
    expect(normalizeImageRequestBody({
      clientRequestId: 'canvas-image-request-nine',
      provider: 'new-api',
      model: 'gemini-3-pro-image',
      prompt: 'combine the references',
      inputImages: Array.from({ length: 9 }, (_, index) => `data:image/png;base64,aGVsbG8${index}=`),
      aspectRatio: '1:1',
      outputFormat: 'png',
      count: 1,
    }).inputImages).toHaveLength(9);
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
});

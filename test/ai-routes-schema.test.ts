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
      background: 'transparent',
      count: 1,
    })).toMatchObject({
      provider: 'new-api',
      negativePrompt: undefined,
      resolution: '2k',
      background: 'transparent',
    });
  });

  it('accepts Bigmodel as a wallet image provider', () => {
    expect(normalizeImageRequestBody({
      clientRequestId: 'canvas-image-request-bigmodel',
      provider: 'bigmodel',
      model: 'gemini-3-pro-image-preview',
      prompt: 'render a projector',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '1k',
      outputFormat: 'png',
      count: 1,
    })).toMatchObject({ provider: 'bigmodel', model: 'gemini-3-pro-image-preview', resolution: '1k' });
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
      inputVideos: [],
      inputAudios: [],
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

  it('accepts Seedance omni reference categories', () => {
    const normalized = normalizeVideoRequestBody({
      clientRequestId: 'canvas-video-request-omni',
      provider: 'new-api',
      model: 'SourceMix2.0',
      prompt: 'use all references',
      inputImages: Array.from({ length: 9 }, (_, index) => `https://example.com/image-${index}.png`),
      inputVideos: Array.from({ length: 3 }, (_, index) => `https://example.com/video-${index}.mp4`),
      inputAudios: Array.from({ length: 3 }, (_, index) => `https://example.com/audio-${index}.mp3`),
      count: 1,
    });
    expect(normalized.inputImages).toHaveLength(9);
    expect(normalized.inputVideos).toHaveLength(3);
    expect(normalized.inputAudios).toHaveLength(3);
  });

  it('accepts Mikoto Seedance with its 9/3/3 reference limits', () => {
    const normalized = normalizeVideoRequestBody({
      clientRequestId: 'canvas-video-request-mikoto',
      provider: 'mikoto',
      model: 'seedance2fast',
      prompt: 'use all references',
      inputImages: Array.from({ length: 9 }, (_, index) => `https://example.com/image-${index}.png`),
      inputVideos: Array.from({ length: 3 }, (_, index) => `https://example.com/video-${index}.mp4`),
      inputAudios: Array.from({ length: 3 }, (_, index) => `https://example.com/audio-${index}.mp3`),
      resolution: '480p',
      duration: 4,
      count: 1,
    });
    expect(normalized.provider).toBe('mikoto');
    expect(normalized.inputImages).toHaveLength(9);
    expect(normalized.inputVideos).toHaveLength(3);
    expect(normalized.inputAudios).toHaveLength(3);
  });

  it('keeps the legacy thirteen-image limit for non-Seedance XAIS video models', () => {
    const normalized = normalizeVideoRequestBody({
      clientRequestId: 'canvas-video-request-legacy-xais',
      provider: 'xais-chat',
      model: 'legacy-video-model',
      prompt: 'use the references',
      inputImages: Array.from({ length: 13 }, (_, index) => `https://example.com/image-${index}.png`),
      count: 1,
    });
    expect(normalized.inputImages).toHaveLength(13);
  });

  it('rejects more than nine images for every Seedance 2.0 alias', () => {
    expect(() => normalizeVideoRequestBody({
      clientRequestId: 'canvas-video-request-seedance-limit',
      provider: 'new-api',
      model: 'seedance2.0',
      prompt: 'use the references',
      inputImages: Array.from({ length: 10 }, (_, index) => `https://example.com/image-${index}.png`),
      count: 1,
    })).toThrow();
  });
});

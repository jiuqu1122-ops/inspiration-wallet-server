import { describe, expect, it } from 'vitest';
import {
  buildGeminiNativeImageBody,
  chooseProviderForCapability,
  collectProviderModelIds,
  imageUnitCredits,
  isGeminiNativeImageModel,
  isRetryableXaisPollError,
  materializeNewApiReferenceImage,
  newApiImageRequestParams,
  parseXaisTaskId,
  resolveImageModel,
  resolveNewApiImageModel,
  resolveXaisModel,
  resolveXaisWorkerRatio,
  sizeFromRatio,
  uniqueImages,
} from '../src/modules/ai/image-service.js';

describe('wallet image provider normalization', () => {
  it('extracts the image channel model IDs returned by /v1/models', () => {
    expect(collectProviderModelIds({
      data: [
        { id: 'gemini-3-pro-image' },
        { id: 'gemini-3.1-flash-image' },
        { id: 'gemini-3-pro-image' },
        { id: '' },
      ],
    })).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
  });

  it('prefers the dedicated IMAGE channel over an LLM channel with legacy broad capabilities', () => {
    const llm = { name: 'codex', capabilities: ['LLM', 'IMAGE', 'VIDEO'] as const };
    const image = { name: 'newapi-image', capabilities: ['IMAGE'] as const };
    expect(chooseProviderForCapability([llm, image], 'IMAGE')).toBe(image);
    expect(chooseProviderForCapability([llm], 'IMAGE')).toBeUndefined();
  });

  it('keeps channel selection independent from the client provider label', () => {
    const xais = { name: 'xais-image', capabilities: ['IMAGE'] as const };
    const newApi = { name: 'newapi-image', capabilities: ['IMAGE'] as const };
    expect(chooseProviderForCapability([newApi, xais], 'IMAGE')).toBe(newApi);
    expect(chooseProviderForCapability([xais, newApi], 'IMAGE')).toBe(xais);
  });

  it('uses the client-selected image model and keeps the manager model as fallback', () => {
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, 'gemini-3.1-flash-image'))
      .toBe('gemini-3.1-flash-image');
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, ''))
      .toBe('gemini-3-pro-image');
    expect(() => resolveImageModel({ kind: 'NEW_API', defaultModel: null }, ''))
      .toThrow('生图请求和渠道都没有配置模型');
  });

  it('maps the main app image aliases back to NewAPI model IDs', () => {
    expect(resolveNewApiImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image');
    expect(resolveNewApiImageModel('google/gemini_3_pro_image_preview')).toBe('gemini-3-pro-image');
    expect(resolveNewApiImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image');
    expect(resolveNewApiImageModel('Gemini31FlashImage')).toBe('gemini-3.1-flash-image');
    expect(resolveNewApiImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveNewApiImageModel('「Hu」gpt-image-2')).toBe('「Hu」gpt-image-2');
    expect(resolveNewApiImageModel('「CS」gpt-image-2')).toBe('「CS」gpt-image-2');
    expect(resolveNewApiImageModel('「Rim」gemini-3-pro-image-preview')).toBe('「Rim」gemini-3-pro-image-preview');
    expect(resolveNewApiImageModel('custom-image-model')).toBe('custom-image-model');
  });

  it('extracts URL and Base64 image results while excluding reference inputs', () => {
    const reference = 'https://assets.example.test/reference.png';
    const images = uniqueImages({
      data: [
        { url: reference },
        { url: 'https://assets.example.test/output.png' },
        { b64_json: 'aGVsbG8=' },
      ],
    }, [reference], 4);

    expect(images).toEqual([
      'https://assets.example.test/output.png',
      'data:image/png;base64,aGVsbG8=',
    ]);
  });

  it('maps canvas XAIS display models to worker request models', () => {
    expect(resolveXaisModel('Xais Nano Pro_2K')).toBe('Nano_Banana_Pro_2K_0');
    expect(resolveXaisModel('Nano Banana Pro 4K')).toBe('Nano_Banana_Pro_4K_0');
    expect(resolveXaisModel('Xais Image2 2K High Quality')).toBe('Xais_Img2_2K_H');
    expect(resolveXaisModel('custom-model')).toBe('custom-model');
  });

  it('maps UI aspect ratios to the exact XAIS worker dimensions', () => {
    expect(resolveXaisWorkerRatio('Xais Img2_2K', '16:9')).toBe('2048x1152');
    expect(resolveXaisWorkerRatio('Xais Img2_4K', '9:16')).toBe('2160x3840');
    expect(resolveXaisWorkerRatio('Xais Nano Pro_2K', '16:9')).toBe('16:9');
  });

  it('keeps existing data URL references unchanged', async () => {
    const source = 'data:image/png;base64,aGVsbG8=';
    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(source);
  });

  it('uses stable OpenAI-compatible dimensions for supported ratios', () => {
    expect(sizeFromRatio('1:1')).toBe('1024x1024');
    expect(sizeFromRatio('16:9')).toBe('1792x1024');
    expect(sizeFromRatio('9:16')).toBe('1024x1792');
  });

  it('prices unified image families by clarity without depending on the provider', () => {
    expect(imageUnitCredits('gemini-3-pro-image', '2K')).toBe(18n);
    expect(imageUnitCredits('Xais Nano Pro_4K', '2K')).toBe(20n);
    expect(imageUnitCredits('gemini-3.1-flash-image', '2K')).toBe(15n);
    expect(imageUnitCredits('Xais Nano2_4K', '2K')).toBe(18n);
    expect(imageUnitCredits('gpt-image-2', '1K')).toBe(10n);
    expect(imageUnitCredits('Image2_2K', '4K')).toBe(15n);
    expect(imageUnitCredits('Xais Img2_4K', '2K')).toBe(18n);
    expect(imageUnitCredits('Xais Img2_2K(高画质)', '4K')).toBe(30n);
    expect(imageUnitCredits('Xais_Img2_4K_H', '2K')).toBe(35n);
  });

  it('extracts Gemini inline_data image results', () => {
    expect(uniqueImages({
      choices: [{
        message: {
          content: [{ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }],
        },
      }],
    }, [], 1)).toEqual(['data:image/png;base64,aGVsbG8=']);
  });

  it('extracts raw image Base64 returned in result fields', () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    expect(uniqueImages({ output: [{ result: rawPng }] }, [], 1))
      .toEqual([`data:image/png;base64,${rawPng}`]);
  });

  it('accepts XAIS task IDs returned as plain text or nested results', () => {
    expect(parseXaisTaskId('task-plain-123')).toBe('task-plain-123');
    expect(parseXaisTaskId({ results: [{ taskid: 456789 }] })).toBe('456789');
  });

  it('keeps polling an XAIS task after transient transport failures', () => {
    expect(isRetryableXaisPollError(new Error('This operation was aborted'))).toBe(true);
    expect(isRetryableXaisPollError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isRetryableXaisPollError(new Error('provided image is not valid'))).toBe(false);
  });

  it('matches the main app NewAPI image dimensions and quality', () => {
    expect(newApiImageRequestParams('gemini-3-pro-image', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '1920x1088',
      aspect_ratio: '16:9',
      ratio: '16:9',
      quality: 'standard',
    });
    expect(newApiImageRequestParams('gemini-3.1-flash-image', 2, '9:16', '4K')).toEqual({
      n: 2,
      size: '2160x3840',
      aspect_ratio: '9:16',
      ratio: '9:16',
      quality: 'high',
    });
  });

  it('identifies Gemini image models that must use the native endpoint', () => {
    expect(isGeminiNativeImageModel('gemini-3-pro-image')).toBe(true);
    expect(isGeminiNativeImageModel('Nano Banana 2')).toBe(true);
    expect(isGeminiNativeImageModel('gpt-image-2')).toBe(false);
  });

  it('builds Gemini native inline image parts without file paths or remote URLs', () => {
    const body = buildGeminiNativeImageBody({
      userId: 'user-1',
      clientRequestId: 'request-1',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      inputImages: ['data:image/png;base64,aGVsbG8='],
      aspectRatio: '16:9',
      resolution: '4K',
      outputFormat: 'jpg',
      count: 1,
    });

    expect(body.contents[0]?.parts).toEqual([
      { text: expect.stringContaining('render the projector') },
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ]);
    expect(body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
    });
  });
});

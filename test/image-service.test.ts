import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  buildNewApiImageGenerationBody,
  chooseProviderForCapability,
  collectGeneratedVideoStrings,
  collectProviderModelIds,
  confirmXaisReferenceAttachment,
  convertGptImage2ChromaKeyToTransparentPng,
  filterProviderImageModels,
  generateBigmodelBananaImages,
  generateMikotoBananaImages,
  generateNewApiImages,
  getWalletImageGenerationByRequest,
  imageCapabilityForModel,
  imageUnitCredits,
  isNewApiGeminiImageDecodeError,
  isNewApiParamOverrideCopyError,
  isPublicNewApiImageReference,
  isRetryableXaisPollError,
  materializeNewApiReferenceImage,
  mirrorGeneratedImageResults,
  mirrorGeneratedVideoResponse,
  mirrorXaisImageResults,
  newApiImageRequestParams,
  parseWalletImageGenerationResult,
  parseXaisTaskId,
  providerSupportsImageModel,
  resolveBigmodelImageModel,
  resolveImageModel,
  resolveMikotoImageModel,
  mikotoKlingModelCandidates,
  mikotoSoraV3ProVideoBody,
  mikotoSeedanceModelCandidates,
  resolveMikotoKlingModel,
  resolveMikotoSeedanceModel,
  resolveMikotoVideoModel,
  resolveNewApiImageModel,
  resolveNewApiImageResponse,
  resolveXaisModel,
  resolveXaisWorkerRatio,
  runXaisWorkerTask,
  sizeFromRatio,
  stageXaisPublicReference,
  uniqueImages,
  xaisAttachmentRegistrationUrls,
} from '../src/modules/ai/image-service.js';
import { getImageResult } from '../src/modules/ai/image-result-store.js';

describe('Mikoto Seedance model mapping', () => {
  it('maps the two client models to Mikoto resolution-specific model ids', () => {
    expect(resolveMikotoSeedanceModel('seedance2', '1080p')).toBe('seedance-2.0-1080p');
    expect(resolveMikotoSeedanceModel('seedance2', '720p')).toBe('seedance-2.0-720p');
    expect(resolveMikotoSeedanceModel('seedance2fast', '480p')).toBe('seedance-fast-480p');
    expect(resolveMikotoSeedanceModel('seedance2fast', '720p')).toBe('seedance-fast-720p');
  });

  it('maps canvas Kling names to Mikoto model ids', () => {
    expect(resolveMikotoKlingModel('kling-video')).toBe('kling-v2.6-pro-t2v');
    expect(resolveMikotoKlingModel('kling-omni-video')).toBe('kling-o1-text-to-video');
    expect(resolveMikotoKlingModel('kling-o1-standard')).toBe('kling-o1-standard');
    expect(resolveMikotoVideoModel('kling-video', '1080p')).toBe('kling-v2.6-pro-t2v');
    expect(resolveMikotoVideoModel('kling-omni-video', '720p')).toBe('kling-o1-text-to-video');
  });

  it('prefers a configured Kling model and filters discovered models by family', () => {
    expect(mikotoKlingModelCandidates({
      model: 'kling-omni-video', inputImages: [],
    } as never, 'kling-o1-image-to-video', [
      'seedance-2.0',
      'kling-v2.6-pro-t2v',
      'kling-o1-standard',
    ])).toEqual([
      'kling-o1-image-to-video',
      'kling-o1-text-to-video',
      'kling-o1-standard',
      'kling-omni-video',
    ]);
  });

  it('prefers a matching channel model and keeps fallback aliases in order', () => {
    expect(mikotoSeedanceModelCandidates({
      model: 'seedance2', resolution: '720p',
    } as never, 'seedance-2.0')).toEqual([
      'seedance-2.0',
      'seedance-2.0-720p',
      'seedance2',
      'sora-v3-pro',
    ]);
    expect(mikotoSeedanceModelCandidates({
      model: 'seedance2fast', resolution: '480p',
    } as never, 'seedance-2.0')).toEqual([
      'seedance-fast-480p',
      'seedance-2.0-fast',
      'seedance2fast',
    ]);
  });

  it('uses a configured Mikoto Sora V3 Pro channel only for Seedance 2.0 at 720p', () => {
    const base = {
      model: 'seedance2', resolution: '720p',
      inputImages: [], inputVideos: [], inputAudios: [],
    } as never;
    expect(mikotoSeedanceModelCandidates(base, 'sora-v3-pro')[0]).toBe('sora-v3-pro');
    expect(mikotoSeedanceModelCandidates({ ...base, resolution: '1080p' }, 'sora-v3-pro'))
      .not.toContain('sora-v3-pro');
    expect(mikotoSeedanceModelCandidates({ ...base, model: 'seedance2fast' }, 'sora-v3-pro'))
      .not.toContain('sora-v3-pro');
  });

  it('adapts Seedance references to the Mikoto Sora V3 Pro contract', () => {
    expect(mikotoSoraV3ProVideoBody({
      model: 'seedance2', prompt: 'product camera move', duration: 10,
      aspectRatio: '16:9', resolution: '720p', inputMode: 'REF',
      inputImages: ['https://media.example/main.jpg', 'https://media.example/ref.jpg'],
      inputVideos: ['https://media.example/move.mp4'],
      inputAudios: ['https://media.example/music.mp3'],
    } as never)).toEqual({
      model: 'sora-v3-pro',
      prompt: 'product camera move',
      seconds: '10',
      aspect_ratio: '16:9',
      resolution: '720p',
      image_url: 'https://media.example/main.jpg',
      reference_image_urls: ['https://media.example/ref.jpg'],
      reference_video: 'https://media.example/move.mp4',
      audio_url: 'https://media.example/music.mp3',
      video_config: { reference_mode: 'auto' },
    });
  });

  it('extracts generated video results without treating reference media as outputs', () => {
    expect(collectGeneratedVideoStrings({
      data: {
        status: 'succeeded',
        video_url: 'https://media.example/output.mp4?token=1',
        images: ['https://media.example/reference.png'],
        referenceVideos: ['https://media.example/reference.mp4'],
      },
    })).toEqual(['https://media.example/output.mp4?token=1']);
  });

  it('places mirrored video URLs before the upstream response', async () => {
    const upstream = { data: { status: 'succeeded', video_url: 'https://media.example/output.mp4' } };
    const mirror = vi.fn(async () => 'https://api.unmind.art/v1/ai/video-results/stable.mp4');
    await expect(mirrorGeneratedVideoResponse(upstream, 'Mikoto', mirror)).resolves.toEqual({
      walletVideoResults: ['https://api.unmind.art/v1/ai/video-results/stable.mp4'],
      upstream,
    });
    expect(mirror).toHaveBeenCalledWith('https://media.example/output.mp4');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet image provider normalization', () => {
  it('allows image generation jobs to run for fifteen minutes', () => {
    expect(IMAGE_GENERATION_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it('accepts only complete persisted wallet image results', () => {
    expect(parseWalletImageGenerationResult({
      images: ['https://api.unmind.art/v1/ai/image-results/result.png'],
      provider: 'NEW_API',
      providerChannelId: 'channel-1',
      providerChannelName: 'primary',
      model: 'gpt-image-2',
      chargedCredits: '18',
    })).toMatchObject({
      images: ['https://api.unmind.art/v1/ai/image-results/result.png'],
      chargedCredits: '18',
    });
    expect(parseWalletImageGenerationResult({
      images: [],
      provider: 'NEW_API',
    })).toBeNull();
  });

  it('looks up a persisted image result only inside the current user account', async () => {
    const findUnique = vi.fn(async () => ({
      capability: 'IMAGE',
      status: 'SUCCEEDED',
      completedAt: new Date(1_725_000_000_000),
      result: {
        images: ['https://api.unmind.art/v1/ai/image-results/result.png'],
        provider: 'NEW_API',
        providerChannelId: 'channel-1',
        providerChannelName: 'primary',
        model: 'gpt-image-2',
        chargedCredits: '18',
      },
    }));
    const result = await getWalletImageGenerationByRequest({
      aiRequest: { findUnique },
    } as never, 'user-1', 'canvas-request-1');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId_clientRequestId: {
          userId: 'user-1',
          clientRequestId: 'canvas-request-1',
        },
      },
    }));
    expect(result).toMatchObject({
      status: 'succeeded',
      completedAt: 1_725_000_000_000,
      images: ['https://api.unmind.art/v1/ai/image-results/result.png'],
    });
  });

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

  it('separates Nano Banana and GPT Image provider capabilities', () => {
    const nano = { capabilities: ['IMAGE_NANO_BANANA'] as const };
    const nano2 = { capabilities: ['IMAGE_NANO_BANANA_2'] as const };
    const gpt = { capabilities: ['IMAGE_GPT'] as const };
    const legacy = { capabilities: ['IMAGE'] as const };

    expect(imageCapabilityForModel('gemini-3-pro-image')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('Xais Nano Pro_2K')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('gemini-3.1-flash-image')).toBe('IMAGE_NANO_BANANA_2');
    expect(imageCapabilityForModel('Nano Banana 2')).toBe('IMAGE_NANO_BANANA_2');
    expect(imageCapabilityForModel('gpt-image-2')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('Image2_4K')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('Image2_1K')).toBe('IMAGE_GPT_1K');
    expect(providerSupportsImageModel(nano, 'gpt-image-2')).toBe(false);
    expect(providerSupportsImageModel(nano, 'Nano Banana 2')).toBe(false);
    expect(providerSupportsImageModel(nano2, 'Nano Banana 2')).toBe(true);
    expect(providerSupportsImageModel(gpt, 'gemini-3.1-flash-image')).toBe(false);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'Image2_1K')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'Image2_4K')).toBe(false);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'gpt-image-2', '1k')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'gpt-image-2', '2k')).toBe(false);
    expect(providerSupportsImageModel(legacy, 'custom-image-model')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_NANO_BANANA_PRO_1K'] as const }, 'gemini-3-pro-image-preview')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_NANO_BANANA_PRO_1K'] as const }, 'gemini-3-pro-image-preview', '2k')).toBe(false);
    expect(filterProviderImageModels(nano, [
      'gemini-3-pro-image',
      'gemini-2.5-pro',
      'gpt-image-2',
    ])).toEqual(['gemini-3-pro-image']);
  });

  it('uses the client-selected image model and keeps the manager model as fallback', () => {
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, 'gemini-3.1-flash-image'))
      .toBe('gemini-3.1-flash-image');
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, ''))
      .toBe('gemini-3-pro-image');
    expect(() => resolveImageModel({ kind: 'NEW_API', defaultModel: null }, ''))
      .toThrow('生图请求和渠道都没有配置模型');
  });

  it('normalizes Bigmodel aliases to the native model IDs', () => {
    expect(resolveBigmodelImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image-preview');
    expect(resolveBigmodelImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveImageModel({ kind: 'BIGMODEL', defaultModel: 'Nano Banana Pro' }, '')).toBe('gemini-3-pro-image-preview');
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

  it('calls Bigmodel native Gemini with the API-key header and image config', async () => {
    const generated = 'iVBORw0KGgo' + 'a'.repeat(40);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://bigmodel.example/v1beta/models/gemini-3-pro-image-preview:generateContent');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('sk-test');
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.responseModalities).toEqual(['IMAGE']);
      expect(body.generationConfig.responseFormat.image).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateBigmodelBananaImages(
      { baseUrl: 'https://bigmodel.example', name: 'Bigmodel', kind: 'BIGMODEL' } as never,
      { apiKey: 'sk-test', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-1', model: 'gemini-3-pro-image-preview', prompt: 'a red apple',
        inputImages: [], aspectRatio: '16:9', resolution: '1k', outputFormat: 'png', count: 1,
      },
    );
    expect(result).toEqual([`data:image/png;base64,${generated}`]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls Mikoto Gemini native endpoint with imageConfig', async () => {
    const generated = 'iVBORw0KGgo' + 'b'.repeat(40);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.mikoto.example/v1beta/models/gemini-3-pro-image-preview:generateContent');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('sk-mikoto');
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateMikotoBananaImages(
      { baseUrl: 'https://api.mikoto.example', name: 'Mikoto', kind: 'MIKOTO' } as never,
      { apiKey: 'sk-mikoto', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-mikoto', model: 'Nano Banana Pro', prompt: 'a red apple',
        inputImages: [], aspectRatio: '1:1', resolution: '1k', outputFormat: 'jpg', count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${generated}`]);
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
    expect(resolveXaisModel('Xais img2_1k')).toBe('Xais img2_1k');
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

  it('keeps compatibility with image content types outside the legacy magic-byte list', async () => {
    const source = 'https://1.1.1.1/reference-compatible.svg';
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
    })));

    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(
      `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    );
  });

  it('retries transient non-image Cloudflare responses and cleans the staged file', async () => {
    const source = 'https://1.1.1.1/reference-retry.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>cloudflare tunnel not ready</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(png, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const staged = await stageXaisPublicReference(source, async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(staged.mime).toBe('image/png');
    expect(staged.size).toBe(png.byteLength);
    expect(await readFile(staged.path)).toEqual(png);

    await staged.cleanup();
    await expect(access(staged.path)).rejects.toThrow();
  });

  it('rejects a repeatedly truncated public reference without retaining a temp file', async () => {
    const source = 'https://1.1.1.1/reference-truncated.png';
    const pngPrefix = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(pngPrefix, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(pngPrefix.byteLength + 1024),
      },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stageXaisPublicReference(source, async () => {}))
      .rejects.toThrow('content-length mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses stable OpenAI-compatible dimensions for supported ratios', () => {
    expect(sizeFromRatio('1:1')).toBe('1024x1024');
    expect(sizeFromRatio('16:9')).toBe('1792x1024');
    expect(sizeFromRatio('9:16')).toBe('1024x1792');
  });

  it('prices unified image families by clarity without depending on the provider', () => {
    expect(imageUnitCredits('gemini-3-pro-image', '2K')).toBe(18n);
    expect(imageUnitCredits('Xais Nano Pro_4K', '2K')).toBe(18n);
    expect(imageUnitCredits('gemini-3.1-flash-image', '2K')).toBe(15n);
    expect(imageUnitCredits('Xais Nano2_4K', '2K')).toBe(15n);
    expect(imageUnitCredits('gpt-image-2', '1K')).toBe(10n);
    expect(imageUnitCredits('Image2_2K', '4K')).toBe(18n);
    expect(imageUnitCredits('Xais Img2_4K', '2K')).toBe(15n);
    expect(imageUnitCredits('Xais Img2_2K(高画质)', '4K')).toBe(35n);
    expect(imageUnitCredits('Xais_Img2_4K_H', '2K')).toBe(30n);
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

  it('keeps an XAIS image when a stale unknown-error field accompanies the result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-unknown-error' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        error: 'unknown error',
        result: { url: 'https://xais.example.test/output.png' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-unknown-error',
        clientRequestId: 'request-unknown-error',
        model: 'Xais Nano Pro_2K',
        prompt: 'return the generated image',
        inputImages: [],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/output.png');
  });

  it('replaces XAIS result URLs with stable mirrored result URLs', async () => {
    const mirror = vi.fn(async (_source: string, index: number) => (
      `https://api.unmind.art/v1/ai/image-results/mirrored-${index + 1}.png`
    ));

    await expect(mirrorXaisImageResults([
      'https://xais.example.test/one.png',
      'https://xais.example.test/two.png',
    ], 'xais-primary', mirror)).resolves.toEqual([
      'https://api.unmind.art/v1/ai/image-results/mirrored-1.png',
      'https://api.unmind.art/v1/ai/image-results/mirrored-2.png',
    ]);
    expect(mirror).toHaveBeenCalledTimes(2);
  });

  it('falls back to the XAIS source URL when result mirroring fails', async () => {
    const source = 'https://xais.example.test/result.png';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mirror = vi.fn(async () => { throw new Error('OSS unavailable'); });

    await expect(mirrorXaisImageResults([source], 'xais-primary', mirror))
      .resolves.toEqual([source]);
    expect(warn).toHaveBeenCalledWith(
      '[xais_image_result_mirror_failed]',
      expect.objectContaining({ provider: 'xais-primary', index: 0 }),
    );
    warn.mockRestore();
  });

  it('normalizes Mikoto Gemini aliases to its native model IDs', () => {
    expect(resolveMikotoImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image-preview');
    expect(resolveMikotoImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image-preview');
    expect(resolveMikotoImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveImageModel({ kind: 'MIKOTO', defaultModel: 'Nano Banana Pro' }, '')).toBe('gemini-3-pro-image-preview');
  });

  it('mirrors inline and stable image results for every non-XAIS image channel', async () => {
    const mirror = vi.fn(async (source: string, index: number) => (
      `https://api.unmind.art/v1/ai/image-results/mirrored-${index + 1}.png?source=${encodeURIComponent(source.slice(0, 12))}`
    ));
    const inline = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const stable = 'https://api.unmind.art/v1/ai/image-results/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
    const publicUrl = 'https://bigmodel.example/generated.png';

    await expect(mirrorGeneratedImageResults([inline, stable, publicUrl], 'Bigmodel', mirror))
      .resolves.toHaveLength(3);
    expect(mirror).toHaveBeenCalledTimes(3);
  });

  it('resolves a completed XAIS image directly from its task ID when the wait response is stale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-stale-wait' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { url: 'https://xais.example.test/completed-from-task-id.png' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-stale-wait',
        clientRequestId: 'request-stale-wait',
        model: 'Xais Nano Pro_2K',
        prompt: 'return the completed image without waiting for stale task state',
        inputImages: [],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/completed-from-task-id.png');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://provider.example/xais/workerTaskStart',
      'https://provider.example/xais/workerTaskWait?json=1&id=task-stale-wait',
      'https://provider.example/xais/attUrls?att=task-stale-wait',
    ]);
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

  it('matches the upstream NewAPI image request parameters', () => {
    expect(newApiImageRequestParams('gemini-3-pro-image', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
    });
    expect(newApiImageRequestParams('gemini-3.1-flash-image', 2, '9:16', '4K')).toEqual({
      n: 2,
      size: '2160x3840',
      aspect_ratio: '9:16',
      output_resolution: '4K',
      image_size: '4K',
    });
    expect(newApiImageRequestParams('gpt-image-2', 1, '16:9', '1K')).toEqual({
      n: 1,
      size: '1280x720',
      aspect_ratio: '16:9',
      quality: 'medium',
    });
    expect(newApiImageRequestParams('gpt-image-2', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      aspect_ratio: '16:9',
      quality: 'medium',
    });
  });

  it('keeps NewAPI image references on the public URL path', () => {
    expect(isPublicNewApiImageReference('https://assets.example.test/reference.png')).toBe(true);
    expect(isPublicNewApiImageReference('data:image/png;base64,aGVsbG8=')).toBe(false);
    expect(isPublicNewApiImageReference('C:\\cache\\reference.png')).toBe(false);
  });

  it('only accepts XAIS attachment registrations that resolve an image URL', () => {
    expect(xaisAttachmentRegistrationUrls({ data: { url: 'https://xais.example.test/reference.png' } }))
      .toEqual(['https://xais.example.test/reference.png']);
    expect(xaisAttachmentRegistrationUrls({ success: true, data: {} })).toEqual([]);
  });

  it('retries XAIS attachment registration and rejects an unresolved attachment', async () => {
    const provider = { baseUrl: 'https://provider.example' } as Parameters<typeof confirmXaisReferenceAttachment>[0];
    const secrets = { apiKey: 'test-key', headers: {} };
    const noWait = async () => {};
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporary unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { url: 'https://xais.example.test/reference.png' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmXaisReferenceAttachment(provider, secrets, 'h2/reference.png', noWait))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(confirmXaisReferenceAttachment(provider, secrets, 'h2/missing.png', noWait))
      .rejects.toThrow('XAIS reference attachment registration failed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('starts an XAIS task with the confirmed attachment name in ref', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://1.1.1.1/upload',
        name: 'h2/reference.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/reference.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/output.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-1',
        model: 'Xais Nano Pro_2K',
        prompt: 'keep the reference product shape',
        inputImages: ['data:image/png;base64,aGVsbG8='],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/output.png');

    const taskStartCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/xais/workerTaskStart'));
    expect(taskStartCall).toBeDefined();
    expect(JSON.parse(String(taskStartCall?.[1]?.body))).toMatchObject({
      ref: ['h2/reference.png'],
    });
  });

  it('keeps legacy public image references working through the XAIS attachment flow', async () => {
    const reference = 'https://1.1.1.1/legacy-reference.svg';
    const referenceBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    let uploadedBytes = Buffer.alloc(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://1.1.1.1/upload',
        name: 'legacy/reference.jpg',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockImplementationOnce(async (_url, init) => {
        uploadedBytes = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response('', { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/reference.jpg',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/output.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-legacy',
        clientRequestId: 'request-legacy-public-reference',
        model: 'Xais Nano Pro_2K',
        prompt: 'keep the reference product shape',
        inputImages: [reference],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/output.png');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(reference);
    expect(uploadedBytes).toEqual(referenceBytes);
  });

  it('recognizes a broken NewAPI channel parameter override', () => {
    expect(isNewApiParamOverrideCopyError(
      new Error('status_code=500, operation copy failed: source path does not exist: input.0.content.0.text'),
    )).toBe(true);
    expect(isNewApiParamOverrideCopyError(new Error('reference image HTTP 404'))).toBe(false);
    expect(isNewApiGeminiImageDecodeError(
      'gemini-3.1-flash-image',
      new Error('Bad request to gemini-flash: Failed to decode image data. Please make sure the image is valid.'),
    )).toBe(true);
    expect(isNewApiGeminiImageDecodeError(
      'gpt-image-2',
      new Error('Failed to decode image data'),
    )).toBe(false);
  });

  it('builds NewAPI image fields with reference and exact aspect-ratio size', () => {
    const reference = 'https://example.trycloudflare.com/reference.png';
    const body = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-1',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      inputImages: [reference],
      aspectRatio: '16:9',
      resolution: '2K',
      outputFormat: 'jpg',
      count: 1,
    }, [reference]);

    expect(body).toMatchObject({
      model: 'gemini-3-pro-image',
      prompt: expect.stringContaining('render the projector'),
      image: reference,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
      response_format: 'url',
      stream: false,
    });
  });

  it('uses a chroma-key PNG request for GPT Image 2 instead of unsupported native alpha', () => {
    const body = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-transparent-png',
      model: 'gpt-image-2',
      prompt: 'render a product cutout',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2K',
      outputFormat: 'png',
      background: 'transparent',
      count: 1,
    });

    expect(body).toMatchObject({ output_format: 'png' });
    expect(body).not.toHaveProperty('background');
    expect(body.prompt).toContain('RGB(255,0,255)');
    expect(body.prompt).toContain('do not draw a transparency checkerboard');
  });

  it('converts the GPT Image 2 chroma key into real PNG alpha', async () => {
    const source = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 0, b: 255, alpha: 1 },
      },
    }).composite([{
      input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="#111111"/></svg>'),
    }]).png().toBuffer();

    const converted = await convertGptImage2ChromaKeyToTransparentPng(source);
    const { data, info } = await sharp(converted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(3, 3)).toBe(255);
  });

  it('keeps transparent GPT Image 2 reference requests on the multipart edits endpoint', async () => {
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const generated = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 0, b: 255, alpha: 1 },
      },
    }).composite([{
      input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="#111111"/></svg>'),
    }]).png().toBuffer();
    let multipartBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      multipartBody = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()).toString('utf8');
      return new Response(JSON.stringify({ output: [{ result: generated.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await generateNewApiImages(
      { baseUrl: 'https://provider.example', name: 'Image2 channel' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-transparent-reference',
        model: 'gpt-image-2',
        prompt: 'remove only the background',
        inputImages: [reference],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        background: 'transparent',
        count: 1,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(multipartBody).toContain('name="image"; filename="reference-1.png"');
    expect(multipartBody).toContain('name="output_format"\r\n\r\npng');
    expect(multipartBody).not.toContain('name="background"');
    expect(multipartBody).toContain('treat every supplied reference image as authoritative');
    expect(result).toContain('/v1/ai/image-results/');

    const key = new URL(result!).pathname.split('/').pop()!;
    const stored = await getImageResult(key);
    expect(stored?.mime).toBe('image/png');
    const { data, info } = await sharp(stored!.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[(3 * info.width + 3) * info.channels + 3]).toBe(255);
    await rm(stored!.path, { force: true });
  });

  it('uploads inline references through the NewAPI multipart edits endpoint', async () => {
    const reference = 'data:image/png;base64,aGVsbG8=';
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    let multipartBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      multipartBody = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()).toString('utf8');
      return new Response(JSON.stringify({
        output: [{ result: outputPng }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-inline-reference',
        model: 'gemini-3-pro-image',
        prompt: 'redesign the handle',
        inputImages: [reference],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${outputPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(String(fetchMock.mock.calls[0]?.[1]?.headers.get('content-type')))
      .toContain('multipart/form-data; boundary=');
    expect(multipartBody).toContain('name="image"; filename="reference-1.png"');
    expect(multipartBody).toContain('name="aspect_ratio"\r\n\r\n16:9');
    expect(multipartBody).toContain('name="size"\r\n\r\n2048x1152');
    expect(multipartBody).toContain('name="async"\r\n\r\ntrue');
  });

  it('falls back to JSON generations for compatible Nano channels that require referenceBlobs', async () => {
    const reference = 'https://1.1.1.1/reference.png';
    const referenceBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(referenceBytes.byteLength),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "submit failed: 422 {'error_code':'validation_error','message':\"Unsupported field(s): ['referenceImages']. Reference media must be supplied via 'referenceBlobs', not 'referenceImages' or 'referenceVideos'.\"}",
        },
      }), { status: 500, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ result: outputPng }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(generateNewApiImages(
        { baseUrl: 'https://provider.example', name: 'Image2 channel' } as Parameters<typeof generateNewApiImages>[0],
        { apiKey: 'test-key', headers: {} },
        {
          userId: 'user-1',
          clientRequestId: 'request-reference-protocol-fallback',
          model: 'gemini-3-pro-image',
          prompt: 'keep the product and redesign the handle',
          inputImages: [reference],
          aspectRatio: '16:9',
          resolution: '2K',
          outputFormat: 'jpg',
          count: 1,
        },
      )).resolves.toEqual([`data:image/png;base64,${outputPng}`]);
    } finally {
      warn.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(reference);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://provider.example/v1/images/generations');
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(fallbackBody).toMatchObject({
      model: 'gemini-3-pro-image',
      image: reference,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
      response_format: 'url',
      stream: false,
    });
  });

  it('never drops GPT Image 2 references into the generations fallback', async () => {
    const reference = 'https://1.1.1.1/reference.png';
    const referenceBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(referenceBytes.byteLength),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'images/edits is not supported by this channel',
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { id: 'channel-1', baseUrl: 'https://provider.example', name: 'Image2 channel' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-reference-no-fallback',
        model: 'gpt-image-2',
        prompt: 'keep the reference product unchanged',
        inputImages: [reference],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).rejects.toMatchObject({
      code: 'provider_reference_edit_unsupported',
      statusCode: 502,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/v1/images/generations'))).toBe(false);
  });

  it('streams legacy public references through disk to the NewAPI edits endpoint', async () => {
    const reference = 'https://1.1.1.1/legacy-reference.png';
    const referenceBytes = Buffer.from('legacy-reference-image-bytes');
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    let multipartBytes = Buffer.alloc(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(referenceBytes.byteLength),
        },
      }))
      .mockImplementationOnce(async (_url, init) => {
        multipartBytes = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response(JSON.stringify({
          output: [{ result: outputPng }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-legacy',
        clientRequestId: 'request-legacy-newapi-reference',
        model: 'gemini-3-pro-image',
        prompt: 'redesign the handle',
        inputImages: [reference],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${outputPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(reference);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(multipartBytes.includes(referenceBytes)).toBe(true);
  });

  it('enables async image tasks for 4K and multiple references', () => {
    const references = [
      'https://example.test/reference-1.png',
      'https://example.test/reference-2.png',
    ];
    const body = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-1',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      inputImages: references,
      aspectRatio: '16:9',
      resolution: '4K',
      outputFormat: 'jpg',
      count: 1,
    }, references);
    expect(body).toMatchObject({
      images: references,
      size: '3840x2160',
      aspect_ratio: '16:9',
      async: true,
      stream: false,
    });
  });

  it('uses the NewAPI images/generations endpoint', async () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ result: rawPng }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-1',
        model: 'gemini-3-pro-image',
        prompt: 'render the projector',
        inputImages: [],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${rawPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/generations');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'gemini-3-pro-image',
      size: '2048x1152',
      aspect_ratio: '16:9',
      response_format: 'url',
      async: true,
      stream: false,
    });
  });

  it('falls back to synchronous NewAPI requests when a channel rejects the async field', async () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'unknown field async' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ output: [{ result: rawPng }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-async-fallback',
        model: 'gemini-3-pro-image',
        prompt: 'render the projector',
        inputImages: [],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${rawPng}`]);

    expect(requestBodies[0]?.async).toBe(true);
    expect(requestBodies[1]).not.toHaveProperty('async');
  });

  it('streams remote NewAPI results into the stable disk-backed result store', async () => {
    const outputUrl = 'https://1.1.1.1/generated.png';
    const outputPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=', 'base64');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: outputUrl }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(outputPng, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(outputPng.byteLength),
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const images = await generateNewApiImages(
      { baseUrl: 'https://provider.example', name: 'NewAPI test' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-stable-result',
        model: 'gemini-3-pro-image',
        prompt: 'render the projector',
        inputImages: [],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    );

    expect(images[0]).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);
    const key = new URL(images[0]!).pathname.split('/').pop()!;
    const stored = await getImageResult(key);
    expect(await readFile(stored!.path)).toEqual(outputPng);
    await rm(stored!.path, { force: true });
  });

  it('polls an async NewAPI image task and downloads binary content when needed', async () => {
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from(outputPng, 'base64'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const images = await resolveNewApiImageResponse(
      { baseUrl: 'https://provider.example' } as Parameters<typeof resolveNewApiImageResponse>[0],
      { apiKey: 'test-key', headers: {} },
      { task_id: 'task-123', status: 'queued' },
      [],
      1,
      async () => {},
    );

    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);
    const key = new URL(images[0]!).pathname.split('/').pop()!;
    const stored = await getImageResult(key);
    expect(stored).not.toBeNull();
    expect(await readFile(stored!.path)).toEqual(Buffer.from(outputPng, 'base64'));
    await rm(stored!.path, { force: true });
    expect(fetchMock.mock.calls[0]?.[0])
      .toBe('https://provider.example/v1/images/generations/task-123');
    expect(fetchMock.mock.calls[1]?.[0])
      .toBe('https://provider.example/v1/images/task-123/content');
  });

  it('keeps async task content images when the content endpoint reports a post-processing error', async () => {
    const output = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'GPT Image 2 did not return a usable chroma-key background' },
        output,
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveNewApiImageResponse(
      { baseUrl: 'https://provider.example' } as Parameters<typeof resolveNewApiImageResponse>[0],
      { apiKey: 'test-key', headers: {} },
      { task_id: 'task-content-error', status: 'queued' },
      [],
      1,
      async () => {},
    )).resolves.toEqual([output]);
  });

});

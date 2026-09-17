import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  buildNewApiImageGenerationBody,
  buildWalletCatalogMetadata,
  catalogModelSupportsImageRequest,
  catalogModelSupportsVideoRequest,
  buildUselgImage2VariationPrompt,
  chooseProviderForCapability,
  collectImageStrings,
  collectUselgTaskAssets,
  collectGeneratedVideoStrings,
  collectProviderModelIds,
  confirmXaisReferenceAttachment,
  convertGptImage2ChromaKeyToTransparentPng,
  executeWalletImageGeneration,
  filterProviderImageModels,
  generateBigmodelBananaImages,
  generateMikotoBananaImages,
  generateUselgGeminiImages,
  generateNewApiImages,
  getWalletImageGenerationByRequest,
  imageCapabilityForModel,
  imageRouteSupportsRequest,
  imageUnitCredits,
  isNewApiGeminiImageDecodeError,
  isNewApiParamOverrideCopyError,
  isImageProviderFailoverStatus,
  isTabletImageProviderFailoverStatus,
  isPublicNewApiImageReference,
  isRetryableXaisPollError,
  materializeNewApiReferenceImage,
  mirrorGeneratedImageResults,
  mirrorGeneratedVideoResponse,
  minimaxVideoBody,
  mirrorXaisImageResults,
  newApiImageRequestParams,
  parseWalletImageGenerationResult,
  parseXaisTaskId,
  providerSupportsImageModel,
  boundProviderImageResults,
  providerCanServeImageAlongsideAgent,
  providerSupportsVideoModel,
  resolveBigmodelImageModel,
  resolveImageModel,
  resolveImageAdapterResponse,
  resolveMikotoImageModel,
  mikotoKlingModelCandidates,
  mikotoSoraV3ProVideoBody,
  mikotoSeedanceModelCandidates,
  resolveMikotoKlingModel,
  resolveMikotoSeedanceModel,
  resolveMikotoVideoModel,
  resolveNewApiImageModel,
  resolveNewApiImageResponse,
  resolveUselgImageModel,
  resolveUselgImageResponse,
  resolveXaisModel,
  resolveXaisPublicImageModel,
  resolveXaisWorkerRatio,
  runXaisWorkerTask,
  scopeMiniMaxVideoStatusPayload,
  selectVideoTaskPayload,
  selectVideoProvider,
  sizeFromRatio,
  splitTabletImageProviderInputs,
  stageXaisPublicReference,
  summarizeUselgImageStatus,
  uniqueImages,
  uselgImageRequestHeaders,
  videoCapabilityForModel,
  videoRouteSupportsRequest,
  xaisAttachmentRegistrationUrls,
} from '../src/modules/ai/image-service.js';
import { createImageResultFromResponse, getImageResult } from '../src/modules/ai/image-result-store.js';
import { storageService } from '../src/modules/storage/service.js';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';

describe('Mikoto Seedance model mapping', () => {
  it('does not fall back to another provider when MiniMax is explicitly requested', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { aiProviderChannel: { findMany } } as never;

    await expect(selectVideoProvider(prisma, 'minimax')).rejects.toMatchObject({
      code: 'provider_unavailable',
      statusCode: 503,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        kind: 'MINIMAX',
      },
    });
  });

  it('builds the independent MiniMax H3 multimodal video contract', () => {
    const body = minimaxVideoBody({
      model: 'MiniMax-H3',
      prompt: 'camera orbit',
      inputImages: ['https://media.example/first.jpg', 'https://media.example/style.jpg'],
      inputVideos: ['https://media.example/ref.mp4'],
      inputAudios: ['https://media.example/music.mp3'],
      aspectRatio: '16:9',
      resolution: '1080p',
      duration: 5,
      inputMode: 'REF',
    } as never);
    expect(body).toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: 'camera orbit' },
        { type: 'image_url', image_url: { url: 'https://media.example/first.jpg' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://media.example/style.jpg' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://media.example/ref.mp4' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'https://media.example/music.mp3' }, role: 'reference_audio' },
      ],
      resolution: '2K',
      duration: 5,
      ratio: '16:9',
    });
    expect(body.resolution).toBe('2K');
    expect(minimaxVideoBody({ model: 'MiniMax-H3', prompt: 'camera orbit', inputImages: [], inputVideos: [], inputAudios: [], resolution: '720p' } as never).resolution)
      .toBe('768P');
    expect(minimaxVideoBody({ model: 'MiniMax-H3', prompt: 'camera orbit', inputImages: [], inputVideos: [], inputAudios: [], resolution: '480p' } as never).resolution)
      .toBe('768P');
    expect(minimaxVideoBody({
      model: 'MiniMax-H3',
      prompt: 'transition',
      inputImages: ['https://media.example/start.jpg', 'https://media.example/end.jpg'],
      inputVideos: [],
      inputAudios: [],
      inputMode: 'FLF',
      resolution: '768P',
    } as never).content).toEqual([
      { type: 'text', text: 'transition' },
      { type: 'image_url', image_url: { url: 'https://media.example/start.jpg' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://media.example/end.jpg' }, role: 'last_frame' },
    ]);
  });

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

  it('isolates the requested H3 task from failed history and old video URLs', () => {
    const currentTask = {
      task_id: 'current-task',
      status: 'processing',
    };
    const response = {
      status: 'processing',
      walletVideoResults: ['https://api.unmind.art/v1/ai/video-results/old.mp4'],
      tasks: [
        {
          task_id: 'old-task',
          status: 'failed',
          error: 'HTTP 402: H3 积分余额不足 (1008)',
          video_url: 'https://media.example/old.mp4',
        },
        currentTask,
      ],
    };

    const selected = selectVideoTaskPayload(response, 'current-task');
    expect(selected).toEqual(currentTask);
    expect(collectGeneratedVideoStrings(selected)).toEqual([]);
  });

  it('recognizes the generic id field returned by MiniMax H3 status rows', () => {
    const currentTask = {
      id: 'current-task',
      status: 'processing',
    };
    const selected = selectVideoTaskPayload({
      tasks: [
        {
          id: 'old-task',
          status: 'failed',
          error: 'HTTP 402: H3 积分余额不足 (1008)',
          video_url: 'https://media.example/old.mp4',
        },
        currentTask,
      ],
    }, 'current-task');

    expect(selected).toEqual(currentTask);
    expect(collectGeneratedVideoStrings(selected)).toEqual([]);
  });

  it('keeps polling safely while a newly accepted H3 task is not listed yet', () => {
    const scoped = scopeMiniMaxVideoStatusPayload({
      tasks: [{
        id: 'old-task',
        status: 'failed',
        error: 'HTTP 402: H3 积分余额不足 (1008)',
        video_url: 'https://media.example/old.mp4',
      }],
    }, 'current-task');

    expect(scoped).toEqual({ task_id: 'current-task', status: 'processing' });
    expect(collectGeneratedVideoStrings(scoped)).toEqual([]);
  });

  it('prunes nested historical H3 tasks from a matching response root', () => {
    const selected = selectVideoTaskPayload({
      task_id: 'current-task',
      status: 'succeeded',
      data: { video_url: 'https://media.example/current.mp4' },
      history: [
        {
          task_id: 'old-task',
          status: 'succeeded',
          video_url: 'https://media.example/old.mp4',
        },
      ],
    }, 'current-task');

    expect(collectGeneratedVideoStrings(selected)).toEqual([
      'https://media.example/current.mp4',
    ]);
    expect(selectVideoTaskPayload({ tasks: [{ task_id: 'old-task' }] }, 'current-task'))
      .toBeUndefined();
  });
});

describe('dual-protocol image channels', () => {
  it('keeps Bigmodel, Mikoto, and USELG image routes available when LLM is also enabled', () => {
    expect(providerCanServeImageAlongsideAgent({
      kind: 'BIGMODEL',
      capabilities: ['LLM', 'IMAGE_NANO_BANANA'],
    })).toBe(true);
    expect(providerCanServeImageAlongsideAgent({
      kind: 'MIKOTO',
      capabilities: ['LLM', 'IMAGE_NANO_BANANA'],
    })).toBe(true);
    expect(providerCanServeImageAlongsideAgent({
      kind: 'USELG',
      capabilities: ['LLM', 'IMAGE_GPT'],
    })).toBe(true);
    expect(providerCanServeImageAlongsideAgent({
      kind: 'USELG',
      capabilities: ['VISION', 'IMAGE_GPT'],
    })).toBe(true);
    expect(providerCanServeImageAlongsideAgent({
      kind: 'NEW_API',
      capabilities: ['LLM', 'IMAGE'],
    })).toBe(false);
    expect(providerCanServeImageAlongsideAgent({
      kind: 'BIGMODEL',
      capabilities: ['LLM'],
    })).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet image provider normalization', () => {
  it('builds the dynamic desktop catalog fields from published server models', () => {
    const metadata = buildWalletCatalogMetadata([{
      id: 'gpt-image-medium',
      displayName: 'GPT Image 2.5',
      modality: 'image',
      aliases: ['gpt-image-2.5'],
      capabilities: { resolutions: ['1k', '2k', '4k'], supportsReferenceImages: true },
    }, {
      id: 'seedance-2',
      displayName: 'Seedance 2.0',
      modality: 'video',
      aliases: ['seedance2'],
      capabilities: { resolutions: ['1080p'], durations: [5, 10] },
    }], [{ models: ['gpt-image-medium'] }], [{ models: ['seedance-2'] }]);

    expect(metadata).toMatchObject({
      defaultImageModel: 'gpt-image-medium',
      defaultVideoModel: 'seedance-2',
      capabilities: {
        'gpt-image-medium': { resolutions: ['1k', '2k', '4k'] },
      },
    });
    expect(metadata.catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-image-medium', displayName: 'GPT Image 2.5', isDefault: true }),
    ]));
  });

  it('fails over to the next compatible image channel after an upstream 5xx response', async () => {
    const encryptedSecrets = encryptProviderSecrets({ apiKey: 'sk-image-test', headers: {} });
    const provider = (id: string, baseUrl: string, priority: number) => ({
      id,
      name: id,
      kind: 'MIKOTO',
      status: 'ACTIVE',
      priority,
      baseUrl,
      defaultModel: 'gemini-3-pro-image-preview',
      allowInsecureHttp: false,
      encryptedSecrets,
      apiKeyLast4: 'test',
      capabilities: ['IMAGE_NANO_BANANA'],
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const primary = provider('primary-channel', 'https://1.1.1.1', 0);
    const fallback = provider('fallback-channel', 'https://8.8.8.8', 10);
    const requestRow = { id: 'image-request-1', userId: 'user-1', status: 'RESERVED' };
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => requestRow),
        update: vi.fn(async () => requestRow),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      wallet: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ availableCredits: 1000n })),
        update: vi.fn(async () => ({ availableCredits: 1000n })),
      },
      walletLedger: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      aiProviderChannel: { findMany: vi.fn(async () => [primary, fallback]) },
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    };
    const resultUrl = 'https://9.9.9.9/fallback.png';
    const storedUrl = 'https://storage.example/generated-images/fallback.png?signature=redacted';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    vi.spyOn(storageService, 'uploadMedia').mockResolvedValue('generated-images/fallback.png');
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(storedUrl);
    const fetchMock = vi.fn(async (source: RequestInfo | URL) => {
      if (String(source) === resultUrl) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (String(source).startsWith(primary.baseUrl)) {
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ fileData: { mimeType: 'image/png', fileUri: resultUrl } }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(executeWalletImageGeneration(prisma as never, {
      userId: 'user-1',
      clientRequestId: 'request-image-failover',
      providerChannelId: primary.id,
      model: 'gemini-3-pro-image-preview',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toMatchObject({
      images: [storedUrl],
      providerChannelId: fallback.id,
      providerChannelName: fallback.name,
    });
    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      'https://1.1.1.1/v1beta/models/gemini-3-pro-image-preview:generateContent',
      'https://8.8.8.8/v1beta/models/gemini-3-pro-image-preview:generateContent',
      resultUrl,
    ]);
  });

  it('fails over after a USELG async image task reports a generation failure', async () => {
    const encryptedSecrets = encryptProviderSecrets({ apiKey: 'sk-image-test', headers: {} });
    const provider = (
      id: string,
      kind: 'USELG' | 'MIKOTO',
      baseUrl: string,
      priority: number,
    ) => ({
      id,
      name: id,
      kind,
      status: 'ACTIVE',
      priority,
      baseUrl,
      defaultModel: 'gemini-3-pro-image-preview',
      allowInsecureHttp: false,
      encryptedSecrets,
      apiKeyLast4: 'test',
      capabilities: ['IMAGE_NANO_BANANA'],
      lastTestStatus: null,
      lastTestMessage: null,
      lastTestModelCount: null,
      lastTestedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const primary = provider('uselg-channel', 'USELG', 'https://1.1.1.1', 0);
    const fallback = provider('fallback-channel', 'MIKOTO', 'https://8.8.8.8', 10);
    const requestRow = { id: 'image-request-uselg-task-failover', userId: 'user-1', status: 'RESERVED' };
    const transaction = {
      aiRequest: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => requestRow),
        update: vi.fn(async () => requestRow),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      wallet: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ availableCredits: 1000n })),
        update: vi.fn(async () => ({ availableCredits: 1000n })),
      },
      walletLedger: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      aiProviderChannel: { findMany: vi.fn(async () => [primary, fallback]) },
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    };
    const resultUrl = 'https://9.9.9.9/fallback-after-task-failure.png';
    const storedUrl = 'https://storage.example/generated-images/fallback-after-task-failure.png?signature=redacted';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    vi.spyOn(storageService, 'uploadMedia')
      .mockResolvedValue('generated-images/fallback-after-task-failure.png');
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(storedUrl);
    const fetchMock = vi.fn(async (source: RequestInfo | URL) => {
      const url = String(source);
      if (url === resultUrl) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url === 'https://1.1.1.1/v1beta/models/gemini-3-pro-image-preview:generateContent') {
        return new Response(JSON.stringify({
          task_id: 'uselg-failed-task',
          status: 'queued',
          status_url: '/v1/images/tasks/uselg-failed-task?view=summary',
          poll_after_ms: 2_000,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://1.1.1.1/v1/images/tasks/uselg-failed-task?view=summary') {
        return new Response(JSON.stringify({
          task_id: 'uselg-failed-task',
          status: 'failed',
          error: 'Image generation failed; please check the request or try again later',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ fileData: { mimeType: 'image/png', fileUri: resultUrl } }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(executeWalletImageGeneration(prisma as never, {
      userId: 'user-1',
      clientRequestId: 'request-uselg-task-failover',
      providerChannelId: primary.id,
      model: 'gemini-3-pro-image-preview',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toMatchObject({
      images: [storedUrl],
      providerChannelId: fallback.id,
      providerChannelName: fallback.name,
    });
    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      'https://1.1.1.1/v1beta/models/gemini-3-pro-image-preview:generateContent',
      'https://1.1.1.1/v1/images/tasks/uselg-failed-task?view=summary',
      'https://8.8.8.8/v1beta/models/gemini-3-pro-image-preview:generateContent',
      resultUrl,
    ]);
  });

  it('keeps desktop failover on HTTP 5xx and extends transient failures only for tablet requests', () => {
    expect(isImageProviderFailoverStatus(500)).toBe(true);
    expect(isImageProviderFailoverStatus(503)).toBe(true);
    expect(isImageProviderFailoverStatus(599)).toBe(true);
    expect(isImageProviderFailoverStatus(0)).toBe(false);
    expect(isImageProviderFailoverStatus(429)).toBe(false);
    expect(isImageProviderFailoverStatus(400)).toBe(false);
    expect(isImageProviderFailoverStatus(422)).toBe(false);
    expect(isTabletImageProviderFailoverStatus(0)).toBe(true);
    expect(isTabletImageProviderFailoverStatus(401)).toBe(true);
    expect(isTabletImageProviderFailoverStatus(408)).toBe(true);
    expect(isTabletImageProviderFailoverStatus(429)).toBe(true);
    expect(isTabletImageProviderFailoverStatus(503)).toBe(true);
    expect(isTabletImageProviderFailoverStatus(400)).toBe(false);
  });

  it('splits tablet multi-image requests into distinct single-image upstream tasks only', () => {
    const input = {
      userId: 'user-1',
      clientRequestId: 'tablet-request-1',
      clientPlatform: 'tablet' as const,
      model: 'nano-banana-pro',
      prompt: 'a red apple',
      inputImages: [],
      aspectRatio: '1:1' as const,
      resolution: '4k',
      outputFormat: 'png' as const,
      count: 2,
    };
    const tabletTasks = splitTabletImageProviderInputs(input);
    expect(tabletTasks).toHaveLength(2);
    expect(tabletTasks.map((task) => task.count)).toEqual([1, 1]);
    expect(new Set(tabletTasks.map((task) => task.clientRequestId)).size).toBe(2);
    expect(splitTabletImageProviderInputs({ ...input, clientPlatform: undefined })).toEqual([
      { ...input, clientPlatform: undefined },
    ]);
  });

  it('never returns or settles more provider images than the requested count', () => {
    expect(boundProviderImageResults(['first', 'second', 'third', 'second'], 2)).toEqual([
      'first',
      'second',
    ]);
  });

  it('uses a fresh USELG request fingerprint for resolution and output changes', () => {
    const input = {
      clientRequestId: 'desktop-generation-run-1',
      model: 'nano-banana-pro',
      prompt: 'same prompt',
      inputImages: [],
      aspectRatio: '16:9' as const,
      resolution: '4k',
      outputFormat: 'png' as const,
    };
    const first = uselgImageRequestHeaders(input, 0);
    const repeated = uselgImageRequestHeaders(input, 0);
    const nextOutput = uselgImageRequestHeaders(input, 1);
    const lowerResolution = uselgImageRequestHeaders({ ...input, resolution: '2k' }, 0);
    expect(first['Idempotency-Key']).toBe(repeated['Idempotency-Key']);
    expect(first['Idempotency-Key']).not.toBe(nextOutput['Idempotency-Key']);
    expect(first['Idempotency-Key']).not.toBe(lowerResolution['Idempotency-Key']);
    expect(first['Cache-Control']).toBe('no-cache, no-store');
  });

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

  it('replays a completed image request instead of returning duplicate_request', async () => {
    const result = {
      images: ['https://provider.example/generated.png'],
      provider: 'MIKOTO',
      providerChannelId: 'channel-1',
      providerChannelName: 'primary',
      model: 'gpt-image-2',
      chargedCredits: '18',
    };
    const findUnique = vi.fn(async () => ({
      capability: 'IMAGE',
      status: 'SUCCEEDED',
      completedAt: new Date(1_725_000_000_000),
      result,
    }));
    const prisma = { aiRequest: { findUnique } };

    await expect(executeWalletImageGeneration(prisma as never, {
      userId: 'user-1',
      clientRequestId: 'replay-request-1',
      model: 'gpt-image-2',
      prompt: 'same request',
      inputImages: [],
      aspectRatio: '1:1',
      resolution: '2k',
      outputFormat: 'png',
      count: 1,
    })).resolves.toEqual(result);
    expect(findUnique).toHaveBeenCalledTimes(1);
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
    const nanoProFast = { capabilities: ['IMAGE_NANO_BANANA_PRO_FAST'] as const };
    const nano2Fast = { capabilities: ['IMAGE_NANO_BANANA_2_FAST'] as const };
    const gpt = { capabilities: ['IMAGE_GPT'] as const };
    const legacy = { capabilities: ['IMAGE'] as const };

    expect(imageCapabilityForModel('gemini-3-pro-image')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('Xais Nano Pro_2K')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('gemini-3.1-flash-image')).toBe('IMAGE_NANO_BANANA_2');
    expect(imageCapabilityForModel('Nano Banana 2')).toBe('IMAGE_NANO_BANANA_2');
    expect(imageCapabilityForModel('Nano Banana Pro Fast')).toBe('IMAGE_NANO_BANANA_PRO_FAST');
    expect(imageCapabilityForModel('Nano Banana 2 Fast')).toBe('IMAGE_NANO_BANANA_2_FAST');
    expect(imageCapabilityForModel('gpt-image-2')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('gpt-image-2.5', '1k')).toBe('IMAGE_GPT_1K');
    expect(imageCapabilityForModel('gpt-image-2.5', '2k')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('Image2_4K')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('Image2_1K')).toBe('IMAGE_GPT_1K');
    expect(providerSupportsImageModel(nano, 'gpt-image-2')).toBe(false);
    expect(providerSupportsImageModel(nano, 'Nano Banana 2')).toBe(false);
    expect(providerSupportsImageModel(nano2, 'Nano Banana 2')).toBe(true);
    expect(providerSupportsImageModel(nanoProFast, 'gemini-3-pro-image', '2k')).toBe(false);
    expect(providerSupportsImageModel(nanoProFast, 'nano-banana-pro-fast', '2k')).toBe(true);
    expect(providerSupportsImageModel(nano, 'nano-banana-pro-fast', '2k')).toBe(false);
    expect(providerSupportsImageModel(nanoProFast, 'gemini-3.1-flash-image', '2k')).toBe(false);
    expect(providerSupportsImageModel(nano2Fast, 'gemini-3.1-flash-image', '2k')).toBe(false);
    expect(providerSupportsImageModel(nano2Fast, 'nano-banana-2-fast', '2k')).toBe(true);
    expect(providerSupportsImageModel(nano2, 'nano-banana-2-fast', '2k')).toBe(false);
    expect(providerSupportsImageModel(nano2Fast, 'gemini-3-pro-image', '2k')).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gemini-3.1-flash-image')).toBe(false);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'Image2_1K')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'Image2_4K')).toBe(false);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'gpt-image-2', '1k')).toBe(true);
    expect(providerSupportsImageModel({ capabilities: ['IMAGE_GPT_1K'] as const }, 'gpt-image-2', '2k')).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gpt-image-2', '1k')).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gpt-image-2', '2k')).toBe(true);
    expect(providerSupportsImageModel(
      { capabilities: ['IMAGE_GPT_1K'] as const },
      'gpt-image-2.5',
      '1k',
    )).toBe(true);
    expect(providerSupportsImageModel(
      { capabilities: ['IMAGE_GPT_1K'] as const },
      'gpt-image-2.5',
      '2k',
    )).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gpt-image-2.5', '1k')).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gpt-image-2.5', '4k')).toBe(true);
    expect(providerSupportsImageModel(
      { capabilities: ['IMAGE', 'IMAGE_GPT'] as const },
      'nano-banana-pro',
      '2k',
    )).toBe(false);
    expect(imageRouteSupportsRequest({ channel: gpt }, 'gpt-image-2', '1k')).toBe(false);
    expect(imageRouteSupportsRequest(
      { channel: { capabilities: ['LLM'] as const } },
      'future-image-model',
      '2k',
      '16:9',
      true,
    )).toBe(true);
    expect(imageRouteSupportsRequest(
      { channel: { capabilities: ['IMAGE_GPT_1K'] as const } },
      'gpt-image-2',
      '1k',
    )).toBe(true);
    expect(imageRouteSupportsRequest({
      channel: gpt,
      capabilitiesOverride: { supportedResolutions: ['4k'] },
    }, 'gpt-image-2', '2k')).toBe(false);
    expect(imageRouteSupportsRequest({
      channel: { capabilities: ['LLM'] as const },
      capabilitiesOverride: { supportedResolutions: ['4k'] },
      metadata: { capabilitiesOverrideSource: 'DISCOVERY' },
    }, 'gpt-image-2.5', '2k', '16:9', true)).toBe(true);
    expect(imageRouteSupportsRequest({
      channel: { capabilities: ['LLM'] as const },
      capabilitiesOverride: { supportedResolutions: ['4k'] },
      metadata: { capabilitiesOverrideSource: 'MANUAL' },
    }, 'gpt-image-2.5', '2k', '16:9', true)).toBe(false);
    expect(catalogModelSupportsImageRequest({ supportedResolutions: ['2k', '4k'] }, '1k')).toBe(false);
    expect(catalogModelSupportsImageRequest({ supportedResolutions: ['2k', '4k'] }, '4k')).toBe(true);
    const exactDimensions = {
      supportedResolutions: ['1k', '2k', '4k'],
      supportedAspectRatios: ['1:1', '16:9'],
      supportedAspectRatiosByResolution: {
        '2k': ['2048x2048', '2048x1152'],
        '4k': ['2880x2880', '3840x2160'],
      },
    };
    expect(catalogModelSupportsImageRequest(exactDimensions, '2k', '2048x1152')).toBe(true);
    expect(catalogModelSupportsImageRequest(exactDimensions, '4k', '2048x1152')).toBe(false);
    expect(catalogModelSupportsImageRequest(exactDimensions, '4k', '3840x2160')).toBe(true);
    expect(catalogModelSupportsImageRequest(exactDimensions, '2k', '16:9')).toBe(true);
    expect(imageRouteSupportsRequest({
      channel: gpt,
      capabilitiesOverride: {
        supportedResolutions: ['2k', '4k'],
        supportedAspectRatios: ['1:1', '16:9'],
      },
    }, 'gpt-image-2.5', '2k', '2048x1152')).toBe(true);
    expect(imageRouteSupportsRequest({
      channel: gpt,
      capabilitiesOverride: {
        supportedResolutions: ['2k', '4k'],
        supportedAspectRatiosByResolution: { '4k': ['3840x2160'] },
      },
    }, 'gpt-image-2.5', '4k', '3520x2352')).toBe(false);
    expect(providerSupportsImageModel(legacy, 'custom-image-model')).toBe(true);
    const bananaDual2k = { capabilities: ['IMAGE_NANO_BANANA_DUAL_2K'] as const };
    expect(providerSupportsImageModel(bananaDual2k, 'gemini-3-pro-image-preview')).toBe(true);
    expect(providerSupportsImageModel(bananaDual2k, 'gemini-3-pro-image-preview', '2k')).toBe(true);
    expect(providerSupportsImageModel(bananaDual2k, 'gemini-3.1-flash-image-preview', '2k')).toBe(true);
    expect(providerSupportsImageModel(bananaDual2k, 'Xais Nano Pro_2K')).toBe(true);
    expect(providerSupportsImageModel(bananaDual2k, 'Xais Nano2_4K')).toBe(false);
    expect(providerSupportsImageModel(bananaDual2k, 'gemini-3-pro-image-preview', '1k')).toBe(false);
    expect(providerSupportsImageModel(bananaDual2k, 'gemini-3.1-flash-image-preview', '4k')).toBe(false);
    expect(providerSupportsImageModel(bananaDual2k, 'nano-banana-pro-fast', '2k')).toBe(false);
    expect(providerSupportsImageModel(bananaDual2k, 'nano-banana-2-fast', '2k')).toBe(false);
    expect(providerSupportsImageModel(
      { capabilities: ['IMAGE_NANO_BANANA_PRO_1K'] as const },
      'gemini-3-pro-image-preview',
      '2k',
    )).toBe(true);
    expect(filterProviderImageModels(nano, [
      'gemini-3-pro-image',
      'gemini-2.5-pro',
      'gpt-image-2',
    ])).toEqual(['gemini-3-pro-image']);
    expect(filterProviderImageModels(nanoProFast, [
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
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
    expect(resolveBigmodelImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image-preview');
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
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
      expect(body.generationConfig.responseFormat).toBeUndefined();
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

  it('returns the final Bigmodel image instead of the lower-resolution thought image', async () => {
    const thoughtImage = 'iVBORw0KGgo' + 't'.repeat(40);
    const finalImage = 'iVBORw0KGgo' + 'f'.repeat(40);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://bigmodel.example/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
      expect(body.generationConfig.responseFormat).toBeUndefined();
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { thought: true, inlineData: { mimeType: 'image/png', data: thoughtImage } },
              { inlineData: { mimeType: 'image/png', data: finalImage }, thoughtSignature: 'signature' },
            ],
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateBigmodelBananaImages(
      { baseUrl: 'https://bigmodel.example', name: 'Bigmodel', kind: 'BIGMODEL' } as never,
      { apiKey: 'sk-test', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-4k', model: 'Nano Banana 2', prompt: 'a red apple',
        inputImages: [], aspectRatio: '16:9', resolution: '4k', outputFormat: 'png', count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${finalImage}`]);
  });

  it('maps the three public tablet models to XAIS resolution-specific routes', () => {
    expect(resolveXaisPublicImageModel('nano-banana-pro', '2k')).toBe('Xais Nano Pro_2K');
    expect(resolveXaisPublicImageModel('nano-banana-pro', '4k')).toBe('Xais Nano Pro_4K');
    expect(resolveXaisPublicImageModel('nano-banana-2', '4k')).toBe('Xais Nano2_4K');
    expect(resolveXaisPublicImageModel('gpt-image-2', '2k')).toBe('Xais Img2_2K');
    expect(resolveImageModel({ kind: 'XAIS', defaultModel: null }, 'Xais Img2_2K(高画质)'))
      .toBe('Xais Img2_2K(高画质)');
  });

  it('does not let a 2K/4K GPT Image channel receive a desktop 1K request', () => {
    expect(providerSupportsImageModel(
      { capabilities: ['IMAGE_GPT'] as const },
      'gpt-image-2',
      '1k',
    )).toBe(false);
  });

  it('keeps generic, fast, dual-resolution, GPT 1K, and Grok channels isolated', () => {
    const requests = [
      { model: 'nano-banana-pro', resolution: '2k', capability: 'IMAGE_NANO_BANANA' },
      { model: 'nano-banana-pro-fast', resolution: '2k', capability: 'IMAGE_NANO_BANANA_PRO_FAST' },
      { model: 'nano-banana-2', resolution: '4k', capability: 'IMAGE_NANO_BANANA_2' },
      { model: 'nano-banana-2-fast', resolution: '4k', capability: 'IMAGE_NANO_BANANA_2_FAST' },
      { model: 'gpt-image-2', resolution: '1k', capability: 'IMAGE_GPT_1K' },
      { model: 'gpt-image-2', resolution: '4k', capability: 'IMAGE_GPT' },
      { model: 'grok-imagine-image', resolution: '2k', capability: 'IMAGE_GROK' },
    ] as const;
    for (const request of requests) {
      for (const candidate of requests) {
        const supported = providerSupportsImageModel(
          { capabilities: [candidate.capability] },
          request.model,
          request.resolution,
        );
        expect(supported, `${candidate.capability} unexpectedly matched ${request.model}/${request.resolution}`)
          .toBe(candidate.capability === request.capability);
      }
    }
    const dual = { capabilities: ['IMAGE_NANO_BANANA_DUAL_2K'] as const };
    expect(providerSupportsImageModel(dual, 'nano-banana-pro', '2k')).toBe(true);
    expect(providerSupportsImageModel(dual, 'nano-banana-2', '2k')).toBe(true);
    expect(providerSupportsImageModel(dual, 'nano-banana-pro', '4k')).toBe(false);
    expect(providerSupportsImageModel(dual, 'nano-banana-pro-fast', '2k')).toBe(false);
  });

  it('keeps MiniMax H3 and generic video channels isolated', async () => {
    const generic = { id: 'video-generic', baseUrl: 'https://8.8.8.8', capabilities: ['VIDEO'] as const };
    const minimax = { id: 'video-minimax', baseUrl: 'https://8.8.4.4', capabilities: ['VIDEO_MINIMAX'] as const };
    expect(videoCapabilityForModel('MiniMax-H3')).toBe('VIDEO_MINIMAX');
    expect(videoCapabilityForModel('seedance-2')).toBe('VIDEO');
    expect(providerSupportsVideoModel(generic, 'MiniMax-H3')).toBe(false);
    expect(providerSupportsVideoModel(minimax, 'seedance-2')).toBe(false);
    expect(videoRouteSupportsRequest({ channel: minimax }, 'MiniMax-H3', '1080p', 5)).toBe(true);
    expect(videoRouteSupportsRequest(
      { channel: { capabilities: ['LLM'] as const } },
      'future-video-model',
      '1080p',
      5,
      true,
    )).toBe(true);
    expect(videoRouteSupportsRequest({
      channel: minimax,
      capabilitiesOverride: { supportedResolutions: ['768p'], supportedDurations: [5] },
    }, 'MiniMax-H3', '1080p', 5)).toBe(false);
    expect(catalogModelSupportsVideoRequest({ supportedResolutions: ['720p'], supportedDurations: [5, 10] }, '720p', 15)).toBe(false);

    const findMany = vi.fn(async () => [minimax, generic]);
    const prisma = { aiProviderChannel: { findMany } } as never;
    await expect(selectVideoProvider(prisma, undefined, undefined, 'seedance-2')).resolves.toBe(generic);
    await expect(selectVideoProvider(prisma, undefined, undefined, 'MiniMax-H3')).resolves.toBe(minimax);

    const managed = { id: 'video-managed', baseUrl: 'https://1.1.1.1', capabilities: ['LLM'] as const };
    const managedPrisma = { aiProviderChannel: { findFirst: vi.fn(async () => managed) } } as never;
    await expect(selectVideoProvider(
      managedPrisma,
      undefined,
      managed.id,
      'future-video-model',
      true,
    )).resolves.toBe(managed);
  });

  it('calls Mikoto Gemini native endpoint with imageConfig', async () => {
    const generated = 'iVBORw0KGgo' + 'b'.repeat(40);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.mikoto.example/v1beta/models/gemini-3-pro-image-preview:generateContent');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('sk-mikoto');
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeDefined();
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

  it('does not normalize route upstreamModel inside an explicit Nano Banana wrapper', async () => {
    const generated = 'iVBORw0KGgo' + 'p'.repeat(40);
    const fetchMock = vi.fn(async (source: RequestInfo | URL) => {
      expect(String(source)).toBe('https://api.mikoto.example/v1beta/models/Nano%20Banana%20Pro:generateContent');
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateMikotoBananaImages(
      { baseUrl: 'https://api.mikoto.example', name: 'Mikoto', kind: 'MIKOTO' } as never,
      { apiKey: 'sk-mikoto', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-explicit-nano', model: 'Nano Banana Pro', prompt: 'a red apple',
        inputImages: [], aspectRatio: '1:1', resolution: '1k', outputFormat: 'jpg', count: 1,
      },
      true,
    )).resolves.toEqual([`data:image/png;base64,${generated}`]);
  });

  it('extracts a multi-megabyte Gemini inline image without revisiting its payload', () => {
    const generated = `iVBORw0KGgo${'A'.repeat(4 * 1024 * 1024)}`;
    let payloadReads = 0;
    const inlineData = {
      mimeType: 'image/png',
      get data() {
        payloadReads += 1;
        return generated;
      },
    };
    const response = { candidates: [{ content: { parts: [{ inlineData }] } }] };

    const images = collectImageStrings(response);

    expect(payloadReads).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    expect(images[0]?.length).toBe('data:image/png;base64,'.length + generated.length);
    expect(images).not.toContain(generated);
  });

  it('does not collect inline image bodies as USELG task assets', () => {
    const generated = `iVBORw0KGgo${'B'.repeat(3 * 1024 * 1024)}`;
    const signedUrl = 'https://cdn.example.test/final.png';
    const response = {
      data: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }],
        result: { assets: [{ signed_url: signedUrl }] },
      },
    };

    expect(collectUselgTaskAssets(response)).toEqual([{ key: 'signed_url', value: signedUrl }]);
    const summary = summarizeUselgImageStatus(response, [], 1);
    expect(summary.assets).toEqual([{ key: 'signed_url', value: signedUrl }]);
    expect(summary.images).toHaveLength(1);
    expect(summary.images[0]?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('keeps URL-based image responses unchanged', () => {
    const imageUrl = 'https://cdn.example.test/image2-result.png';
    expect(uniqueImages({ data: [{ url: imageUrl }] }, [], 1)).toEqual([imageUrl]);
  });

  it('calls USELG Gemini through its native v1beta endpoint', async () => {
    const generated = 'iVBORw0KGgo' + 'c'.repeat(40);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.ai-media.vip/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-goog-api-key')).toBe('sk-uselg');
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9]{64}$/);
      expect(headers.get('cache-control')).toBe('no-cache, no-store');
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateUselgGeminiImages(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-uselg', model: 'Nano Banana 2', prompt: 'a red apple',
        inputImages: [], aspectRatio: '16:9', resolution: '2k', outputFormat: 'png', count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${generated}`]);
  });

  it('prefers a USELG result URL when the response also contains inline Base64', async () => {
    const generated = 'iVBORw0KGgo' + 'c'.repeat(40);
    const resultUrl = 'https://api.ai-media.vip/api/v1/image-workshop/download/result.png';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { inlineData: { mimeType: 'image/png', data: generated } },
            { fileData: { mimeType: 'image/png', fileUri: resultUrl } },
          ],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(generateUselgGeminiImages(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-uselg-url', model: 'Nano Banana 2', prompt: 'a red apple',
        inputImages: [], aspectRatio: '16:9', resolution: '2k', outputFormat: 'png', count: 1,
      },
    )).resolves.toEqual([resultUrl]);
  });

  it('polls a pending USELG Gemini response before returning its generated asset', async () => {
    const resultUrl = 'https://cdn.example.test/generated-async.png';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'gemini-task-123',
        status: 'processing',
        status_url: '/v1/images/tasks/gemini-task-123?view=summary',
        poll_after_ms: 2_000,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'gemini-task-123',
        status: 'success',
        assets: [{ signed_url: resultUrl }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(generateUselgGeminiImages(
      { id: 'uselg-provider-1', baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        userId: 'user-1', clientRequestId: 'request-uselg-async', model: 'Nano Banana Pro', prompt: 'a red apple',
        inputImages: [], aspectRatio: '1:1', resolution: '2k', outputFormat: 'png', count: 1,
      },
    )).resolves.toEqual([resultUrl]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.ai-media.vip/v1beta/models/gemini-3-pro-image-preview:generateContent',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.ai-media.vip/v1/images/tasks/gemini-task-123?view=summary',
    );
    expect(fetchMock.mock.calls.filter(([source]) => (
      String(source).includes(':generateContent')
    ))).toHaveLength(1);
    expect(info).toHaveBeenCalledWith('[uselg_gemini_generate_started]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      providerId: 'uselg-provider-1',
      model: 'gemini-3-pro-image-preview',
      timestamp: expect.any(String),
    }));
    expect(info).toHaveBeenCalledWith('[uselg_gemini_generate_response]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      providerId: 'uselg-provider-1',
      model: 'gemini-3-pro-image-preview',
      durationMs: expect.any(Number),
      hasImmediateImage: false,
      hasTaskId: true,
      taskState: 'processing',
      hasStatusUrl: true,
      hasResultUrl: false,
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_resolve_started]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      taskId: 'gemini-task-123',
      initialState: 'processing',
      hasStatusUrl: true,
      hasResultUrl: false,
      pollAfterMs: 2_000,
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_poll_started]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      taskId: 'gemini-task-123',
      attempt: 1,
      pollAfterMs: 2_000,
      targetType: 'status',
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_poll_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      taskId: 'gemini-task-123',
      attempt: 1,
      durationMs: expect.any(Number),
      state: 'success',
      hasImage: true,
      hasResultUrl: false,
      assetCount: 1,
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_resolve_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-async',
      taskId: 'gemini-task-123',
      durationMs: expect.any(Number),
      sourceType: 'signed_url',
    }));
    const responseOrder = info.mock.calls.findIndex(([event]) => event === '[uselg_gemini_generate_response]');
    const resolveOrder = info.mock.calls.findIndex(([event]) => event === '[uselg_image_resolve_started]');
    expect(responseOrder).toBeGreaterThanOrEqual(0);
    expect(resolveOrder).toBeGreaterThan(responseOrder);
    const serializedLogs = JSON.stringify(info.mock.calls);
    expect(serializedLogs).not.toContain(resultUrl);
    expect(serializedLogs).not.toContain('a red apple');
    expect(serializedLogs).not.toContain('sk-uselg');
  });

  it('probes a USELG result_url while the task is still dispatching', async () => {
    const statusUrl = '/v1/images/tasks/gemini-dispatching?view=summary';
    const resultUrl = 'https://api.ai-media.vip/v1/images/tasks/gemini-dispatching/result';
    const outputUrl = 'https://cdn.example.test/generated-dispatching.png';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'gemini-dispatching',
        status: 'dispatching',
        status_url: statusUrl,
        result_url: resultUrl,
        poll_after_ms: 2_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: outputUrl }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async () => undefined);

    await expect(resolveUselgImageResponse(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        task_id: 'gemini-dispatching',
        status: 'queued',
        status_url: statusUrl,
        poll_after_ms: 2_000,
      },
      [],
      1,
      wait,
    )).resolves.toEqual([outputUrl]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      `https://api.ai-media.vip${statusUrl}`,
      resultUrl,
    ]);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it('keeps polling the same USELG task when result_url returns 202 pending', async () => {
    const statusUrl = '/v1/images/tasks/gemini-result-pending?view=summary';
    const resultUrl = '/v1/images/tasks/gemini-result-pending/result';
    const outputUrl = 'https://cdn.example.test/generated-after-pending.png';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'gemini-result-pending',
        status: 'dispatching',
        status_url: statusUrl,
        result_url: resultUrl,
        poll_after_ms: 2_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'gemini-result-pending',
        status: 'dispatching',
        status_url: statusUrl,
        result_url: resultUrl,
        poll_after_ms: 2_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: outputUrl }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async () => undefined);

    await expect(resolveUselgImageResponse(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        task_id: 'gemini-result-pending',
        status: 'queued',
        status_url: statusUrl,
        poll_after_ms: 2_000,
      },
      [],
      1,
      wait,
    )).resolves.toEqual([outputUrl]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      'https://api.ai-media.vip/v1/images/tasks/gemini-result-pending?view=summary',
      'https://api.ai-media.vip/v1/images/tasks/gemini-result-pending/result',
      'https://api.ai-media.vip/v1/images/tasks/gemini-result-pending?view=summary',
      'https://api.ai-media.vip/v1/images/tasks/gemini-result-pending/result',
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it('polls explicit image adapters through status_url and result_url', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'seedream-task-123',
        status: 'success',
        result_url: '/v1/custom-results/seedream-task-123',
        poll_after_ms: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async () => undefined);

    await expect(resolveImageAdapterResponse(
      { baseUrl: 'https://provider.example', kind: 'NEW_API' } as never,
      { apiKey: 'test-key', headers: {} },
      {
        task_id: 'seedream-task-123',
        status: 'queued',
        status_url: '/v1/custom-status/seedream-task-123',
        poll_after_ms: 1,
      },
      [],
      1,
      wait,
    )).resolves.toEqual(['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB']);

    expect(wait).toHaveBeenCalledWith(2_000);
    expect(fetchMock.mock.calls.map(([source]) => String(source))).toEqual([
      'https://provider.example/v1/custom-status/seedream-task-123',
      'https://provider.example/v1/custom-results/seedream-task-123',
    ]);
    expect(fetchMock.mock.calls.some(([source]) => String(source).includes('/v1/images/generations/'))).toBe(false);
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

  it('fails XAIS persistence instead of returning the upstream source URL', async () => {
    const source = 'https://xais.example.test/result.png';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mirror = vi.fn(async () => { throw new Error('OSS unavailable'); });

    await expect(mirrorXaisImageResults([source], 'xais-primary', mirror))
      .rejects.toMatchObject({ code: 'IMAGE_RESULT_PERSISTENCE_FAILED' });
    expect(warn).toHaveBeenCalledWith(
      '[image_result_mirror_failed]',
      expect.objectContaining({ provider: 'xais-primary', index: 0 }),
    );
  });

  it('normalizes Mikoto Gemini aliases to its native model IDs', () => {
    expect(resolveMikotoImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image-preview');
    expect(resolveMikotoImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image-preview');
    expect(resolveMikotoImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveImageModel({ kind: 'MIKOTO', defaultModel: 'Nano Banana Pro' }, '')).toBe('gemini-3-pro-image-preview');
  });

  it('normalizes public image models to USELG protocol-specific model IDs', () => {
    expect(resolveUselgImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image-preview');
    expect(resolveUselgImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image-preview');
    expect(resolveUselgImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveUselgImageModel('grok-imagine-image-quality', true)).toBe('grok-imagine-image-edit');
    expect(resolveImageModel({ kind: 'USELG', defaultModel: 'Nano Banana Pro' }, ''))
      .toBe('gemini-3-pro-image-preview');
  });

  it('sends prepared adapter public, inline, and stored results through the common mirror', async () => {
    const mirror = vi.fn(async (source: string, index: number) => (
      `https://api.unmind.art/v1/ai/image-results/mirrored-${index + 1}.png?source=${encodeURIComponent(source.slice(0, 12))}`
    ));
    const inline = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const stable = 'https://api.unmind.art/v1/ai/image-results/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
    const publicUrl = 'https://provider.example/image.png';

    await expect(mirrorGeneratedImageResults([inline, stable, publicUrl], 'Bigmodel', mirror))
      .resolves.toHaveLength(3);
    expect(mirror).toHaveBeenCalledTimes(3);
    expect(mirror).toHaveBeenNthCalledWith(3, publicUrl, 2, expect.any(Object));
  });

  it('persists public, inline, and local stored results and returns only storage URLs', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const publicUrl = 'https://1.0.0.1/image.png';
    const inline = `data:image/png;base64,${png.toString('base64')}`;
    const uploadedPaths: string[] = [];
    const uploadMedia = vi.spyOn(storageService, 'uploadMedia').mockImplementation(async (input) => {
      uploadedPaths.push(String(input.source));
      return `${input.namespace}/${input.filename}`;
    });
    vi.spyOn(storageService, 'getDownloadUrl').mockImplementation(
      objectName => `https://storage.example/${objectName}?token=test`,
    );
    const fetchMock = vi.fn(async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const stored = await createImageResultFromResponse(new Response(png, {
      headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
    }));
    const context = {
      clientRequestId: 'prepared-adapter-result-1',
      canonicalModel: 'seedream-4.5',
      routeId: 'route-seedream',
      providerId: 'provider-seedream',
      adapterKey: 'SEEDREAM_IMAGES_API',
    };

    try {
      const publicResult = await mirrorGeneratedImageResults([publicUrl], 'prepared', undefined, context);
      const inlineResult = await mirrorGeneratedImageResults([inline], 'prepared', undefined, context);
      const storedResult = await mirrorGeneratedImageResults([stored], 'prepared', undefined, context);

      for (const result of [publicResult[0], inlineResult[0], storedResult[0]]) {
        expect(result).toMatch(/^https:\/\/storage\.example\/generated-images\//);
      }
      expect(publicResult[0]).not.toBe(publicUrl);
      expect(inlineResult[0]).not.toBe(inline);
      expect(storedResult[0]).not.toBe(stored);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(uploadMedia).toHaveBeenCalledTimes(3);
      expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'generated-images' }));
      for (const event of [
        '[image_result_download_started]',
        '[image_result_download_complete]',
        '[image_result_storage_upload_started]',
        '[image_result_storage_upload_complete]',
      ]) {
        expect(info).toHaveBeenCalledWith(event, expect.objectContaining({
          clientRequestId: context.clientRequestId,
          canonicalModel: context.canonicalModel,
          routeId: context.routeId,
          providerId: context.providerId,
          adapterKey: context.adapterKey,
          index: 0,
          durationMs: expect.any(Number),
        }));
      }
    } finally {
      await Promise.all(Array.from(new Set(uploadedPaths)).map(path => rm(path, { force: true })));
    }
  });

  it('retries only the result download after an adapter has already generated the image', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const uploadedPaths: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(storageService, 'uploadMedia').mockImplementation(async (input) => {
      uploadedPaths.push(String(input.source));
      return `${input.namespace}/${input.filename}`;
    });
    vi.spyOn(storageService, 'getDownloadUrl')
      .mockReturnValue('https://storage.example/generated-images/retried.png?token=test');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await expect(mirrorGeneratedImageResults([
        'https://1.0.0.1/retried.png',
      ], 'prepared')).resolves.toEqual([
        'https://storage.example/generated-images/retried.png?token=test',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(storageService.uploadMedia).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(Array.from(new Set(uploadedPaths)).map(path => rm(path, { force: true })));
    }
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
    expect(newApiImageRequestParams('gpt-image-2.5', 1, '3520x2352', '4K')).toEqual({
      n: 1,
      size: '3520x2352',
      quality: 'medium',
    });
    expect(newApiImageRequestParams('gpt-image-2.5', 1, '2048x1152', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      quality: 'medium',
    });
    expect(newApiImageRequestParams('gpt-image-2.5-high', 1, '3520x2352', '4K')).toEqual({
      n: 1,
      size: '3520x2352',
      quality: 'medium',
    });
    expect(newApiImageRequestParams('seedream-4.0', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
    });
  });

  it('keeps the full GPT Image 2 / 2.5 exact-size table unchanged', () => {
    const cases = [
    ['1K', '1:1', '1024x1024'],
    ['1K', '16:9', '1280x720'],
    ['1K', '9:16', '720x1280'],
    ['1K', '3:2', '1152x768'],
    ['1K', '2:3', '768x1152'],
    ['1K', '4:3', '1024x768'],
    ['1K', '3:4', '768x1024'],
    ['2K', '1:1', '2048x2048'],
    ['2K', '16:9', '2048x1152'],
    ['2K', '9:16', '1152x2048'],
    ['2K', '3:2', '2064x1376'],
    ['2K', '2:3', '1376x2064'],
    ['2K', '4:3', '2048x1536'],
    ['2K', '3:4', '1536x2048'],
    ['4K', '1:1', '2880x2880'],
    ['4K', '16:9', '3840x2160'],
    ['4K', '9:16', '2160x3840'],
    ['4K', '3:2', '3520x2352'],
    ['4K', '2:3', '2352x3520'],
    ['4K', '4:3', '3312x2480'],
    ['4K', '3:4', '2480x3312'],
    ] as const;
    for (const model of ['gpt-image-2', 'gpt-image-2.5'] as const) {
      for (const [resolution, ratio, size] of cases) {
        expect(newApiImageRequestParams(model, 1, ratio, resolution)).toMatchObject({
          n: 1,
          size,
          aspect_ratio: ratio,
          quality: 'medium',
        });
      }
    }
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
    expect(body.prompt).not.toContain('treat every supplied reference image as authoritative');

    const productConsistencyBody = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-product-consistency',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      preserveReferenceIdentity: true,
      inputImages: [reference],
      aspectRatio: '16:9',
      resolution: '2K',
      outputFormat: 'jpg',
      count: 1,
    }, [reference]);
    expect(productConsistencyBody.prompt)
      .toContain('treat every supplied reference image as authoritative');
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

  it('varies only the server-side USELG GPT Image 2 prompt per request', () => {
    const base = {
      userId: 'user-1',
      model: 'gpt-image-2',
      prompt: 'render a product cutout',
      inputImages: [],
      aspectRatio: '1:1' as const,
      resolution: '2K',
      outputFormat: 'jpg' as const,
      count: 1,
    };
    const first = buildNewApiImageGenerationBody({
      ...base,
      clientRequestId: 'uselg-rerun-1',
    }, [], false, 'USELG');
    const second = buildNewApiImageGenerationBody({
      ...base,
      clientRequestId: 'uselg-rerun-2',
    }, [], false, 'USELG');
    const nonUselg = buildNewApiImageGenerationBody({
      ...base,
      clientRequestId: 'uselg-rerun-1',
    }, [], false, 'NEW_API');

    expect(first.prompt).toContain(base.prompt);
    expect(first.prompt).toContain('fresh independent render');
    expect(first.prompt).not.toBe(second.prompt);
    expect(nonUselg.prompt).not.toContain('fresh independent render');
    expect(buildUselgImage2VariationPrompt(base.prompt, 'uselg-rerun-1'))
      .toBe(first.prompt.replace(/\n\nStrict image constraints:[\s\S]*$/, ''));
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

  it('returns the original GPT Image 2 result when no transparent background can be produced', async () => {
    const generated = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 32, g: 96, b: 160, alpha: 1 },
      },
    }).png().toBuffer();
    const original = `data:image/png;base64,${generated.toString('base64')}`;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      output: [{ result: generated.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(generateNewApiImages(
        { baseUrl: 'https://provider.example', name: 'Image2 channel' } as Parameters<typeof generateNewApiImages>[0],
        { apiKey: 'test-key', headers: {} },
        {
          userId: 'user-1',
          clientRequestId: 'request-transparent-fallback',
          model: 'gpt-image-2',
          prompt: 'remove only the background',
          inputImages: [],
          aspectRatio: '1:1',
          resolution: '2K',
          outputFormat: 'png',
          background: 'transparent',
          count: 1,
        },
      )).resolves.toEqual([original]);
    } finally {
      warn.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(multipartBody).not.toContain('treat every supplied reference image as authoritative');
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

  it('submits GPT Image 2.5 4K generations with the exact 3:2 dimensions', async () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      output: [{ result: rawPng }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'gpt-image-25-generation-4k',
        model: 'gpt-image-2.5',
        prompt: 'render the projector',
        inputImages: [],
        aspectRatio: '3:2',
        resolution: '4K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${rawPng}`]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/generations');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-image-2.5',
      size: '3520x2352',
      aspect_ratio: '3:2',
    });
  });

  it('keeps GPT Image 2.5 references on edits with exact 2K dimensions', async () => {
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const output = `data:image/png;base64,${(await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
    }).png().toBuffer()).toString('base64')}`;
    let multipartBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      multipartBody = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()).toString('utf8');
      return new Response(JSON.stringify({ output: [{ result: output.split(',')[1] }] }), {
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
        clientRequestId: 'gpt-image-25-edit-2k',
        model: 'gpt-image-2.5',
        prompt: 'redesign the handle',
        inputImages: [reference],
        aspectRatio: '3:2',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([output]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(multipartBody).toContain('name="model"\r\n\r\ngpt-image-2.5');
    expect(multipartBody).toContain('name="size"\r\n\r\n2064x1376');
    expect(multipartBody).toContain('name="aspect_ratio"\r\n\r\n3:2');
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

  it('polls a USELG async task through status_url and returns its signed asset', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.ai-media.vip/v1/images/tasks/imgtask-123?view=summary');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-uselg');
      return new Response(JSON.stringify({
        task_id: 'imgtask-123',
        status: 'success',
        assets: [{ signed_url: 'https://cdn.example.test/generated.png' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveUselgImageResponse(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        task_id: 'imgtask-123',
        status: 'queued',
        status_url: '/v1/images/tasks/imgtask-123?view=summary',
        poll_after_ms: 2_000,
      },
      [],
      1,
      async () => {},
    )).resolves.toEqual(['https://cdn.example.test/generated.png']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a large inline image immediately even when the USELG task state is processing', async () => {
    const generated = `iVBORw0KGgo${'C'.repeat(3 * 1024 * 1024)}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      task_id: 'imgtask-inline-processing',
      status: 'processing',
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated } }] } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const images = await resolveUselgImageResponse(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        task_id: 'imgtask-inline-processing',
        status: 'queued',
        status_url: '/v1/images/tasks/imgtask-inline-processing?view=summary',
        poll_after_ms: 2_000,
      },
      [],
      1,
      async () => {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    expect(images[0]?.length).toBe('data:image/png;base64,'.length + generated.length);
  });

  it('returns a signed asset immediately even when the USELG task state is processing', async () => {
    const signedUrl = 'https://cdn.example.test/generated-processing.png';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      task_id: 'imgtask-signed-processing',
      status: 'processing',
      assets: [{ signed_url: signedUrl }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveUselgImageResponse(
      { baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg', headers: {} },
      {
        task_id: 'imgtask-signed-processing',
        status: 'queued',
        status_url: '/v1/images/tasks/imgtask-signed-processing?view=summary',
        poll_after_ms: 2_000,
      },
      [],
      1,
      async () => {},
    )).resolves.toEqual([signedUrl]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times USELG result_url fetching without logging the result URL', async () => {
    const resultUrl = '/v1/images/tasks/imgtask-result/result?token=secret-result-token';
    const outputUrl = 'https://cdn.example.test/generated-result.png?signature=secret-signature';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'imgtask-result',
        status: 'success',
        result_url: resultUrl,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: outputUrl }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(resolveUselgImageResponse(
      { id: 'uselg-provider-result', baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg-result', headers: {} },
      {
        task_id: 'imgtask-result',
        status: 'queued',
        status_url: '/v1/images/tasks/imgtask-result?view=summary',
        poll_after_ms: 2_000,
      },
      [],
      1,
      async () => {},
      {
        clientRequestId: 'request-uselg-result',
        providerId: 'uselg-provider-result',
        model: 'gemini-3-pro-image-preview',
      },
    )).resolves.toEqual([outputUrl]);

    expect(info).toHaveBeenCalledWith('[uselg_image_result_fetch_started]', {
      clientRequestId: 'request-uselg-result',
      taskId: 'imgtask-result',
    });
    expect(info).toHaveBeenCalledWith('[uselg_image_result_fetch_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-result',
      taskId: 'imgtask-result',
      durationMs: expect.any(Number),
      hasImage: true,
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_resolve_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-result',
      taskId: 'imgtask-result',
      durationMs: expect.any(Number),
      sourceType: 'result_url',
    }));
    const serializedLogs = JSON.stringify(info.mock.calls);
    expect(serializedLogs).not.toContain(resultUrl);
    expect(serializedLogs).not.toContain(outputUrl);
    expect(serializedLogs).not.toContain('sk-uselg-result');
  });

  it('times USELG asset content fetching without logging the asset URL', async () => {
    const assetUrl = '/v1/images/assets/imgtask-asset/content?token=secret-asset-token';
    const output = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'imgtask-asset',
        status: 'success',
        assets: [{ download_url: assetUrl }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(resolveUselgImageResponse(
      { id: 'uselg-provider-asset', baseUrl: 'https://api.ai-media.vip', name: 'uselg', kind: 'USELG' } as never,
      { apiKey: 'sk-uselg-asset', headers: {} },
      {
        task_id: 'imgtask-asset',
        status: 'queued',
        status_url: '/v1/images/tasks/imgtask-asset?view=summary',
        poll_after_ms: 2_000,
      },
      [],
      1,
      async () => {},
      {
        clientRequestId: 'request-uselg-asset',
        providerId: 'uselg-provider-asset',
        model: 'gemini-3-pro-image-preview',
      },
    )).resolves.toEqual([output]);

    expect(info).toHaveBeenCalledWith('[uselg_image_asset_fetch_started]', {
      clientRequestId: 'request-uselg-asset',
      taskId: 'imgtask-asset',
      assetType: 'download_url',
    });
    expect(info).toHaveBeenCalledWith('[uselg_image_asset_fetch_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-asset',
      taskId: 'imgtask-asset',
      assetType: 'download_url',
      durationMs: expect.any(Number),
      hasImage: true,
    }));
    expect(info).toHaveBeenCalledWith('[uselg_image_resolve_complete]', expect.objectContaining({
      clientRequestId: 'request-uselg-asset',
      taskId: 'imgtask-asset',
      durationMs: expect.any(Number),
      sourceType: 'asset_content',
    }));
    const serializedLogs = JSON.stringify(info.mock.calls);
    expect(serializedLogs).not.toContain(assetUrl);
    expect(serializedLogs).not.toContain('sk-uselg-asset');
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

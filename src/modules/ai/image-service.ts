import type { AiCapability, AiProviderChannel, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
import { CloudAiError } from './service.js';
import { createImageReference } from './reference-store.js';

const DEFAULT_IMAGE_UNIT_CREDITS = BigInt(env.IMAGE_REQUEST_CREDITS);
const IMAGE_GENERATION_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REFERENCE_FETCH_TIMEOUT_MS = 30_000;
const MAX_IMAGE_REFERENCE_BYTES = 16 * 1024 * 1024;
const XAIS_MODEL_MAP: Record<string, string> = {
  'Xais Nano Pro_2K': 'Nano_Banana_Pro_2K_0',
  'Xais Nano Pro_4K': 'Nano_Banana_Pro_4K_0',
  'Xais Nano2_2K': 'Nano_Banana_2_2K_0',
  'Xais Nano2_4K': 'Nano_Banana_2_4K_0',
  'Xais Nano_Lite_1K': 'Xais_Nano_Lite_1K',
  'Xais Nano Pro_4K_png': 'Nano_Banana_Pro_4K_5',
  'Xais Nano2_4K_png': 'Nano_Banana_2_4K_5',
  'Xais img2_1k': 'Image2_1K',
  'Xais Img2_2K': 'Image2_2K',
  'Xais Img2_4K': 'Image2_4K',
  'Xais Img2_2K(高画质)': 'Xais_Img2_2K_H',
  'Xais Img2_4K(高画质)': 'Xais_Img2_4K_H',
};

const imageModelToken = (model: string) => model
  .trim()
  .toLowerCase()
  .replace(/preview/g, '')
  .replace(/[^a-z0-9]+/g, '');

type PricedImageResolution = '1k' | '2k' | '4k';

const pricedImageResolution = (model: string, resolution?: string): PricedImageResolution => {
  const token = imageModelToken(model);
  if (token.includes('4k')) return '4k';
  if (token.includes('2k')) return '2k';
  if (token.includes('1k')) return '1k';
  const requested = resolution?.trim().toLowerCase();
  if (requested === '1k' || requested === '4k') return requested;
  return '2k';
};

export function imageUnitCredits(model: string, resolution?: string) {
  const token = imageModelToken(model);
  const selectedResolution = pricedImageResolution(model, resolution);
  const isGptImage2 = token.includes('gptimage2')
    || token.includes('image2')
    || token.includes('img2');
  const isHighQuality = isGptImage2 && (
    model.includes('高画质')
    || token.endsWith('h')
    || token.includes('highquality')
  );

  if (isHighQuality) return selectedResolution === '4k' ? 35n : 30n;
  if (isGptImage2) {
    if (selectedResolution === '1k') return 10n;
    return selectedResolution === '4k' ? 18n : 15n;
  }

  const isNanoBananaPro = token.includes('nanobananapro')
    || token.includes('xaisnanopro')
    || token.includes('nanopro')
    || token.includes('gemini3proimage')
    || token.includes('gemini31proimage');
  if (isNanoBananaPro) return selectedResolution === '4k' ? 20n : 18n;

  const isNanoBanana2 = token.includes('nanobanana2')
    || token.includes('xaisnano2')
    || token.includes('nano2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage');
  if (isNanoBanana2) return selectedResolution === '4k' ? 18n : 15n;

  return DEFAULT_IMAGE_UNIT_CREDITS;
}

export function resolveNewApiImageModel(model: string) {
  const trimmed = model.trim();
  if (/^nano[\s_-]*banana[\s_-]*pro$/i.test(trimmed)) return 'gemini-3-pro-image';
  if (/^nano[\s_-]*banana[\s_-]*2$/i.test(trimmed)) return 'gemini-3.1-flash-image';
  if (/^gpt[\s_-]*image[\s_-]*2$/i.test(trimmed)) return 'gpt-image-2';
  return trimmed;
}

type ImageInput = {
  userId: string;
  clientRequestId: string;
  provider?: 'new-api' | 'xais-chat' | 'openai-compatible' | 'custom' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  negativePrompt?: string | undefined;
  inputImages: string[];
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  resolution?: string | undefined;
  outputFormat: 'jpg' | 'jpeg' | 'png' | 'webp';
  count: number;
};

class UpstreamImageError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UpstreamImageError';
  }
}

function upstreamErrorMessage(status: number, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;
  let detail = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const nested = record.error && typeof record.error === 'object'
        ? record.error as Record<string, unknown>
        : null;
      const candidate = nested?.message ?? record.message ?? record.error;
      if (typeof candidate === 'string' && candidate.trim()) detail = candidate.trim();
    }
  } catch {
    // Plain-text upstream errors are already useful.
  }
  return `HTTP ${status}: ${detail.replace(/\s+/g, ' ').slice(0, 800)}`;
}

async function listImageProviders(prisma: PrismaClient) {
  const common = { status: 'ACTIVE' as const, capabilities: { has: 'IMAGE' as const } };
  const providers = await prisma.aiProviderChannel.findMany({
    where: common,
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
  return providers.filter((provider) => !provider.capabilities.includes('LLM'));
}

async function selectImageProvider(prisma: PrismaClient, providerChannelId?: string) {
  const providers = await listImageProviders(prisma);
  const provider = providerChannelId
    ? providers.find((candidate) => candidate.id === providerChannelId)
    : chooseProviderForCapability(providers, 'IMAGE');
  if (!provider) {
    throw new CloudAiError(
      'provider_unavailable',
      providerChannelId ? '所选生图渠道不可用或已被停用' : '当前没有可用的生图渠道',
      503,
    );
  }
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
}

export function chooseProviderForCapability<T extends Pick<AiProviderChannel, 'capabilities'>>(
  providers: T[],
  capability: AiCapability,
) {
  const eligible = capability === 'LLM'
    ? providers
    : providers.filter((provider) => !provider.capabilities.includes('LLM'));
  return eligible[0];
}

export function resolveImageModel(
  provider: Pick<AiProviderChannel, 'defaultModel' | 'kind'>,
  requestedModel: string,
) {
  const requested = requestedModel.trim();
  if (requested) return provider.kind === 'NEW_API' ? resolveNewApiImageModel(requested) : requested;
  const configured = provider.defaultModel?.trim();
  if (configured) return provider.kind === 'NEW_API' ? resolveNewApiImageModel(configured) : configured;
  throw new CloudAiError('provider_model_missing', '生图请求和渠道都没有配置模型', 503);
}

function upstreamHeaders(secrets: ProviderSecrets) {
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${secrets.apiKey}`,
    'content-type': 'application/json',
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
  return headers;
}

function parseProviderValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const eventValues = Array.from(trimmed.matchAll(/^data:\s*(.+)$/gmi))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value && value !== '[DONE]'));
  if (eventValues.length) {
    return eventValues.map((value) => {
      try { return JSON.parse(value) as unknown; } catch { return value; }
    });
  }
  try { return JSON.parse(trimmed) as unknown; } catch { return trimmed; }
}

async function providerRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  path: string,
  body?: unknown,
  timeoutOverrideMs?: number,
) {
  const controller = new AbortController();
  const timeoutMs = timeoutOverrideMs ?? (/(?:video|workerTask)/i.test(path) ? 10 * 60_000 : 4 * 60_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: upstreamHeaders(secrets),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamImageError(response.status, upstreamErrorMessage(response.status, text));
    }
    return parseProviderValue(text);
  } catch (error) {
    if (error instanceof UpstreamImageError) throw error;
    throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeRawImageBase64(value: string) {
  const compact = value.replace(/\s+/g, '');
  return compact.length >= 32 && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(compact);
}

function rawImageBase64Mime(value: string) {
  const compact = value.replace(/\s+/g, '');
  if (compact.startsWith('/9j/')) return 'image/jpeg';
  if (compact.startsWith('R0lGOD')) return 'image/gif';
  if (compact.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function collectImageStrings(value: unknown, output: string[] = [], contextKey = ''): string[] {
  if (!value) return output;
  if (typeof value === 'string') {
    const dataUrls = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g);
    if (dataUrls) output.push(...dataUrls);
    output.push(...Array.from(value.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map((match) => match[1] ?? ''));
    const urls = value.match(/https?:\/\/[^\s"'<>)}\]]+/gi);
    if (!dataUrls && !urls && /(?:image|result|output|data|base64|source)/i.test(contextKey) && looksLikeRawImageBase64(value)) {
      const compact = value.replace(/\s+/g, '');
      output.push(`data:${rawImageBase64Mime(compact)};base64,${compact}`);
    }
    if (urls) output.push(...urls.map((url) => url.replace(/[.,;，。；]+$/g, '')));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageStrings(item, output, contextKey);
    return output;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const inlineMime = record.mime_type ?? record.mimeType ?? record.media_type ?? record.mediaType;
    const inlineData = record.data ?? record.base64 ?? record.b64_json;
    if (typeof inlineMime === 'string' && inlineMime.startsWith('image/') && typeof inlineData === 'string') {
      output.push(`data:${inlineMime};base64,${inlineData.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')}`);
    }
    for (const [key, nested] of Object.entries(record)) {
      const normalized = key.toLowerCase();
      if (typeof nested === 'string') {
        if (normalized === 'b64_json' || normalized === 'image_base64' || normalized === 'base64') {
          output.push(`data:image/png;base64,${nested.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')}`);
          continue;
        }
        if (/^https?:\/\//i.test(nested) && /(url|uri|href|download|output|image|file|result)/i.test(normalized)) {
          output.push(nested);
          continue;
        }
      }
      collectImageStrings(nested, output, normalized);
    }
  }
  return output;
}

export function collectProviderModelIds(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const data: unknown = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return Array.from(new Set(data.map((item: unknown) => (
    item && typeof item === 'object' ? (item as Record<string, unknown>).id : null
  )).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())))
    .slice(0, 200);
}

export async function listWalletImageModels(
  prisma: PrismaClient,
) {
  const providers = await listImageProviders(prisma);
  if (!providers.length) {
    throw new CloudAiError('provider_unavailable', '当前没有可用的生图渠道', 503);
  }
  const channels = await Promise.all(providers.map(async (provider) => {
    try {
      await assertPublicProviderUrl(provider.baseUrl);
      const secrets = decryptProviderSecrets(provider.encryptedSecrets);
      const value = await providerRequest(provider, secrets, '/v1/models', undefined, 15_000);
      return {
        id: provider.id,
        name: provider.name,
        provider: provider.kind,
        defaultModel: provider.defaultModel,
        models: collectProviderModelIds(value),
        error: null,
      };
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        provider: provider.kind,
        defaultModel: provider.defaultModel,
        models: [] as string[],
        error: error instanceof Error ? error.message.slice(0, 800) : '读取模型失败',
      };
    }
  }));
  const firstAvailable = channels.find((channel) => !channel.error) ?? channels[0]!;
  return {
    provider: firstAvailable.provider,
    defaultModel: firstAvailable.defaultModel,
    models: Array.from(new Set(channels.flatMap((channel) => channel.models))),
    channels,
  };
}

export function uniqueImages(value: unknown, inputImages: string[], count: number) {
  const inputs = new Set(inputImages.map((value) => value.trim()));
  return Array.from(new Set(collectImageStrings(value).map((value) => value.trim()).filter(Boolean)))
    .filter((value) => !inputs.has(value))
    .slice(0, count);
}

export function sizeFromRatio(ratio: ImageInput['aspectRatio']) {
  if (ratio === '9:16') return '1024x1792';
  if (ratio === '16:9') return '1792x1024';
  if (ratio === '3:4') return '1024x1536';
  if (ratio === '4:3') return '1536x1024';
  return '1024x1024';
}

function supportsNewApiImageResolution(model: string) {
  const token = imageModelToken(model);
  return token.includes('gemini3proimage')
    || token.includes('gemini31proimage')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')
    || token.includes('gptimage2');
}

export function newApiImageRequestParams(
  model: string,
  count: number,
  ratio: ImageInput['aspectRatio'],
  resolution?: string,
) {
  if (!supportsNewApiImageResolution(model)) {
    return { n: count, size: sizeFromRatio(ratio), aspect_ratio: ratio, ratio };
  }
  const highResolution = resolution?.trim().toLowerCase() === '4k';
  const size = ratio === '9:16'
    ? highResolution ? '2160x3840' : '1088x1920'
    : ratio === '16:9'
      ? highResolution ? '3840x2160' : '1920x1088'
      : ratio === '3:4'
        ? highResolution ? '2400x3200' : '960x1280'
        : ratio === '4:3'
          ? highResolution ? '3200x2400' : '1280x960'
          : highResolution ? '2880x2880' : '1024x1024';
  return {
    n: count,
    size,
    aspect_ratio: ratio,
    ratio,
    quality: highResolution ? 'high' : 'standard',
  };
}

function promptWithConstraints(input: ImageInput) {
  const constraints = [`must output exactly ${input.aspectRatio} aspect ratio`];
  if (input.resolution) constraints.push(`target resolution ${input.resolution}`);
  return `${input.prompt.trim()}\n\nStrict image constraints: ${constraints.join(', ')}.`;
}

function chatContent(input: ImageInput, inputImages = input.inputImages) {
  const prompt = promptWithConstraints(input);
  if (!inputImages.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...inputImages.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

export function buildNewApiChatImageBody(input: ImageInput, inputImages = input.inputImages) {
  const imageParams = newApiImageRequestParams(
    input.model,
    input.count,
    input.aspectRatio,
    input.resolution,
  );
  return {
    model: input.model,
    ...imageParams,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    messages: [{ role: 'user', content: chatContent(input, inputImages) }],
    modalities: ['image'],
    stream: false,
    max_tokens: 8192,
  };
}

export function isGeminiNativeImageModel(model: string) {
  const token = imageModelToken(model);
  return token.includes('gemini') || token.includes('nanobanana');
}

export function buildGeminiNativeImageBody(input: ImageInput, inputImages = input.inputImages) {
  const imageParts = inputImages.map((source) => {
    const { bytes, mime } = dataUrlImageBytes(source);
    return {
      inlineData: {
        mimeType: mime,
        data: bytes.toString('base64'),
      },
    };
  });
  const imageSize = pricedImageResolution(input.model, input.resolution).toUpperCase();
  return {
    contents: [{
      role: 'user',
      parts: [
        {
          text: input.negativePrompt
            ? `${promptWithConstraints(input)}\n\nAvoid: ${input.negativePrompt.trim()}`
            : promptWithConstraints(input),
        },
        ...imageParts,
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: input.aspectRatio,
        imageSize,
      },
    },
  };
}

function geminiNativeModelName(model: string) {
  return model.trim().replace(/^models\//i, '');
}

function referenceSourceLabel(source: string) {
  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    return 'inline-reference';
  }
}

async function materializeNewApiReferenceImages(inputImages: string[]) {
  return Promise.all(inputImages.map(async (source) => {
    try {
      const materialized = await materializeNewApiReferenceImage(source);
      if (!/^data:image\//i.test(materialized)) {
        throw new Error('reference is not an HTTP image or supported data URL');
      }
      return materialized;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UpstreamImageError(
        502,
        `Reference image download failed (${referenceSourceLabel(source)}): ${detail}`,
      );
    }
  }));
}

async function generateGeminiNativeImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
  materializedInputImages: string[],
) {
  const nativeBody = buildGeminiNativeImageBody(input, materializedInputImages);
  const nativeValues: unknown[] = [];
  for (let index = 0; index < input.count; index += 1) {
    nativeValues.push(await providerRequest(
      provider,
      secrets,
      `/v1beta/models/${encodeURIComponent(geminiNativeModelName(input.model))}:generateContent`,
      nativeBody,
      IMAGE_GENERATION_TIMEOUT_MS,
    ));
  }
  return nativeValues;
}

function imageMimeFromBytes(bytes: Uint8Array) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) return 'image/gif';
  return '';
}

async function readLimitedImageBody(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_REFERENCE_BYTES) {
    throw new Error('reference image is too large');
  }
  if (!response.body) throw new Error('reference image response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_REFERENCE_BYTES) {
      await reader.cancel();
      throw new Error('reference image is too large');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  const detectedMime = imageMimeFromBytes(bytes);
  const mime = headerMime.startsWith('image/') ? headerMime : detectedMime;
  if (!mime) throw new Error('reference URL did not return an image');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * NewAPI-compatible image endpoints handle data URLs more consistently than
 * temporary public URLs. Materialize public references in memory only; never
 * persist them, log them, or forward a local/private URL.
 */
export async function materializeNewApiReferenceImage(source: string) {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REFERENCE_FETCH_TIMEOUT_MS);
  try {
    let current = new URL(trimmed);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      await assertPublicProviderUrl(current.toString());
      const response = await fetch(current, {
        method: 'GET',
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount >= 3) throw new Error('reference image redirect is invalid');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`reference image HTTP ${response.status}`);
      return await readLimitedImageBody(response);
    }
    return trimmed;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateNewApiImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  if (isGeminiNativeImageModel(input.model)) {
    const directPublicReferences = input.inputImages.every((source) => /^https?:\/\//i.test(source.trim()));
    if (directPublicReferences) {
      for (const source of input.inputImages) await assertPublicProviderUrl(source);
      const value = await providerRequest(
        provider,
        secrets,
        '/v1/chat/completions',
        buildNewApiChatImageBody(input, input.inputImages),
        IMAGE_GENERATION_TIMEOUT_MS,
      );
      const images = uniqueImages(value, input.inputImages, input.count);
      if (images.length) return images;
      throw new Error('渠道没有返回图片数据');
    }
    const materializedInputImages = await materializeNewApiReferenceImages(input.inputImages);
    const value = await generateGeminiNativeImages(
      provider,
      secrets,
      input,
      materializedInputImages,
    );
    const images = uniqueImages(value, input.inputImages, input.count);
    if (images.length) return images;
    throw new Error('渠道没有返回图片数据');
  }
  const materializedInputImages = await materializeNewApiReferenceImages(input.inputImages);
  const preparedInputImages = materializedInputImages.map((source, index) => {
    try {
      const dataUrl = source;
      if (!/^data:image\//i.test(dataUrl)) return dataUrl;
      const { bytes, mime } = dataUrlImageBytes(dataUrl);
      return createImageReference(bytes, mime);
    } catch {
      // Keep the public URL as a compatibility fallback when a remote host
      // cannot be fetched by the wallet server.
      return input.inputImages[index] ?? source;
    }
  });
  const value = await providerRequest(
    provider,
    secrets,
    '/v1/chat/completions',
    buildNewApiChatImageBody(input, preparedInputImages),
    IMAGE_GENERATION_TIMEOUT_MS,
  );
  const images = uniqueImages(value, input.inputImages, input.count);
  if (images.length) return images;
  throw new Error('渠道没有返回图片数据');
}

export function resolveXaisModel(model: string) {
  const trimmed = model.trim();
  const exact = XAIS_MODEL_MAP[trimmed];
  if (exact) return exact;
  const token = imageModelToken(trimmed);
  if (/^(?:xais)?(?:nanobanana|nano)pro2k0?$/.test(token)) return 'Nano_Banana_Pro_2K_0';
  if (/^(?:xais)?(?:nanobanana|nano)pro4k0?$/.test(token)) return 'Nano_Banana_Pro_4K_0';
  if (/^(?:xais)?(?:nanobanana|nano)22k0?$/.test(token)) return 'Nano_Banana_2_2K_0';
  if (/^(?:xais)?(?:nanobanana|nano)24k0?$/.test(token)) return 'Nano_Banana_2_4K_0';
  if (/^(?:xais)?(?:img2|image2)1k$/.test(token)) return 'Image2_1K';
  if (/^(?:xais)?(?:img2|image2)2k$/.test(token)) return 'Image2_2K';
  if (/^(?:xais)?(?:img2|image2)4k$/.test(token)) return 'Image2_4K';
  if (/^(?:xais)?(?:img2|image2)2k(?:h|high|highquality)$/.test(token)) return 'Xais_Img2_2K_H';
  if (/^(?:xais)?(?:img2|image2)4k(?:h|high|highquality)$/.test(token)) return 'Xais_Img2_4K_H';
  return trimmed;
}

function isXaisWorkerModel(model: string) {
  return /^(?:Nano_Banana|Image2_|Xais_)/i.test(resolveXaisModel(model));
}

const XAIS_NANO_RATIO_OPTIONS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '21:9', '3:4', '1:4', '4:1', '1:8', '8:1'];
const XAIS_IMAGE2_1K_RATIO_OPTIONS = ['1:1', '9:16', '4:3', '3:4', '5:4'];
const XAIS_IMAGE2_2K_RATIO_OPTIONS = [
  '2048x2048', '2048x1152', '1152x2048', '2064x1376', '1376x2064', '2048x1536', '1536x2048',
  '2016x864', '864x2016', '2080x1664', '1664x2080', '2048x1024', '2064x688',
];
const XAIS_IMAGE2_4K_RATIO_OPTIONS = [
  '2880x2880', '3840x2160', '2160x3840', '3520x2352', '2352x3520', '3312x2480', '2480x3312',
  '3840x1648', '1648x3840', '3216x2576', '2576x3216', '3840x1920', '3840x1280', '1280x3840',
];

function ratioValue(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?::|x)\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 1;
}

export function resolveXaisWorkerRatio(model: string, aspectRatio: string) {
  const requestModel = resolveXaisModel(model);
  const options = /^Nano_Banana|^Xais_Nano_Lite/i.test(requestModel)
    ? XAIS_NANO_RATIO_OPTIONS
    : /(?:Img2|Image2)_.*4K/i.test(requestModel)
      ? XAIS_IMAGE2_4K_RATIO_OPTIONS
      : /(?:Img2|Image2)_.*2K/i.test(requestModel)
        ? XAIS_IMAGE2_2K_RATIO_OPTIONS
        : /(?:Img2|Image2)_.*1K/i.test(requestModel)
          ? XAIS_IMAGE2_1K_RATIO_OPTIONS
          : [];
  if (!options.length) return aspectRatio || '1:1';
  if (options.includes(aspectRatio)) return aspectRatio;
  const target = ratioValue(aspectRatio || '1:1');
  return options.reduce((best, option) => (
    Math.abs(ratioValue(option) - target) < Math.abs(ratioValue(best) - target) ? option : best
  ), options[0]!);
}

function isXaisOverloadMessage(value: unknown) {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /(?:busy|overload|overloaded|capacity|no available (?:worker|resource)|resource exhausted|temporarily unavailable|算力(?:紧张|不足|已满)|暂无可用算力|资源不足|系统繁忙|服务繁忙|排队已满)/i.test(message);
}

export function isRetryableXaisPollError(value: unknown) {
  if (value instanceof UpstreamImageError) {
    return value.status === 0
      || value.status === 408
      || value.status === 409
      || value.status === 425
      || value.status === 429
      || value.status >= 500;
  }
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /(?:abort|timed?\s*out|timeout|fetch failed|network|connection|socket|temporar(?:y|ily)|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i.test(message);
}

function findXaisUploadTarget(value: unknown): { url: string; name: string } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findXaisUploadTarget(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const url = [record.url, record.uploadUrl, record.upload_url]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  const name = [record.name, record.att, record.attachment, record.key]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  if (url && name) return { url: url.trim(), name: name.trim() };
  for (const key of ['data', 'result', 'upload', 'attachment']) {
    const found = findXaisUploadTarget(record[key]);
    if (found) return found;
  }
  return null;
}

function dataUrlImageBytes(source: string) {
  const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('reference image is not a supported data URL');
  const mime = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_REFERENCE_BYTES) throw new Error('reference image size is invalid');
  return { bytes, mime };
}

async function uploadXaisReferenceImage(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  source: string,
) {
  const trimmed = source.trim();
  if (!/^(?:https?:|data:image\/)/i.test(trimmed)) return trimmed;
  const dataUrl = /^data:image\//i.test(trimmed)
    ? trimmed
    : await materializeNewApiReferenceImage(trimmed);
  const { bytes, mime } = dataUrlImageBytes(dataUrl);
  const extension = mime.includes('png') ? 'png'
    : mime.includes('webp') ? 'webp'
      : mime.includes('gif') ? 'gif' : 'jpg';
  const uploadValue = await providerRequest(
    provider,
    secrets,
    `/xais/fileAttachmentUploadUrl?ext=${encodeURIComponent(extension)}`,
    undefined,
    30_000,
  );
  const upload = findXaisUploadTarget(uploadValue);
  if (!upload) throw new Error('XAIS reference upload URL response is missing url/name');
  await assertPublicProviderUrl(upload.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`XAIS reference upload failed with HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
  try {
    await providerRequest(
      provider,
      secrets,
      `/xais/attUrls?att=${encodeURIComponent(upload.name)}`,
      undefined,
      30_000,
    );
  } catch {
    // XAIS currently treats this registration call as best-effort.
  }
  return upload.name;
}

function getTaskId(value: unknown): string {
  if (!value) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = getTaskId(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim().replace(/^"+|"+$/g, '');
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['task_id', 'taskId', 'taskid', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate).trim();
  }
  for (const key of ['data', 'result', 'results', 'task', 'tasks', 'response']) {
    const found = getTaskId(record[key]);
    if (found) return found;
  }
  return '';
}

export const parseXaisTaskId = getTaskId;

function getFailure(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = getFailure(item);
      if (found) return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'err', 'fail_reason', 'failure_reason']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (/^(failed|failure|error|cancelled|canceled)$/.test(status)) {
    return typeof record.message === 'string' ? record.message : status;
  }
  for (const key of ['data', 'result', 'task', 'response']) {
    const found = getFailure(record[key]);
    if (found) return found;
  }
  return '';
}

function collectAttachmentIds(value: unknown, output: string[] = [], trusted = false): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim().replace(/^"+|"+$/g, '');
    if (trusted && text && text.length <= 512 && !/^(?:https?:|data:)/i.test(text)) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, output, trusted);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectAttachmentIds(nested, output, trusted || /^(result|results|att|atts|attachment|attachments|output|outputs|file|files|url|urls|uri|uris|href|download|downloads)$/i.test(key));
    }
  }
  return Array.from(new Set(output));
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startXaisWorkerTaskWithRetry(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  body: unknown,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await delay(1_800 * attempt);
    try {
      const started = await providerRequest(provider, secrets, '/xais/workerTaskStart', body, 90_000);
      const failure = getFailure(started);
      if (!failure) return started;
      lastError = new Error(failure);
      if (!isXaisOverloadMessage(failure)) throw lastError;
    } catch (error) {
      lastError = error;
      if (!isXaisOverloadMessage(error)) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(typeof lastError === 'string' ? lastError : JSON.stringify(lastError ?? 'XAIS worker task failed'));
}

async function runXaisWorkerTask(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const model = resolveXaisModel(input.model);
  const isNanoModel = /(?:Nano_Banana|Xais_Nano)/i.test(model);
  const isNanoLiteModel = /Lite/i.test(model);
  const referenceInputs: string[] = [];
  for (const source of input.inputImages) {
    referenceInputs.push(await uploadXaisReferenceImage(provider, secrets, source));
  }
  const started = await startXaisWorkerTaskWithRetry(provider, secrets, {
    prompt: input.prompt,
    model,
    ratio: resolveXaisWorkerRatio(model, input.aspectRatio),
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(referenceInputs.length ? { ref: referenceInputs } : {}),
    ...(!isNanoModel ? { client: 'XAIS' } : {}),
    custom_field: {
      outputFormat: input.outputFormat === 'png'
        ? 'image/png'
        : input.outputFormat === 'webp' ? 'image/webp' : 'image/jpeg',
      ...(!isNanoModel || isNanoLiteModel ? { quality: /_H$/i.test(model) ? 'high' : 'medium' } : {}),
    },
  });
  const immediate = uniqueImages(started, input.inputImages, 1);
  if (immediate.length) return immediate[0]!;
  const startFailure = getFailure(started);
  if (startFailure) throw new Error(startFailure);
  const taskId = getTaskId(started);
  if (!taskId) {
    throw new Error(`Xais 没有返回任务 ID：${JSON.stringify(started).slice(0, 240)}`);
  }
  const deadline = Date.now() + IMAGE_GENERATION_TIMEOUT_MS;
  let lastTransientError: unknown = null;
  while (Date.now() < deadline) {
    await delay(2_200);
    let waited: unknown;
    try {
      waited = await providerRequest(
        provider,
        secrets,
        `/xais/workerTaskWait?json=1&id=${encodeURIComponent(taskId)}`,
        undefined,
        45_000,
      );
      lastTransientError = null;
    } catch (error) {
      if (!isRetryableXaisPollError(error)) throw error;
      lastTransientError = error;
      continue;
    }
    const failure = getFailure(waited);
    if (failure) throw new Error(failure);
    const images = uniqueImages(waited, input.inputImages, 1);
    if (images.length) return images[0]!;
    for (const attachment of collectAttachmentIds(waited)) {
      let resolved: unknown;
      try {
        resolved = await providerRequest(
          provider,
          secrets,
          `/xais/attUrls?att=${encodeURIComponent(attachment)}`,
          undefined,
          45_000,
        );
        lastTransientError = null;
      } catch (error) {
        if (!isRetryableXaisPollError(error)) throw error;
        lastTransientError = error;
        continue;
      }
      const resolvedImages = uniqueImages(resolved, input.inputImages, 1);
      if (resolvedImages.length) return resolvedImages[0]!;
    }
  }
  const detail = lastTransientError instanceof Error ? `：${lastTransientError.message}` : '';
  throw new Error(`XAIS 生图任务等待超时${detail}`);
}

async function generateXaisImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  if (isXaisWorkerModel(input.model)) {
    const results: string[] = [];
    for (let index = 0; index < input.count; index += 1) {
      results.push(await runXaisWorkerTask(provider, secrets, input));
    }
    return Array.from(new Set(results)).slice(0, input.count);
  }
  try {
    const value = await providerRequest(provider, secrets, '/v1/images/generations', {
      model: resolveXaisModel(input.model),
      prompt: promptWithConstraints(input),
      n: input.count,
      size: sizeFromRatio(input.aspectRatio),
      response_format: 'url',
    }, IMAGE_GENERATION_TIMEOUT_MS);
    const images = uniqueImages(value, input.inputImages, input.count);
    if (images.length) return images;
  } catch (error) {
    if (error instanceof UpstreamImageError && error.status === 401) throw error;
  }
  const value = await providerRequest(provider, secrets, '/v1/chat/completions', {
    model: resolveXaisModel(input.model),
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    messages: [{ role: 'user', content: chatContent(input) }],
    stream: false,
    max_tokens: 8192,
  }, IMAGE_GENERATION_TIMEOUT_MS);
  return uniqueImages(value, input.inputImages, input.count);
}

async function reserveImageCredits(prisma: PrismaClient, input: ImageInput) {
  const estimated = imageUnitCredits(input.model, input.resolution) * BigInt(input.count);
  const requestId = await prisma.$transaction(async (transaction) => {
    let existing = await transaction.aiRequest.findUnique({
      where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    });
    const reusableRequest = existing && (existing.status === 'FAILED' || existing.status === 'REFUNDED')
      ? existing
      : null;
    if (reusableRequest) existing = null;
    if (existing) throw new CloudAiError('duplicate_request', '该生图请求已经提交过', 409);
    const updated = await transaction.wallet.updateMany({
      where: { userId: input.userId, availableCredits: { gte: estimated } },
      data: { availableCredits: { decrement: estimated }, reservedCredits: { increment: estimated } },
    });
    if (updated.count !== 1) throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
    const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    if (reusableRequest) {
      const request = await transaction.aiRequest.update({
        where: { id: reusableRequest.id },
        data: { status: 'RESERVED', logicalModel: input.model, estimatedCredits: estimated, chargedCredits: 0n, completedAt: null },
      });
      await transaction.walletLedger.create({
        data: {
          userId: input.userId,
          requestId: request.id,
          type: 'RESERVE',
          amount: -estimated,
          balanceAfter: wallet.availableCredits,
          description: '生图重试预扣',
        },
      });
      return request.id;
    }
    const request = await transaction.aiRequest.create({
      data: {
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        capability: 'IMAGE',
        logicalModel: input.model,
        status: 'RESERVED',
        estimatedCredits: estimated,
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId: input.userId,
        requestId: request.id,
        type: 'RESERVE',
        amount: -estimated,
        balanceAfter: wallet.availableCredits,
        description: `生图预扣 ${input.count} 张`,
      },
    });
    return request.id;
  });
  return { requestId, estimated };
}

async function settleImageCredits(
  prisma: PrismaClient,
  input: ImageInput,
  requestId: string,
  estimated: bigint,
  generatedCount: number,
) {
  const charged = imageUnitCredits(input.model, input.resolution) * BigInt(generatedCount);
  const refund = estimated - charged;
  await prisma.$transaction(async (transaction) => {
    const wallet = await transaction.wallet.update({
      where: { userId: input.userId },
      data: {
        reservedCredits: { decrement: estimated },
        ...(refund > 0n ? { availableCredits: { increment: refund } } : {}),
        lifetimeConsumed: { increment: charged },
      },
    });
    await transaction.aiRequest.update({
      where: { id: requestId },
      data: { status: 'SUCCEEDED', chargedCredits: charged, completedAt: new Date() },
    });
    await transaction.walletLedger.create({
      data: {
        userId: input.userId,
        requestId,
        type: 'CHARGE',
        amount: charged,
        balanceAfter: wallet.availableCredits,
        description: `生图结算 ${generatedCount} 张`,
      },
    });
    if (refund > 0n) {
      await transaction.walletLedger.create({
        data: {
          userId: input.userId,
          requestId,
          type: 'RELEASE',
          amount: refund,
          balanceAfter: wallet.availableCredits,
          description: '生图未返回完整数量，释放剩余额度',
        },
      });
    }
  });
  return charged;
}

async function releaseImageCredits(
  prisma: PrismaClient,
  input: ImageInput,
  requestId: string,
  estimated: bigint,
) {
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== input.userId || (request.status !== 'RESERVED' && request.status !== 'PROCESSING')) return;
    const wallet = await transaction.wallet.update({
      where: { userId: input.userId },
      data: { availableCredits: { increment: estimated }, reservedCredits: { decrement: estimated } },
    });
    await transaction.aiRequest.update({
      where: { id: requestId },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    await transaction.walletLedger.create({
      data: {
        userId: input.userId,
        requestId,
        type: 'RELEASE',
        amount: estimated,
        balanceAfter: wallet.availableCredits,
        description: '生图失败，释放预扣额度',
      },
    });
  });
}

export async function executeWalletImageGeneration(prisma: PrismaClient, input: ImageInput) {
  const provider = await selectImageProvider(prisma, input.providerChannelId);
  const effectiveInput = { ...input, model: resolveImageModel(provider, input.model) };
  const reservation = await reserveImageCredits(prisma, effectiveInput);
  try {
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const images = provider.kind === 'XAIS'
      ? await generateXaisImages(provider, secrets, effectiveInput)
      : await generateNewApiImages(provider, secrets, effectiveInput);
    if (!images.length) throw new Error('渠道没有返回图片数据');
    const charged = await settleImageCredits(
      prisma,
      effectiveInput,
      reservation.requestId,
      reservation.estimated,
      images.length,
    );
    return {
      images,
      provider: provider.kind,
      providerChannelId: provider.id,
      providerChannelName: provider.name,
      model: effectiveInput.model,
      chargedCredits: charged.toString(),
    };
  } catch (error) {
    await releaseImageCredits(prisma, effectiveInput, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    if (error instanceof UpstreamImageError) {
      throw new CloudAiError(
        error.status === 401 ? 'provider_auth_failed' : 'provider_request_failed',
        error.status === 401
          ? '生图渠道鉴权失败，请管理员检查渠道密钥'
          : `生图渠道请求失败：${error.message}`,
        502,
      );
    }
    throw new CloudAiError(
      'image_generation_failed',
      error instanceof Error ? error.message : '生图失败',
      502,
    );
  }
}

export type VideoInput = {
  userId: string;
  clientRequestId: string;
  provider?: 'new-api' | 'xais-chat' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  inputImages: string[];
  aspectRatio: string;
  resolution?: string | undefined;
  duration?: number | undefined;
  inputMode?: 'REF' | 'FLF' | undefined;
  count: number;
};

const VIDEO_CREDITS = BigInt(env.VIDEO_REQUEST_CREDITS);

function estimatedVideoCredits(input: VideoInput) {
  return VIDEO_CREDITS * BigInt(input.count);
}

function videoProviderKind(provider?: VideoInput['provider']) {
  if (provider === 'xais-chat') return 'XAIS' as const;
  if (provider === 'new-api') return 'NEW_API' as const;
  return undefined;
}

async function selectVideoProvider(prisma: PrismaClient, preference?: VideoInput['provider'], providerChannelId?: string) {
  const kind = videoProviderKind(preference);
  const common = { status: 'ACTIVE' as const, capabilities: { has: 'VIDEO' as const } };
  if (providerChannelId) {
    const selected = await prisma.aiProviderChannel.findFirst({ where: { ...common, id: providerChannelId, ...(kind ? { kind } : {}) } });
    if (!selected) throw new CloudAiError('provider_unavailable', '所选视频渠道不可用或已被停用', 503);
    await assertPublicProviderUrl(selected.baseUrl);
    return selected;
  }
  const preferred = kind
    ? await prisma.aiProviderChannel.findMany({ where: { ...common, kind }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }] })
    : [];
  const fallback = preferred.length === 0
    ? await prisma.aiProviderChannel.findMany({ where: common, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }] })
    : [];
  const provider = chooseProviderForCapability(preferred.length ? preferred : fallback, 'VIDEO');
  if (!provider) throw new CloudAiError('provider_unavailable', '当前没有可用的视频渠道', 503);
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
}

function xaisVideoBody(input: VideoInput) {
  return {
    prompt: input.prompt,
    model: input.model,
    ref: input.inputImages,
    ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
    custom_field: {
      res: input.resolution || '720p',
      input: input.inputMode || 'REF',
      duration: String(input.duration || 15),
      outputFormat: 'video/mp4',
    },
  };
}

async function reserveVideo(prisma: PrismaClient, input: VideoInput) {
  const estimated = estimatedVideoCredits(input);
  return prisma.$transaction(async (transaction) => {
    let existing = await transaction.aiRequest.findUnique({ where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } } });
    const reusableRequest = existing && (existing.status === 'FAILED' || existing.status === 'REFUNDED')
      ? existing
      : null;
    if (reusableRequest) existing = null;
    if (existing) throw new CloudAiError('duplicate_request', '该视频请求已经提交过', 409);
    const updated = await transaction.wallet.updateMany({
      where: { userId: input.userId, availableCredits: { gte: estimated } },
      data: { availableCredits: { decrement: estimated }, reservedCredits: { increment: estimated } },
    });
    if (updated.count !== 1) throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
    const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    const request = reusableRequest
      ? await transaction.aiRequest.update({ where: { id: reusableRequest.id }, data: { status: 'RESERVED', logicalModel: input.model, estimatedCredits: estimated, chargedCredits: 0n, completedAt: null } })
      : await transaction.aiRequest.create({ data: { userId: input.userId, clientRequestId: input.clientRequestId, capability: 'VIDEO', logicalModel: input.model, status: 'RESERVED', estimatedCredits: estimated } });
    await transaction.walletLedger.create({ data: { userId: input.userId, requestId: request.id, type: 'RESERVE', amount: -estimated, balanceAfter: wallet.availableCredits, description: '视频请求预扣' } });
    return { requestId: request.id, estimated };
  });
}

async function settleVideo(prisma: PrismaClient, userId: string, requestId: string, charged: bigint) {
  await prisma.$transaction(async (transaction) => {
    const wallet = await transaction.wallet.update({ where: { userId }, data: { reservedCredits: { decrement: charged }, lifetimeConsumed: { increment: charged } } });
    await transaction.aiRequest.update({ where: { id: requestId }, data: { status: 'SUCCEEDED', chargedCredits: charged, completedAt: new Date() } });
    await transaction.walletLedger.create({ data: { userId, requestId, type: 'CHARGE', amount: charged, balanceAfter: wallet.availableCredits, description: '视频请求结算' } });
  });
}

async function releaseVideo(prisma: PrismaClient, userId: string, requestId: string, released: bigint) {
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || (request.status !== 'RESERVED' && request.status !== 'PROCESSING')) return;
    const wallet = await transaction.wallet.update({ where: { userId }, data: { availableCredits: { increment: released }, reservedCredits: { decrement: released } } });
    await transaction.aiRequest.update({ where: { id: requestId }, data: { status: 'FAILED', completedAt: new Date() } });
    await transaction.walletLedger.create({ data: { userId, requestId, type: 'RELEASE', amount: released, balanceAfter: wallet.availableCredits, description: '视频请求失败，释放额度' } });
  });
}

async function refundVideoRequest(prisma: PrismaClient, userId: string, clientRequestId: string) {
  return prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
    if (!request || request.capability !== 'VIDEO' || request.status === 'REFUNDED') return false;

    if (request.status === 'SUCCEEDED') {
      const refund = request.chargedCredits;
      if (refund <= 0n) return false;
      const wallet = await transaction.wallet.update({
        where: { userId },
        data: {
          availableCredits: { increment: refund },
          lifetimeConsumed: { decrement: refund },
        },
      });
      await transaction.aiRequest.update({
        where: { id: request.id },
        data: { status: 'REFUNDED', completedAt: new Date() },
      });
      await transaction.walletLedger.create({
        data: {
          userId,
          requestId: request.id,
          type: 'REFUND',
          amount: refund,
          balanceAfter: wallet.availableCredits,
          description: '视频任务失败，退回已结算额度',
        },
      });
      return true;
    }

    if (request.status !== 'RESERVED' && request.status !== 'PROCESSING') return false;
    const release = request.estimatedCredits;
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        availableCredits: { increment: release },
        reservedCredits: { decrement: release },
      },
    });
    await transaction.aiRequest.update({
      where: { id: request.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId: request.id,
        type: 'RELEASE',
        amount: release,
        balanceAfter: wallet.availableCredits,
        description: '视频任务失败，释放预扣额度',
      },
    });
    return true;
  });
}

export async function executeWalletVideoGeneration(prisma: PrismaClient, input: VideoInput) {
  const reservation = await reserveVideo(prisma, input);
  try {
    const provider = await selectVideoProvider(prisma, input.provider, input.providerChannelId);
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const results: unknown[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const path = provider.kind === 'XAIS' ? '/xais/workerTaskStart' : '/v1/video/generations';
      const body = provider.kind === 'XAIS' ? xaisVideoBody(input) : {
        model: input.model,
        prompt: input.prompt,
        n: 1,
        ...(input.inputImages.length ? { images: input.inputImages } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio, ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
      };
      const result = await providerRequest(provider, secrets, path, body);
      const failure = getFailure(result);
      if (failure) throw new CloudAiError('video_generation_failed', failure, 502);
      results.push(result);
    }
    await settleVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    return { results, provider: provider.kind, model: input.model, chargedCredits: reservation.estimated.toString() };
  } catch (error) {
    await releaseVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    throw new CloudAiError('video_generation_failed', error instanceof Error ? error.message : '视频生成失败', 502);
  }
}

export async function executeWalletVideoStatus(
  prisma: PrismaClient,
  input: { userId: string; provider?: VideoInput['provider']; providerChannelId?: string | undefined; taskId: string; clientRequestId?: string | undefined },
) {
  const provider = await selectVideoProvider(prisma, input.provider, input.providerChannelId);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const path = provider.kind === 'XAIS'
    ? `/xais/workerTaskWait?json=1&id=${encodeURIComponent(input.taskId)}`
    : `/v1/video/generations/${encodeURIComponent(input.taskId)}`;
  const waited = await providerRequest(provider, secrets, path);
  const failure = getFailure(waited);
  if (failure) {
    if (input.clientRequestId) {
      await refundVideoRequest(prisma, input.userId, input.clientRequestId);
    }
    throw new CloudAiError('video_generation_failed', failure, 502);
  }
  if (provider.kind !== 'XAIS') return waited;
  const attachments = collectAttachmentIds(waited)
    .filter((value) => !/^(?:pending|processing|queued|completed|success|succeeded|failed|failure|error|cancelled|canceled)$/i.test(value));
  if (!attachments.length) return waited;
  const resolved: unknown[] = [];
  for (const attachment of Array.from(new Set(attachments))) {
    resolved.push(await providerRequest(provider, secrets, `/xais/attUrls?att=${encodeURIComponent(attachment)}`));
  }
  return { result: waited, attachments: resolved };
}

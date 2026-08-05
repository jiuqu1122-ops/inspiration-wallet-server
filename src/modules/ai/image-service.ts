import { Prisma } from '@prisma/client';
import type { AiCapability, AiProviderChannel, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { env } from '../../config/env.js';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
import { CloudAiError } from './service.js';
import {
  aiPricingModelToken as imageModelToken,
  configuredImageUnitCredits,
  configuredVideoCreditsPerSecond,
  defaultImageUnitCredits,
  getAiPricingConfig,
  type PricedImageResolution,
} from './pricing.js';
import {
  createImageResultFromFile,
  createImageResultFromResponse,
  getImageResult,
  isStoredImageResultUrl,
} from './image-result-store.js';
import { ossUploadService } from './oss-uploader.js';

export const IMAGE_GENERATION_TIMEOUT_MS = 15 * 60_000;
export const BIGMODEL_IMAGE_GENERATION_TIMEOUT_MS = 3 * 60_000;
const NEW_API_IMAGE_TASK_POLL_INTERVAL_MS = 3_000;
const NEW_API_REFERENCE_DOWNLOAD_ATTEMPTS = 3;
const NEW_API_REFERENCE_DOWNLOAD_RETRY_DELAYS_MS = [500, 1_500];
const IMAGE_REFERENCE_FETCH_TIMEOUT_MS = 30_000;
const MAX_IMAGE_REFERENCE_BYTES = 16 * 1024 * 1024;
const IMAGE_REFERENCE_CACHE_TTL_MS = 10 * 60_000;
const IMAGE_REFERENCE_CACHE_MAX_ENTRIES = 32;
const XAIS_ATTACHMENT_REGISTRATION_ATTEMPTS = 4;
const XAIS_ATTACHMENT_CACHE_TTL_MS = 10 * 60_000;
const XAIS_ATTACHMENT_CACHE_MAX_ENTRIES = 64;
const XAIS_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
const XAIS_REFERENCE_DOWNLOAD_ATTEMPTS = 3;
const XAIS_REFERENCE_DOWNLOAD_RETRY_DELAYS_MS = [500, 1_500];
const XAIS_IMAGE_TASK_POLL_INTERVAL_MS = 1_200;
const XAIS_IMAGE_TASK_POLL_REQUEST_TIMEOUT_MS = 6_000;
const XAIS_RESULT_MIRROR_TIMEOUT_MS = 30_000;
const VIDEO_RESULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_VIDEO_RESULT_BYTES = 512 * 1024 * 1024;
const GPT_IMAGE_2_CHROMA_KEY = { red: 255, green: 0, blue: 255 } as const;
const imageReferenceCache = new Map<string, { dataUrl: string; expiresAt: number }>();
const pendingImageReferenceFetches = new Map<string, Promise<string>>();

export type WalletImageGenerationResult = {
  images: string[];
  provider: string;
  providerChannelId: string;
  providerChannelName: string;
  model: string;
  chargedCredits: string;
};

const isWalletImageGenerationResult = (value: unknown): value is WalletImageGenerationResult => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<WalletImageGenerationResult>;
  return Array.isArray(candidate.images)
    && candidate.images.length > 0
    && candidate.images.every(image => typeof image === 'string' && image.length > 0)
    && typeof candidate.provider === 'string'
    && typeof candidate.providerChannelId === 'string'
    && typeof candidate.providerChannelName === 'string'
    && typeof candidate.model === 'string'
    && typeof candidate.chargedCredits === 'string';
};

export const parseWalletImageGenerationResult = (
  value: Prisma.JsonValue | null | undefined,
): WalletImageGenerationResult | null => isWalletImageGenerationResult(value) ? value : null;
const xaisAttachmentCache = new Map<string, { name: string; expiresAt: number }>();
const pendingXaisAttachmentUploads = new Map<string, Promise<string>>();
const XAIS_MODEL_MAP: Record<string, string> = {
  'Xais Nano Pro_2K': 'Nano_Banana_Pro_2K_0',
  'Xais Nano Pro_4K': 'Nano_Banana_Pro_4K_0',
  'Xais Nano2_2K': 'Nano_Banana_2_2K_0',
  'Xais Nano2_4K': 'Nano_Banana_2_4K_0',
  'Xais Nano_Lite_1K': 'Xais_Nano_Lite_1K',
  'Xais Nano Pro_4K_png': 'Nano_Banana_Pro_4K_5',
  'Xais Nano2_4K_png': 'Nano_Banana_2_4K_5',
  'Xais Img2_2K': 'Image2_2K',
  'Xais Img2_4K': 'Image2_4K',
  'Xais Img2_2K(高画质)': 'Xais_Img2_2K_H',
  'Xais Img2_4K(高画质)': 'Xais_Img2_4K_H',
};

const NEW_API_IMAGE_MODEL_MAP: Record<string, string> = {
  nanobananapro: 'gemini-3-pro-image',
  gemini3pro: 'gemini-3-pro-image',
  gemini3proimage: 'gemini-3-pro-image',
  gemini31proimage: 'gemini-3-pro-image',
  googlegemini3proimage: 'gemini-3-pro-image',
  googlegemini31proimage: 'gemini-3-pro-image',
  modelsgemini3proimage: 'gemini-3-pro-image',
  modelsgemini31proimage: 'gemini-3-pro-image',
  nanobanana2: 'gemini-3.1-flash-image',
  gemini31flashimage: 'gemini-3.1-flash-image',
  gemini3flashimage: 'gemini-3.1-flash-image',
  gptimage2: 'gpt-image-2',
};

export function imageUnitCredits(model: string, resolution?: string) {
  return defaultImageUnitCredits(model, resolution);
}

export function resolveNewApiImageModel(model: string) {
  const trimmed = model.trim();
  const token = imageModelToken(trimmed);
  const exact = NEW_API_IMAGE_MODEL_MAP[token];
  if (exact) return exact;
  return trimmed;
}

const IMAGE_PROVIDER_CAPABILITIES: AiCapability[] = [
  'IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_NANO_BANANA_2',
  'IMAGE_NANO_BANANA_PRO_1K',
  'IMAGE_GPT',
  'IMAGE_GPT_1K',
];

export function imageCapabilityForModel(model: string): AiCapability {
  const token = imageModelToken(model);
  if (token.includes('gptimage') || token.includes('image2') || token.includes('img2')) {
    return 'IMAGE_GPT';
  }
  if (token.includes('nanobanana2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')
    || token.includes('xaisnano2')
    || token.includes('nano2')) {
    return 'IMAGE_NANO_BANANA_2';
  }
  if (
    token.includes('nanobanana')
    || (token.includes('gemini') && token.includes('image'))
    || token.includes('xaisnano')
    || token.includes('nanopro')
    || token.includes('nano2')
  ) {
    return 'IMAGE_NANO_BANANA';
  }
  return 'IMAGE';
}

export function providerSupportsImageModel(
  provider: { capabilities: readonly AiCapability[] },
  model: string,
  resolution?: string,
) {
  if (provider.capabilities.includes('IMAGE')) return true;
  const capability = imageCapabilityForModel(model);
  if (provider.capabilities.includes(capability)) return true;
  const normalizedResolution = resolution?.trim().toLowerCase();
  if (normalizedResolution && normalizedResolution !== '1k') return false;
  return capability === 'IMAGE_NANO_BANANA'
    ? provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_1K')
    : capability === 'IMAGE_GPT'
      ? provider.capabilities.includes('IMAGE_GPT_1K')
      : false;
}

export function filterProviderImageModels(
  provider: { capabilities: readonly AiCapability[] },
  models: string[],
) {
  return models.filter((model) => providerSupportsImageModel(provider, model));
}

export type ImageInput = {
  userId: string;
  clientRequestId: string;
  provider?: 'new-api' | 'xais-chat' | 'openai-compatible' | 'custom' | 'mikoto' | 'bigmodel' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  negativePrompt?: string | undefined;
  inputImages: string[];
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  resolution?: string | undefined;
  outputFormat: 'jpg' | 'jpeg' | 'png' | 'webp';
  background?: 'transparent' | undefined;
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
  const providers = await prisma.aiProviderChannel.findMany({
    where: {
      status: 'ACTIVE',
      capabilities: { hasSome: IMAGE_PROVIDER_CAPABILITIES },
    },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
  return providers.filter((provider) => !provider.capabilities.includes('LLM'));
}

function isRetryableNewApiTaskPollError(error: unknown) {
  return error instanceof UpstreamImageError
    && (error.status === 0 || error.status === 429 || error.status >= 500);
}

async function selectImageProvider(
  prisma: PrismaClient,
  providerChannelId: string | undefined,
  requestedModel: string,
  requestedResolution?: string,
) {
  const providers = await listImageProviders(prisma);
  const provider = providerChannelId
    ? providers.find((candidate) => candidate.id === providerChannelId)
    : providers.find((candidate) => {
      const model = requestedModel.trim() || candidate.defaultModel?.trim() || '';
      return model
        ? providerSupportsImageModel(candidate, model, requestedResolution)
        : candidate.capabilities.includes('IMAGE');
    });
  if (!provider) {
    throw new CloudAiError(
      'provider_unavailable',
      providerChannelId ? '所选生图渠道不可用或已被停用' : '当前没有可用的生图渠道',
      503,
    );
  }
  const effectiveModel = requestedModel.trim() || provider.defaultModel?.trim() || '';
  if (effectiveModel && !providerSupportsImageModel(provider, effectiveModel, requestedResolution)) {
    throw new CloudAiError(
      'provider_model_family_mismatch',
      '所选生图模型与该渠道启用的模型家族不匹配',
      400,
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
    const headers = upstreamHeaders(secrets);
    if (body === undefined) headers.delete('content-type');
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
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
  const record = value as Record<string, unknown>;
  const data: unknown = record.data ?? record.models;
  if (!Array.isArray(data)) return [];
  return Array.from(new Set(data.map((item: unknown) => (
    item && typeof item === 'object'
      ? (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name
      : null
  )).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim().replace(/^models\//i, ''))))
    .slice(0, 200);
}

export async function listWalletImageModels(
  prisma: PrismaClient,
) {
  const [providers, pricing] = await Promise.all([
    listImageProviders(prisma),
    getAiPricingConfig(prisma),
  ]);
  if (!providers.length) {
    throw new CloudAiError('provider_unavailable', '当前没有可用的生图渠道', 503);
  }
  const channels = await Promise.all(providers.map(async (provider) => {
    try {
      await assertPublicProviderUrl(provider.baseUrl);
      const secrets = decryptProviderSecrets(provider.encryptedSecrets);
      const value = provider.kind === 'BIGMODEL'
        ? await providerBigmodelModels(provider, secrets)
        : await providerRequest(provider, secrets, '/v1/models', undefined, 15_000);
      const models = filterProviderImageModels(provider, collectProviderModelIds(value));
      const defaultModel = provider.defaultModel
        && providerSupportsImageModel(provider, provider.defaultModel)
        ? provider.defaultModel
        : null;
      return {
        id: provider.id,
        name: provider.name,
        provider: provider.kind,
        defaultModel,
        models,
        capabilities: provider.capabilities,
        error: null,
      };
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        provider: provider.kind,
        defaultModel: provider.defaultModel,
        models: [] as string[],
        capabilities: provider.capabilities,
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
    pricing,
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

function newApiImageFamily(model: string) {
  const token = imageModelToken(model);
  if (token.includes('gemini3proimage')
    || token.includes('gemini31proimage')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')) return 'nano-banana';
  if (token.includes('gptimage2')) return 'gpt-image-2';
  return 'legacy';
}

function shouldUseNewApiAsyncImageTask(input: ImageInput) {
  return newApiImageFamily(input.model) === 'nano-banana'
    || normalizedImageResolution(input.resolution) === '4k'
    || input.inputImages.length > 1
    || input.count > 1;
}

async function providerImageContentRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  path: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
  try {
    const headers = upstreamHeaders(secrets);
    headers.delete('content-type');
    headers.set('accept', 'image/*, application/json, */*');
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new UpstreamImageError(response.status, upstreamErrorMessage(response.status, text));
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || contentType.startsWith('text/')) {
      return parseProviderValue(await response.text());
    }
    return await createImageResultFromResponse(response);
  } catch (error) {
    if (error instanceof UpstreamImageError) throw error;
    throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedImageResolution(resolution?: string): PricedImageResolution {
  const value = resolution?.trim().toLowerCase();
  if (value === '1k' || value === '4k') return value;
  return '2k';
}

function newApiExactImageSize(
  ratio: ImageInput['aspectRatio'],
  resolution?: string,
) {
  const sizes: Record<PricedImageResolution, Record<ImageInput['aspectRatio'], string>> = {
    '1k': {
      '1:1': '1024x1024',
      '3:4': '768x1024',
      '4:3': '1024x768',
      '9:16': '720x1280',
      '16:9': '1280x720',
    },
    '2k': {
      '1:1': '2048x2048',
      '3:4': '1536x2048',
      '4:3': '2048x1536',
      '9:16': '1152x2048',
      '16:9': '2048x1152',
    },
    '4k': {
      '1:1': '2880x2880',
      '3:4': '2400x3200',
      '4:3': '3200x2400',
      '9:16': '2160x3840',
      '16:9': '3840x2160',
    },
  };
  return sizes[normalizedImageResolution(resolution)][ratio];
}

export function newApiImageRequestParams(
  model: string,
  count: number,
  ratio: ImageInput['aspectRatio'],
  resolution?: string,
  outputFormat?: ImageInput['outputFormat'],
  background?: ImageInput['background'],
) {
  const family = newApiImageFamily(model);
  const transparentPng = outputFormat === 'png' || background === 'transparent';
  if (family === 'nano-banana') {
    const resolutionLabel = normalizedImageResolution(resolution).toUpperCase();
    return {
      n: count,
      size: newApiExactImageSize(ratio, resolution),
      aspect_ratio: ratio,
      output_resolution: resolutionLabel,
      image_size: resolutionLabel,
      ...(transparentPng ? { output_format: 'png', background: 'transparent' } : {}),
    };
  }
  const size = family === 'gpt-image-2'
    ? newApiExactImageSize(ratio, resolution)
    : sizeFromRatio(ratio);
  return {
    n: count,
    size,
    aspect_ratio: ratio,
    ...(family === 'gpt-image-2' ? { quality: 'medium' } : {}),
    ...(transparentPng ? {
      output_format: 'png',
      // GPT Image 2 does not reliably support native alpha. Sending
      // background=transparent makes some NewAPI channels reject the edits
      // request and can trigger a reference-dropping generations fallback.
      // Its result is chroma-keyed and converted to real alpha below.
      ...(family === 'gpt-image-2' ? {} : { background: 'transparent' }),
    } : {}),
  };
}

export async function readBigmodelResponse(response: Response) {
  if (!response.body) return parseProviderValue(await response.text());

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = '';
  let fullText = '';

  const parseEvent = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const payload = /^data:\s*/i.test(trimmed)
      ? trimmed.replace(/^data:\s*/i, '').trim()
      : trimmed;
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  };

  const returnIfImageReady = async () => {
    const images = uniqueImages(events, [], 1);
    const hasCompleteImage = images.some((image) => {
      if (!/^data:image\//i.test(image)) return /^https?:\/\//i.test(image);
      return (image.split(',', 2)[1] || '').replace(/\s+/g, '').length >= 64;
    });
    if (!hasCompleteImage) return null;
    await reader.cancel().catch(() => {});
    return events.length === 1 ? events[0] : events;
  };

  while (true) {
    const { done, value } = await reader.read();
    const decoded = decoder.decode(value || new Uint8Array(), { stream: !done });
    fullText += decoded;
    buffer += decoded;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      // Some Gemini-compatible proxies return SSE without an explicit stream
      // request. Return once a complete image event arrives.
      if (!contentType.includes('event-stream') && !/^\s*(?:data:\s*)?[\[{]/.test(line)) continue;
      const parsed = parseEvent(line);
      if (parsed === null) continue;
      events.push(parsed);
      const ready = await returnIfImageReady();
      if (ready !== null) return ready;
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) {
    const parsed = parseEvent(tail);
    if (parsed !== null) events.push(parsed);
  }
  if (events.length > 0) return events.length === 1 ? events[0] : events;
  return parseProviderValue(fullText);
}

async function providerBigmodelRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  model: string,
  body: unknown,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BIGMODEL_IMAGE_GENERATION_TIMEOUT_MS);
  try {
    const headers = new Headers({
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': 'Inspiration-Wallet-Server/1',
      'x-goog-api-key': secrets.apiKey,
    });
    for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
    const modelName = model.trim().replace(/^models\//i, '');
    const path = `/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new UpstreamImageError(response.status, upstreamErrorMessage(response.status, text));
    }
    return await readBigmodelResponse(response);
  } catch (error) {
    if (error instanceof UpstreamImageError) throw error;
    throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function providerBigmodelModels(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = new Headers({
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Inspiration-Wallet-Server/1',
      'x-goog-api-key': secrets.apiKey,
    });
    for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
    const response = await fetch(providerEndpoint(provider.baseUrl, '/v1beta/models'), {
      method: 'GET',
      headers,
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

export function isRecoverableNewApiVideoStatusError(error: unknown) {
  const status = error instanceof UpstreamImageError ? error.status : 0;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '') ?? '';
  if (status === 401 || status === 403 || /HTTP (?:401|403)\b/i.test(message)) return false;
  if (status === 0 || status === 400 || status === 404 || status === 408
    || status === 409 || status === 425 || status === 429 || status >= 500) return true;
  return /fail_to_fetch_task|invalid request body|HTTP (?:400|404|408|409|425|429|5\d\d)\b/i.test(message);
}

function requiresGptImage2AlphaPostProcessing(input: ImageInput) {
  return newApiImageFamily(input.model) === 'gpt-image-2'
    && (input.outputFormat === 'png' || input.background === 'transparent');
}

function promptWithConstraints(input: ImageInput) {
  const constraints = [`must output exactly ${input.aspectRatio} aspect ratio`];
  if (input.resolution) constraints.push(`target resolution ${input.resolution}`);
  if (input.inputImages.length > 0) {
    constraints.push('treat every supplied reference image as authoritative and preserve its subject, geometry, details, colors, and branding outside changes explicitly requested by the user');
  }
  if (requiresGptImage2AlphaPostProcessing(input)) {
    constraints.push('replace only the background with one perfectly uniform solid RGB(255,0,255) chroma-key color; do not draw a transparency checkerboard, gradient, texture, reflection, or shadow in the background; do not use RGB(255,0,255) on the subject');
  } else if (input.background === 'transparent') {
    constraints.push('use a truly transparent background with an alpha channel, not a checkerboard pattern');
  }
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

export function buildNewApiImageGenerationBody(
  input: ImageInput,
  inputImages = input.inputImages,
  asyncOverride?: boolean,
) {
  const imageParams = newApiImageRequestParams(
    input.model,
    input.count,
    input.aspectRatio,
    input.resolution,
    input.outputFormat,
    input.background,
  );
  return {
    model: input.model,
    prompt: promptWithConstraints(input),
    ...imageParams,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(inputImages.length === 1 ? { image: inputImages[0] } : {}),
    ...(inputImages.length > 1 ? { images: inputImages } : {}),
    response_format: 'url',
    ...((asyncOverride ?? shouldUseNewApiAsyncImageTask({ ...input, inputImages })) ? { async: true } : {}),
    stream: false,
  };
}

export function isNewApiParamOverrideCopyError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /operation copy failed\s*:\s*source path does not exist\s*:/i.test(message);
}

export function isNewApiGeminiImageDecodeError(model: string, error: unknown) {
  if (!['IMAGE_NANO_BANANA', 'IMAGE_NANO_BANANA_2'].includes(imageCapabilityForModel(model))) return false;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /(?:failed to decode image data|provided image is not valid|image data is not valid|please make sure the image is valid|bad request to gemini)/i.test(message);
}

export function isPublicNewApiImageReference(source: string) {
  return /^https?:\/\//i.test(source.trim());
}

function isInlineNewApiImageReference(source: string) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+$/i.test(source.trim());
}

function isSupportedNewApiImageReference(source: string) {
  return isPublicNewApiImageReference(source) || isInlineNewApiImageReference(source);
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

async function readLimitedImageBytes(response: Response) {
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
  if (!bytes.length) throw new Error('reference URL returned empty image bytes');
  const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  const detectedMime = imageMimeFromBytes(bytes);
  const mime = detectedMime || (headerMime.startsWith('image/') ? headerMime : '');
  if (!mime) throw new Error('reference URL did not return valid image bytes');
  return { bytes, mime };
}

async function readLimitedImageBody(response: Response) {
  const { bytes, mime } = await readLimitedImageBytes(response);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function readCachedImageReference(source: string) {
  const cached = imageReferenceCache.get(source);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    imageReferenceCache.delete(source);
    return undefined;
  }
  // Refresh insertion order so active references are evicted last.
  imageReferenceCache.delete(source);
  imageReferenceCache.set(source, cached);
  return cached.dataUrl;
}

function cacheImageReference(source: string, dataUrl: string) {
  imageReferenceCache.delete(source);
  imageReferenceCache.set(source, {
    dataUrl,
    expiresAt: Date.now() + IMAGE_REFERENCE_CACHE_TTL_MS,
  });
  while (imageReferenceCache.size > IMAGE_REFERENCE_CACHE_MAX_ENTRIES) {
    const oldest = imageReferenceCache.keys().next().value;
    if (!oldest) break;
    imageReferenceCache.delete(oldest);
  }
}

async function fetchPublicImageReference(source: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REFERENCE_FETCH_TIMEOUT_MS);
  try {
    let current = new URL(source);
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
    throw new Error('reference image redirect limit exceeded');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Public URLs remain the normal NewAPI path. Gemini references are materialized
 * only after the upstream explicitly reports invalid image data. XAIS also uses
 * the same verified bytes for attachment uploads.
 */
export async function materializeNewApiReferenceImage(source: string) {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const cached = readCachedImageReference(trimmed);
  if (cached) return cached;
  const pending = pendingImageReferenceFetches.get(trimmed);
  if (pending) return pending;
  const fetchPromise = fetchPublicImageReference(trimmed);
  pendingImageReferenceFetches.set(trimmed, fetchPromise);
  try {
    const dataUrl = await fetchPromise;
    cacheImageReference(trimmed, dataUrl);
    return dataUrl;
  } finally {
    if (pendingImageReferenceFetches.get(trimmed) === fetchPromise) {
      pendingImageReferenceFetches.delete(trimmed);
    }
  }
}

function newApiImageTaskState(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const state = newApiImageTaskState(item);
      if (state) return state;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  const direct = record.status ?? record.state;
  if (typeof direct === 'string') return direct.trim().toLowerCase();
  for (const key of ['data', 'result', 'task', 'response']) {
    const state = newApiImageTaskState(record[key]);
    if (state) return state;
  }
  return '';
}

export async function resolveNewApiImageResponse(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  started: unknown,
  inputImages: string[],
  count: number,
  wait: (milliseconds: number) => Promise<unknown> = (
    milliseconds,
  ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const immediate = uniqueImages(started, inputImages, count);
  if (immediate.length) return immediate;
  const taskId = getTaskId(started);
  if (!taskId) throw new Error('NewAPI 没有返回图片数据或 task_id');

  const deadline = Date.now() + IMAGE_GENERATION_TIMEOUT_MS;
  let lastStatus: unknown = started;
  let lastPollError: unknown = null;
  while (Date.now() < deadline) {
    await wait(NEW_API_IMAGE_TASK_POLL_INTERVAL_MS);
    try {
      lastStatus = await providerRequest(
        provider,
        secrets,
        `/v1/images/generations/${encodeURIComponent(taskId)}`,
        undefined,
        45_000,
      );
      lastPollError = null;
    } catch (error) {
      if (!isRetryableNewApiTaskPollError(error)) throw error;
      lastPollError = error;
      continue;
    }
    const images = uniqueImages(lastStatus, inputImages, count);
    if (images.length) return images;
    const failure = getFailure(lastStatus);
    if (failure) throw new Error(failure);
    const state = newApiImageTaskState(lastStatus);
    if (/^(?:failed|failure|error|cancelled|canceled)$/.test(state)) {
      throw new Error(`NewAPI 图片任务失败：${taskId}`);
    }
    if (/^(?:completed|complete|succeeded|success|finished|done)$/.test(state)) {
      const content = await providerImageContentRequest(
        provider,
        secrets,
        `/v1/images/${encodeURIComponent(taskId)}/content`,
      );
      const contentImages = uniqueImages(content, inputImages, count);
      if (contentImages.length) return contentImages;
      throw new Error(`NewAPI 图片任务已完成但没有返回图片：${taskId}`);
    }
  }
  const failure = getFailure(lastStatus);
  const pollDetail = lastPollError instanceof Error ? `：${lastPollError.message}` : '';
  throw new Error(failure || `NewAPI 图片任务等待超时：${taskId}${pollDetail}`);
}

type StagedNewApiEditImage = {
  filename: string;
  mime: string;
  size: number;
  bytes?: Buffer;
  path?: string;
  cleanup: () => Promise<void>;
};

function newApiImageExtension(mime: string) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function retryableNewApiReferenceDownloadError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '') ?? '';
  const statusMatch = message.match(/reference image HTTP (\d{3})/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  return /(?:abort|timed?\s*out|timeout|fetch failed|terminated|socket|connection|incomplete\s*read|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|empty image bytes|valid image bytes|content-length mismatch)/i.test(message);
}

async function stageNewApiEditImage(
  source: string,
  index: number,
  wait: (milliseconds: number) => Promise<unknown> = (
    milliseconds,
  ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<StagedNewApiEditImage> {
  if (/^data:image\//i.test(source)) {
    const inline = dataUrlImageBytes(source);
    return {
      filename: `reference-${index + 1}.${newApiImageExtension(inline.mime)}`,
      mime: inline.mime,
      size: inline.bytes.byteLength,
      bytes: inline.bytes,
      cleanup: async () => {},
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'inspiration-newapi-ref-'));
  const path = join(directory, 'reference.bin');
  let lastError: unknown = null;
  try {
    for (let attempt = 0; attempt < NEW_API_REFERENCE_DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await wait(NEW_API_REFERENCE_DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 1_500);
      try {
        const staged = await downloadPublicImageReferenceToFile(source, path);
        const fileSize = (await stat(path)).size;
        if (fileSize !== staged.size) {
          throw new Error(`reference image temporary file size mismatch: expected ${staged.size}, received ${fileSize}`);
        }
        return {
          filename: `reference-${index + 1}.${newApiImageExtension(staged.mime)}`,
          path,
          mime: staged.mime,
          size: staged.size,
          cleanup: () => rm(directory, { recursive: true, force: true }),
        };
      } catch (error) {
        lastError = error;
        await rm(path, { force: true }).catch(() => {});
        if (!retryableNewApiReferenceDownloadError(error)
          || attempt >= NEW_API_REFERENCE_DOWNLOAD_ATTEMPTS - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('NewAPI reference image download failed');
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function stagePublicGeneratedImageResult(source: string, index: number) {
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-generated-result-'));
  const path = join(directory, 'result.bin');
  try {
    const staged = await downloadPublicImageReferenceToFile(
      source,
      path,
      XAIS_RESULT_MIRROR_TIMEOUT_MS,
    );
    const fileSize = (await stat(path)).size;
    if (fileSize !== staged.size) {
      throw new Error(`generated image temporary file size mismatch: expected ${staged.size}, received ${fileSize}`);
    }
    return {
      filename: `generated-${index + 1}.${newApiImageExtension(staged.mime)}`,
      path,
      mime: staged.mime,
      size: staged.size,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    } satisfies StagedNewApiEditImage;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function mirrorPublicGeneratedImageResultToOss(source: string, index: number) {
  const staged = await stagePublicGeneratedImageResult(source, index);
  try {
    if (!staged.path) throw new Error('generated image mirror did not create a temporary file');
    const stableUrl = await createImageResultFromFile(staged.path, staged.mime);
    return await uploadStoredImageResultToOss(stableUrl);
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

async function uploadStoredImageResultToOss(stableUrl: string) {
  const key = new URL(stableUrl).pathname.split('/').filter(Boolean).pop();
  const stored = key ? await getImageResult(key) : null;
  if (!key || !stored) throw new Error('generated image mirror could not reopen the stored result');
  const objectName = await ossUploadService.upload({
    namespace: 'generated-images',
    filename: key,
    source: stored.path,
    mime: stored.mime,
  });
  if (!await ossUploadService.exists(objectName)) {
    throw new Error('generated image mirror object is missing after upload');
  }
  // Validate that the object key can be signed before publishing the stable
  // API URL. Clients resolve that URL to a fresh signed Hong Kong OSS URL.
  ossUploadService.getPublicUrl(objectName, { mime: stored.mime, filename: key });
  return stableUrl;
}

async function mirrorInlineGeneratedImageResultToOss(source: string) {
  const match = source.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('generated inline image data is invalid');
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (!bytes.length) throw new Error('generated inline image data is empty');
  const stableUrl = await createImageResultFromResponse(new Response(bytes, {
    headers: {
      'content-type': match[1]!,
      'content-length': String(bytes.byteLength),
    },
  }));
  return await uploadStoredImageResultToOss(stableUrl);
}

export async function mirrorXaisImageResults(
  images: string[],
  providerName: string,
  mirrorImage: (source: string, index: number) => Promise<string> = mirrorPublicGeneratedImageResultToOss,
) {
  return Promise.all(images.map(async (source, index) => {
    if (isStoredImageResultUrl(source)) return source;
    if (/^data:image\//i.test(source)) {
      try {
        return await mirrorInlineGeneratedImageResultToOss(source);
      } catch (error) {
        console.warn('[xais_image_result_mirror_failed]', {
          provider: providerName,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
        return source;
      }
    }
    if (!isPublicNewApiImageReference(source)) return source;
    try {
      return await mirrorImage(source, index);
    } catch (error) {
      console.warn('[xais_image_result_mirror_failed]', {
        provider: providerName,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      return source;
    }
  }));
}

function chromaKeyDistance(red: number, green: number, blue: number) {
  return Math.sqrt(
    (GPT_IMAGE_2_CHROMA_KEY.red - red) ** 2
    + (GPT_IMAGE_2_CHROMA_KEY.green - green) ** 2
    + (GPT_IMAGE_2_CHROMA_KEY.blue - blue) ** 2,
  );
}

function clampImageByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export async function convertGptImage2ChromaKeyToTransparentPng(source: Buffer) {
  const decoded = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (channels !== 4 || width <= 0 || height <= 0) {
    throw new Error('GPT Image 2 returned an image that could not be converted to RGBA');
  }

  const pixels = width * height;
  const raw = decoded.data;
  let existingTransparentPixels = 0;
  for (let offset = 3; offset < raw.length; offset += channels) {
    if (raw[offset]! < 250) existingTransparentPixels += 1;
  }
  if (existingTransparentPixels >= Math.max(8, Math.floor(pixels * 0.0001))) {
    return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  }

  const borderBand = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  let keyPixels = 0;
  let borderPixels = 0;
  let borderKeyPixels = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * channels;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const distance = chromaKeyDistance(raw[offset]!, raw[offset + 1]!, raw[offset + 2]!);
    const isKey = distance <= 88;
    if (isKey) keyPixels += 1;
    if (x < borderBand || x >= width - borderBand || y < borderBand || y >= height - borderBand) {
      borderPixels += 1;
      if (isKey) borderKeyPixels += 1;
    }
  }
  const keyRatio = keyPixels / pixels;
  const borderKeyRatio = borderPixels > 0 ? borderKeyPixels / borderPixels : 0;
  if (keyRatio < 0.005 && borderKeyRatio < 0.08) {
    throw new Error('GPT Image 2 did not return a usable chroma-key background; refusing to return a fake transparent PNG');
  }

  const fullyTransparentDistance = 24;
  const fullyOpaqueDistance = 110;
  let transparentPixels = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * channels;
    const red = raw[offset]!;
    const green = raw[offset + 1]!;
    const blue = raw[offset + 2]!;
    const distance = chromaKeyDistance(red, green, blue);
    const foregroundAlpha = Math.max(0, Math.min(1,
      (distance - fullyTransparentDistance) / (fullyOpaqueDistance - fullyTransparentDistance),
    ));
    if (foregroundAlpha >= 1) continue;
    const alpha = clampImageByte(255 * foregroundAlpha);
    raw[offset + 3] = alpha;
    if (alpha < 250) transparentPixels += 1;
    if (foregroundAlpha > 0.02) {
      raw[offset] = clampImageByte((red - GPT_IMAGE_2_CHROMA_KEY.red * (1 - foregroundAlpha)) / foregroundAlpha);
      raw[offset + 1] = clampImageByte((green - GPT_IMAGE_2_CHROMA_KEY.green * (1 - foregroundAlpha)) / foregroundAlpha);
      raw[offset + 2] = clampImageByte((blue - GPT_IMAGE_2_CHROMA_KEY.blue * (1 - foregroundAlpha)) / foregroundAlpha);
    }
  }
  if (transparentPixels < Math.max(8, Math.floor(pixels * 0.0001))) {
    throw new Error('GPT Image 2 background conversion produced no transparent pixels');
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

async function readNewApiResultBytes(source: string, index: number) {
  if (isStoredImageResultUrl(source)) {
    const key = new URL(source).pathname.split('/').filter(Boolean).pop();
    const stored = key ? await getImageResult(key) : null;
    if (!stored) throw new Error('stored GPT Image 2 result is no longer available');
    return readFile(stored.path);
  }
  const staged = await stageNewApiEditImage(source, index);
  try {
    if (staged.bytes) return staged.bytes;
    if (staged.path) return await readFile(staged.path);
    throw new Error('GPT Image 2 result returned no readable bytes');
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

async function createTransparentGptImage2Result(source: string, index: number) {
  const sourceBytes = await readNewApiResultBytes(source, index);
  const png = await convertGptImage2ChromaKeyToTransparentPng(sourceBytes);
  return createImageResultFromResponse(new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.byteLength),
    },
  }));
}

function newApiMultipartTextPart(boundary: string, name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8',
  );
}

function newApiMultipartFileHeader(
  boundary: string,
  image: StagedNewApiEditImage,
  fieldName = 'image',
) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${image.filename}"\r\nContent-Type: ${image.mime}\r\n\r\n`,
    'utf8',
  );
}

function newApiEditFields(input: ImageInput, asyncOverride?: boolean) {
  const body = buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride) as Record<string, unknown>;
  delete body.image;
  delete body.images;
  return Object.entries(body)
    .filter((entry): entry is [string, string | number | boolean] => (
      typeof entry[1] === 'string'
      || typeof entry[1] === 'number'
      || typeof entry[1] === 'boolean'
    ))
    .map(([name, value]) => [name, String(value)] as const);
}

function isUnsupportedNewApiAsyncParameter(error: unknown) {
  if (!(error instanceof UpstreamImageError) || ![400, 404, 405, 422].includes(error.status)) return false;
  return /(?:async|task).*(?:unsupported|unknown|invalid|not\s+allowed|not\s+support)|(?:unsupported|unknown|invalid).*(?:async|task)/i.test(error.message);
}

export function isNewApiReferenceProtocolCompatibilityError(error: unknown) {
  if (!(error instanceof UpstreamImageError)
    || ![400, 404, 405, 415, 422, 500, 501].includes(error.status)) return false;
  return /(?:referenceImages|referenceVideos).{0,320}referenceBlobs|referenceBlobs.{0,320}(?:referenceImages|referenceVideos)|unsupported field(?:\(s\))?.{0,160}(?:reference|image)|(?:images\/edits|image edits?).{0,160}(?:unsupported|not supported|unknown|invalid|not found|method not allowed)|(?:unsupported|not supported|unknown|invalid|not found|method not allowed).{0,160}(?:images\/edits|image edits?)/i
    .test(error.message);
}

async function requestNewApiImageWithAsyncFallback(
  preferAsync: boolean,
  request: (asyncOverride: boolean) => Promise<unknown>,
) {
  try {
    return await request(preferAsync);
  } catch (error) {
    if (!preferAsync || !isUnsupportedNewApiAsyncParameter(error)) throw error;
    return request(false);
  }
}

async function providerNewApiImageEditRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
  images: StagedNewApiEditImage[],
  asyncOverride?: boolean,
) {
  const boundary = `inspiration-${randomUUID().replace(/-/g, '')}`;
  const textParts = newApiEditFields(input, asyncOverride).map(([name, value]) => (
    newApiMultipartTextPart(boundary, name, value)
  ));
  const fileHeaders = images.map((image) => newApiMultipartFileHeader(boundary, image));
  const fileFooters = images.map(() => Buffer.from('\r\n', 'utf8'));
  const closing = Buffer.from(`--${boundary}--\r\n`, 'utf8');
  const contentLength = textParts.reduce((total, part) => total + part.byteLength, 0)
    + images.reduce((total, image, index) => (
      total + fileHeaders[index]!.byteLength + image.size + fileFooters[index]!.byteLength
    ), 0)
    + closing.byteLength;
  const bodyStream = Readable.from((async function* multipartBody() {
    for (const part of textParts) yield part;
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!;
      yield fileHeaders[index]!;
      if (image.path) {
        for await (const chunk of createReadStream(image.path)) yield chunk;
      } else if (image.bytes) {
        yield image.bytes;
      }
      yield fileFooters[index]!;
    }
    yield closing;
  })());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
  try {
    const headers = upstreamHeaders(secrets);
    headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    headers.set('content-length', String(contentLength));
    const request: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers,
      body: Readable.toWeb(bodyStream) as unknown as BodyInit,
      redirect: 'error',
      signal: controller.signal,
      duplex: 'half',
    };
    const response = await fetch(providerEndpoint(provider.baseUrl, '/v1/images/edits'), request);
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
    bodyStream.destroy();
  }
}

export async function generateNewApiImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  if (input.inputImages.some(source => !isSupportedNewApiImageReference(source))) {
    throw new CloudAiError(
      'invalid_image_reference',
      'NewAPI 生图参考图必须使用公网 HTTP URL 或图片 data URI',
      400,
    );
  }
  for (const source of input.inputImages.filter(isPublicNewApiImageReference)) {
    await assertPublicProviderUrl(source);
  }
  const stagedImages: StagedNewApiEditImage[] = [];
  let started: unknown;
  const preferAsync = shouldUseNewApiAsyncImageTask(input);
  try {
    if (input.inputImages.length > 0) {
      for (let index = 0; index < input.inputImages.length; index += 1) {
        stagedImages.push(await stageNewApiEditImage(input.inputImages[index]!, index));
      }
      try {
        started = await requestNewApiImageWithAsyncFallback(
          preferAsync,
          asyncOverride => providerNewApiImageEditRequest(
            provider,
            secrets,
            input,
            stagedImages,
            asyncOverride,
          ),
        );
      } catch (error) {
        if (!isNewApiReferenceProtocolCompatibilityError(error)) throw error;
        if (newApiImageFamily(input.model) === 'gpt-image-2') {
          throw new CloudAiError(
            'provider_reference_edit_unsupported',
            `NewAPI 渠道 ${provider.name || provider.id} 不支持 GPT Image 2 参考图编辑，已停止该渠道，避免参考图被忽略`,
            502,
          );
        }
        console.warn('[newapi_image_reference_protocol_fallback]', {
          provider: provider.name,
          model: input.model,
          from: 'images/edits',
          to: 'images/generations',
          reason: error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320),
        });
        started = await requestNewApiImageWithAsyncFallback(
          preferAsync,
          asyncOverride => providerRequest(
            provider,
            secrets,
            '/v1/images/generations',
            buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride),
            IMAGE_GENERATION_TIMEOUT_MS,
          ),
        );
      }
    } else {
      const startGeneration = (asyncOverride: boolean) => providerRequest(
        provider,
        secrets,
        '/v1/images/generations',
        buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride),
        IMAGE_GENERATION_TIMEOUT_MS,
      );
      started = await requestNewApiImageWithAsyncFallback(preferAsync, startGeneration);
    }
  } finally {
    await Promise.all(stagedImages.map((image) => image.cleanup().catch(() => {})));
  }
  const images = await resolveNewApiImageResponse(
    provider,
    secrets,
    started,
    input.inputImages,
    input.count,
  );
  const output: string[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const source = images[index]!;
    if (requiresGptImage2AlphaPostProcessing(input)) {
      output.push(await createTransparentGptImage2Result(source, index));
      continue;
    }
    if (!isPublicNewApiImageReference(source) || isStoredImageResultUrl(source)) {
      output.push(source);
      continue;
    }
    let staged: StagedNewApiEditImage | null = null;
    try {
      staged = await stageNewApiEditImage(source, index);
      output.push(await createImageResultFromFile(staged.path!, staged.mime));
    } catch (error) {
      console.warn('[newapi_image_result_mirror_failed]', {
        provider: provider.name,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      output.push(source);
    } finally {
      if (staged) await staged.cleanup().catch(() => {});
    }
  }
  return output;
}

type StagedXaisReference = {
  path: string;
  mime: string;
  size: number;
  cleanup: () => Promise<void>;
};

function retryableXaisReferenceDownloadError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '') ?? '';
  const statusMatch = message.match(/reference image HTTP (\d{3})/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  return /(?:abort|timed?\s*out|timeout|fetch failed|terminated|socket|connection|incomplete\s*read|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|empty image bytes|valid image bytes|content-length mismatch)/i.test(message);
}

async function writeResponseBodyToFile(response: Response, path: string) {
  if (!response.body) throw new Error('reference image response has no body');
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_REFERENCE_BYTES) {
    throw new Error('reference image is too large');
  }

  const file = await open(path, 'w');
  const reader = response.body.getReader();
  const prefixChunks: Buffer[] = [];
  let prefixLength = 0;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_REFERENCE_BYTES) {
        await reader.cancel();
        throw new Error('reference image is too large');
      }
      if (prefixLength < 512) {
        const prefix = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, 512 - prefixLength));
        prefixChunks.push(Buffer.from(prefix));
        prefixLength += prefix.byteLength;
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('reference image temporary file write failed');
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }

  if (!total) throw new Error('reference URL returned empty image bytes');
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase() || '';
  if (
    Number.isFinite(declaredLength)
    && declaredLength > 0
    && (!contentEncoding || contentEncoding === 'identity')
    && total !== declaredLength
  ) {
    throw new Error(`reference image content-length mismatch: expected ${declaredLength}, received ${total}`);
  }
  const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  const detectedMime = imageMimeFromBytes(Buffer.concat(prefixChunks));
  const mime = detectedMime || (headerMime.startsWith('image/') ? headerMime : '');
  if (!mime) throw new Error('reference URL did not return valid image bytes');
  return { mime, size: total };
}

async function downloadPublicImageReferenceToFile(
  source: string,
  path: string,
  timeoutMs = IMAGE_REFERENCE_FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = new URL(source);
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
      return await writeResponseBodyToFile(response, path);
    }
    throw new Error('reference image redirect limit exceeded');
  } finally {
    clearTimeout(timeout);
  }
}

export async function stageXaisPublicReference(
  source: string,
  wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<StagedXaisReference> {
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-xais-ref-'));
  const path = join(directory, 'reference.bin');
  let lastError: unknown = null;
  try {
    for (let attempt = 0; attempt < XAIS_REFERENCE_DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await wait(XAIS_REFERENCE_DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 1_500);
      try {
        const staged = await downloadPublicImageReferenceToFile(source, path);
        const fileSize = (await stat(path)).size;
        if (fileSize !== staged.size) {
          throw new Error(`reference image temporary file size mismatch: expected ${staged.size}, received ${fileSize}`);
        }
        return {
          path,
          mime: staged.mime,
          size: staged.size,
          cleanup: () => rm(directory, { recursive: true, force: true }),
        };
      } catch (error) {
        lastError = error;
        await rm(path, { force: true }).catch(() => {});
        if (!retryableXaisReferenceDownloadError(error) || attempt >= XAIS_REFERENCE_DOWNLOAD_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(typeof lastError === 'string'
        ? lastError
        : JSON.stringify(lastError ?? 'reference image download failed') ?? 'reference image download failed');
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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

function xaisAttachmentCacheKey(provider: AiProviderChannel, source: string) {
  return `${provider.id}:${createHash('sha256').update(source).digest('hex')}`;
}

function readCachedXaisAttachment(key: string) {
  const cached = xaisAttachmentCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    xaisAttachmentCache.delete(key);
    return null;
  }
  return cached.name;
}

function cacheXaisAttachment(key: string, name: string) {
  xaisAttachmentCache.set(key, { name, expiresAt: Date.now() + XAIS_ATTACHMENT_CACHE_TTL_MS });
  while (xaisAttachmentCache.size > XAIS_ATTACHMENT_CACHE_MAX_ENTRIES) {
    const oldest = xaisAttachmentCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    xaisAttachmentCache.delete(oldest);
  }
}

async function performXaisReferenceUpload(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  trimmed: string,
) {
  const inline = /^data:image\//i.test(trimmed) ? dataUrlImageBytes(trimmed) : null;
  const staged = inline ? null : await stageXaisPublicReference(trimmed);
  const mime = inline?.mime ?? staged!.mime;
  const size = inline?.bytes.byteLength ?? staged!.size;
  const extension = mime.includes('png') ? 'png'
    : mime.includes('webp') ? 'webp'
      : mime.includes('gif') ? 'gif' : 'jpg';
  try {
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
    const fileStream = staged ? createReadStream(staged.path) : null;
    try {
      const body: BodyInit = fileStream
        ? Readable.toWeb(fileStream) as unknown as BodyInit
        : inline!.bytes;
      const request: RequestInit & { duplex?: 'half' } = {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        body,
        redirect: 'error',
        signal: controller.signal,
        ...(fileStream ? { duplex: 'half' as const } : {}),
      };
      const response = await fetch(upload.url, request);
      if (!response.ok) throw new Error(`XAIS reference upload failed with HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
      fileStream?.destroy();
    }
    await confirmXaisReferenceAttachment(provider, secrets, upload.name);
    return upload.name;
  } finally {
    await staged?.cleanup().catch(() => {});
  }
}

async function uploadXaisReferenceImage(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  source: string,
) {
  const trimmed = source.trim();
  if (!/^(?:https?:|data:image\/)/i.test(trimmed)) return trimmed;
  const cacheKey = xaisAttachmentCacheKey(provider, trimmed);
  const cached = readCachedXaisAttachment(cacheKey);
  if (cached) return cached;
  const pending = pendingXaisAttachmentUploads.get(cacheKey);
  if (pending) return pending;

  const upload = performXaisReferenceUpload(provider, secrets, trimmed)
    .then((name) => {
      cacheXaisAttachment(cacheKey, name);
      return name;
    })
    .finally(() => pendingXaisAttachmentUploads.delete(cacheKey));
  pendingXaisAttachmentUploads.set(cacheKey, upload);
  return upload;
}

async function uploadXaisReferenceImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  sources: string[],
) {
  const output: string[] = [];
  for (let index = 0; index < sources.length; index += XAIS_ATTACHMENT_UPLOAD_CONCURRENCY) {
    output.push(...await Promise.all(
      sources
        .slice(index, index + XAIS_ATTACHMENT_UPLOAD_CONCURRENCY)
        .map((source) => uploadXaisReferenceImage(provider, secrets, source)),
    ));
  }
  return output;
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

function isXaisPendingMessage(value: string) {
  return /(?:pending|queued|queue|running|processing|in[_\s-]?progress|progress|waiting|not\s+ready|not\s+finished|unfinished|no\s+result|no\s+output|empty\s+result|result\s+empty)/i.test(value);
}

function normalizeXaisFailure(value: string) {
  const normalized = value.trim();
  if (!normalized || /^unknown error$/i.test(normalized) || isXaisPendingMessage(normalized)) return '';
  return normalized;
}

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
    if (typeof candidate === 'string') {
      const failure = normalizeXaisFailure(candidate);
      if (failure) return failure;
    }
  }
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (/^(failed|failure|error|cancelled|canceled)$/.test(status)) {
    return typeof record.message === 'string'
      ? normalizeXaisFailure(record.message) || ''
      : status;
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

export function xaisAttachmentRegistrationUrls(value: unknown) {
  return uniqueImages(value, [], 8).filter((url) => /^https?:\/\//i.test(url));
}

export async function confirmXaisReferenceAttachment(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  attachmentName: string,
  wait: (milliseconds: number) => Promise<unknown> = delay,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < XAIS_ATTACHMENT_REGISTRATION_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(600 * attempt);
    try {
      const registered = await providerRequest(
        provider,
        secrets,
        `/xais/attUrls?att=${encodeURIComponent(attachmentName)}`,
        undefined,
        30_000,
      );
      const failure = getFailure(registered);
      if (failure) throw new Error(failure);
      if (xaisAttachmentRegistrationUrls(registered).length === 0) {
        throw new Error('XAIS attachment registration did not resolve an image URL');
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error
    ? lastError.message
    : typeof lastError === 'string' ? lastError : JSON.stringify(lastError ?? 'unknown error');
  throw new Error(`XAIS reference attachment registration failed: ${detail}`);
}

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

export async function runXaisWorkerTask(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const model = resolveXaisModel(input.model);
  const isNanoModel = /(?:Nano_Banana|Xais_Nano)/i.test(model);
  const isNanoLiteModel = /Lite/i.test(model);
  const referenceInputs = await uploadXaisReferenceImages(
    provider,
    secrets,
    input.inputImages,
  );
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
      ...(input.background === 'transparent' ? { background: 'transparent' } : {}),
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
  let pollAttempt = 0;
  while (Date.now() < deadline) {
    if (pollAttempt > 0) await delay(XAIS_IMAGE_TASK_POLL_INTERVAL_MS);
    pollAttempt += 1;
    let waited: unknown = null;
    try {
      waited = await providerRequest(
        provider,
        secrets,
        `/xais/workerTaskWait?json=1&id=${encodeURIComponent(taskId)}`,
        undefined,
        XAIS_IMAGE_TASK_POLL_REQUEST_TIMEOUT_MS,
      );
      lastTransientError = null;
    } catch (error) {
      if (!isRetryableXaisPollError(error)) throw error;
      lastTransientError = error;
    }
    if (waited !== null) {
      const failure = getFailure(waited);
      if (failure) throw new Error(failure);
      const images = uniqueImages(waited, input.inputImages, 1);
      if (images.length) return images[0]!;
    }
    const attachments = Array.from(new Set([
      taskId,
      ...collectAttachmentIds(waited),
    ]));
    for (const attachment of attachments) {
      let resolved: unknown;
      try {
        resolved = await providerRequest(
          provider,
          secrets,
          `/xais/attUrls?att=${encodeURIComponent(attachment)}`,
          undefined,
          XAIS_IMAGE_TASK_POLL_REQUEST_TIMEOUT_MS,
        );
        lastTransientError = null;
      } catch (error) {
        const isTaskIdProbe = attachment === taskId;
        const isAuthorizationFailure = error instanceof UpstreamImageError
          && (error.status === 401 || error.status === 403);
        if (isAuthorizationFailure || (!isTaskIdProbe && !isRetryableXaisPollError(error))) throw error;
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
      ...(input.outputFormat === 'png' || input.background === 'transparent'
        ? { output_format: 'png', background: 'transparent' }
        : {}),
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

async function reserveImageCredits(
  prisma: PrismaClient,
  input: ImageInput,
  providerCapabilities?: readonly string[],
) {
  const unitCredits = await configuredImageUnitCredits(
    prisma,
    input.model,
    input.resolution,
    providerCapabilities,
  );
  const estimated = unitCredits * BigInt(input.count);
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
        data: {
          status: 'RESERVED',
          logicalModel: input.model,
          estimatedCredits: estimated,
          chargedCredits: 0n,
          result: Prisma.DbNull,
          completedAt: null,
        },
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
  return { requestId, estimated, unitCredits };
}

async function settleImageCredits(
  prisma: PrismaClient,
  input: ImageInput,
  requestId: string,
  estimated: bigint,
  unitCredits: bigint,
  generatedCount: number,
  result: Omit<WalletImageGenerationResult, 'chargedCredits'>,
) {
  const charged = unitCredits * BigInt(generatedCount);
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
      data: {
        status: 'SUCCEEDED',
        chargedCredits: charged,
        result: {
          ...result,
          chargedCredits: charged.toString(),
        } satisfies Prisma.InputJsonValue,
        completedAt: new Date(),
      },
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
      data: { status: 'FAILED', result: Prisma.DbNull, completedAt: new Date() },
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
  // A client may retry after the upstream completed but the HTTP response was
  // lost. Return the persisted result instead of turning that retry into a
  // duplicate-request error with no usable image on the client.
  const existing = await getWalletImageGenerationByRequest(
    prisma,
    input.userId,
    input.clientRequestId,
  );
  if (existing?.status === 'succeeded' && Array.isArray(existing.images) && existing.images.length > 0 && existing.provider && existing.model && existing.chargedCredits) {
    return existing;
  }
  const provider = await selectImageProvider(
    prisma,
    input.providerChannelId,
    input.model,
    input.resolution,
  );
  if (provider.kind === 'XAIS' && input.inputImages.length > 8) {
    throw new CloudAiError('invalid_request', 'XAIS 生图最多支持 8 张参考图', 400);
  }
  const effectiveInput = { ...input, model: resolveImageModel(provider, input.model) };
  const reservation = await reserveImageCredits(prisma, effectiveInput, provider.capabilities);
  try {
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const providerImages = provider.kind === 'XAIS'
      ? await generateXaisImages(provider, secrets, effectiveInput)
      : provider.kind === 'BIGMODEL'
        ? await generateBigmodelImages(provider, secrets, effectiveInput)
        : await generateNewApiImages(provider, secrets, effectiveInput);
    const images = provider.kind === 'XAIS' || provider.kind === 'BIGMODEL'
      ? await mirrorXaisImageResults(providerImages, provider.name)
      : providerImages;
    if (!images.length) throw new Error('渠道没有返回图片数据');
    const charged = await settleImageCredits(
      prisma,
      effectiveInput,
      reservation.requestId,
      reservation.estimated,
      reservation.unitCredits,
      images.length,
      {
        images,
        provider: provider.kind,
        providerChannelId: provider.id,
        providerChannelName: provider.name,
        model: effectiveInput.model,
      },
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
      if (provider.kind === 'NEW_API' && isNewApiParamOverrideCopyError(error)) {
        throw new CloudAiError(
          'provider_param_override_invalid',
          'NewAPI 生图渠道的参数覆盖配置错误：copy.from 指向 images/generations 或 images/edits 请求中不存在的字段，请检查该渠道的 ParamOverride operations',
          502,
        );
      }
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

export async function getWalletImageGenerationByRequest(
  prisma: PrismaClient,
  userId: string,
  clientRequestId: string,
) {
  const request = await prisma.aiRequest.findUnique({
    where: {
      userId_clientRequestId: {
        userId,
        clientRequestId,
      },
    },
    select: {
      capability: true,
      status: true,
      result: true,
      completedAt: true,
    },
  });
  if (!request || request.capability !== 'IMAGE') return null;
  const result = parseWalletImageGenerationResult(request.result);
  return {
    status: request.status.toLowerCase(),
    completedAt: request.completedAt?.getTime() ?? null,
    ...(result ?? {}),
  };
}

export type VideoInput = {
  userId: string;
  clientRequestId: string;
  provider?: 'new-api' | 'xais-chat' | 'mikoto' | 'bigmodel' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  inputImages: string[];
  inputVideos?: string[] | undefined;
  inputAudios?: string[] | undefined;
  aspectRatio: string;
  resolution?: string | undefined;
  duration?: number | undefined;
  inputMode?: 'REF' | 'FLF' | undefined;
  count: number;
};

function videoProviderKind(provider?: VideoInput['provider']) {
  if (provider === 'xais-chat') return 'XAIS' as const;
  if (provider === 'new-api') return 'NEW_API' as const;
  if (provider === 'mikoto') return 'MIKOTO' as const;
  if (provider === 'bigmodel') return 'BIGMODEL' as const;
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

export function isSora2VideoModel(model: string) {
  return model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') === 'sora-2';
}

export function isSourceMixVideoModel(model: string) {
  const normalized = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized === 'sourcemix2-0' || normalized === 'sourcemix2-0-fast';
}

export function isSeedance20VideoModel(model: string) {
  const normalized = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized === 'seedance2'
    || normalized === 'seedance20'
    || normalized === 'seedance2fast'
    || normalized === 'seedance20fast'
    || normalized === 'sourcemix20'
    || normalized === 'sourcemix20fast';
}

type NewApiVideoProtocol = 'openai-videos' | 'unified-video';

export function newApiVideoProtocol(model: string): NewApiVideoProtocol {
  return isSora2VideoModel(model) ? 'unified-video' : 'openai-videos';
}

export function newApiVideoProtocolCandidates(
  model: string,
  preferred: NewApiVideoProtocol = newApiVideoProtocol(model),
) {
  if (!isSourceMixVideoModel(model)) return [preferred];
  const alternate: NewApiVideoProtocol = preferred === 'openai-videos'
    ? 'unified-video'
    : 'openai-videos';
  return [preferred, alternate];
}

function newApiVideoSubmitPathForProtocol(protocol: NewApiVideoProtocol) {
  return protocol === 'unified-video'
    ? '/v1/video/generations'
    : '/v1/videos';
}

export function newApiVideoSubmitPath(model: string) {
  return newApiVideoSubmitPathForProtocol(newApiVideoProtocol(model));
}

export function newApiVideoStatusPath(protocol: NewApiVideoProtocol, taskId: string) {
  const encodedTaskId = encodeURIComponent(taskId);
  return protocol === 'unified-video'
    ? `/v1/video/generations/${encodedTaskId}`
    : `/v1/videos/${encodedTaskId}`;
}

export function isVeo31VideoModel(model: string) {
  const normalized = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized === 'veo-3-1' || normalized === 'veo-3-1-fast';
}

export function buildNewApiVideoPrompt(input: VideoInput, imageCount: number) {
  const prompt = input.prompt.trim();
  if (!isVeo31VideoModel(input.model) || input.inputMode === 'FLF' || imageCount <= 0) return prompt;
  const guidance = [
    '参考图1为主体参考：保持主体（人物、角色或产品等）的外观、结构、颜色和关键识别特征一致。',
    '参考图2为场景/背景参考：保持环境、空间关系、构图和光线氛围。',
    '参考图3为风格/纹理参考：保持材质、色彩、质感和整体视觉风格。',
  ].slice(0, Math.min(3, imageCount));
  return `${prompt}\n\n参考图用途（请按编号分别使用，不要混淆）：\n${guidance.join('\n')}`;
}

export function normalizeNewApiVideoDuration(model: string, duration?: number) {
  const values = isSora2VideoModel(model)
    ? [8, 12]
    : isSeedance20VideoModel(model) ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
      : [4, 5, 6, 7, 8];
  const requested = Number(duration);
  if (values.includes(requested)) return requested;
  const fallback = values[0] ?? 8;
  if (!Number.isFinite(requested)) return fallback;
  return values.reduce((best, value) => (
    Math.abs(value - requested) < Math.abs(best - requested) ? value : best
  ), fallback);
}

export function videoDurationSecondsForBilling(
  model: string,
  duration?: number,
  providerKind?: AiProviderChannel['kind'],
) {
  if (providerKind === 'NEW_API') return normalizeNewApiVideoDuration(model, duration);
  const requested = Number(duration);
  return Number.isFinite(requested) && requested > 0 ? Math.ceil(requested) : 15;
}

export function calculateVideoGenerationCredits(
  creditsPerSecond: bigint,
  model: string,
  duration: number | undefined,
  count: number,
  providerKind?: AiProviderChannel['kind'],
) {
  const durationSeconds = videoDurationSecondsForBilling(model, duration, providerKind);
  return creditsPerSecond * BigInt(durationSeconds) * BigInt(count);
}

export function newApiVideoSize(model: string, aspectRatio?: string, resolution?: string) {
  const normalizedRatio = aspectRatio?.trim();
  const normalizedResolution = !isSora2VideoModel(model)
    && (resolution?.trim().toLowerCase() === '1080p'
      || (isSeedance20VideoModel(model) && resolution?.trim().toLowerCase() === '480p'))
    ? resolution!.trim().toLowerCase()
    : '720p';
  const shortEdge = normalizedResolution === '1080p' ? 1080 : normalizedResolution === '480p' ? 480 : 720;
  if (normalizedRatio === '9:16') {
    return `${shortEdge}x${shortEdge === 480 ? 854 : Math.round(shortEdge * 16 / 9)}`;
  }
  if (normalizedRatio === '3:4') return `${shortEdge}x${Math.round(shortEdge * 4 / 3)}`;
  if (normalizedRatio === '4:3') return `${Math.round(shortEdge * 4 / 3)}x${shortEdge}`;
  if (normalizedRatio === '1:1') return `${shortEdge}x${shortEdge}`;
  return `${shortEdge === 480 ? 854 : Math.round(shortEdge * 16 / 9)}x${shortEdge}`;
}

export function newApiVideoBody(input: VideoInput) {
  const isSeedance = isSeedance20VideoModel(input.model);
  const imageLimit = isSora2VideoModel(input.model) ? 1 : isSeedance ? 9 : 3;
  const maxImages = isSora2VideoModel(input.model)
    ? 1
    : input.inputMode === 'FLF' ? 2 : imageLimit;
  const images = input.inputImages.filter(Boolean).slice(0, maxImages);
  const videos = isSeedance ? (input.inputVideos || []).filter(Boolean).slice(0, 3) : [];
  const audios = isSeedance ? (input.inputAudios || []).filter(Boolean).slice(0, 3) : [];
  const duration = normalizeNewApiVideoDuration(input.model, input.duration);
  const size = newApiVideoSize(input.model, input.aspectRatio, input.resolution);
  return {
    model: input.model,
    prompt: buildNewApiVideoPrompt(input, images.length),
    duration,
    seconds: String(duration),
    size,
    resolution: size.includes('1080') ? '1080p' : size.includes('480') ? '480p' : '720p',
    ...(images.length ? { images } : {}),
    ...(videos.length ? { videos } : {}),
    ...(audios.length ? { audios } : {}),
    ...(isSeedance && images.length + videos.length + audios.length > 0
      ? { ref: [...images, ...videos, ...audios] }
      : {}),
  };
}

export function newApiVideoJsonBody(input: VideoInput) {
  const body = newApiVideoBody(input);
  return {
    model: body.model,
    prompt: body.prompt,
    duration: body.duration,
    size: body.size,
    ...(body.images ? { images: body.images } : {}),
    ...(body.videos ? { videos: body.videos } : {}),
    ...(body.audios ? { audios: body.audios } : {}),
    ...(body.ref ? { ref: body.ref } : {}),
  };
}

async function generateBigmodelImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const stagedImages = await Promise.all(input.inputImages.map((source, index) => (
    stageNewApiEditImage(source, index)
  )));
  try {
    const referenceParts = await Promise.all(stagedImages.map(async (image) => {
      const bytes = image.bytes ?? (image.path ? await readFile(image.path) : Buffer.alloc(0));
      if (!bytes.length) throw new Error('Bigmodel reference image is empty');
      return {
        inlineData: {
          mimeType: image.mime,
          data: bytes.toString('base64'),
        },
      };
    }));
    const resolution = input.resolution?.trim().toLowerCase();
    const imageSize = resolution === '1k' || resolution === '4k'
      ? resolution.toUpperCase()
      : '2K';
    const started = await providerBigmodelRequest(provider, secrets, input.model, {
      contents: [{
        role: 'user',
        parts: [
          { text: promptWithConstraints(input) },
          ...referenceParts,
        ],
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        responseFormat: {
          image: {
            aspectRatio: input.aspectRatio,
            imageSize,
          },
        },
      },
    });
    const failure = getFailure(started);
    if (failure) throw new Error(failure);
    const images = uniqueImages(started, input.inputImages, input.count);
    if (!images.length) throw new Error('Bigmodel response did not contain image data');
    return images;
  } finally {
    await Promise.all(stagedImages.map(image => image.cleanup().catch(() => {})));
  }
}

async function stagedImageDataUrl(image: StagedNewApiEditImage) {
  const bytes = image.bytes ?? (image.path ? await readFile(image.path) : Buffer.alloc(0));
  if (!bytes.length) throw new Error('video reference image is empty');
  return `data:${image.mime};base64,${bytes.toString('base64')}`;
}

export async function providerNewApiVideoRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: VideoInput,
  preferredProtocol: NewApiVideoProtocol = newApiVideoProtocol(input.model),
) {
  const imageLimit = isSora2VideoModel(input.model)
    ? 1
    : isSeedance20VideoModel(input.model) ? 9 : 3;
  const sources = input.inputImages.filter(Boolean).slice(0, imageLimit);
  if (input.inputMode === 'FLF' && !isSora2VideoModel(input.model) && sources.length !== 2) {
    throw new CloudAiError('invalid_video_input', '首尾帧模式需要同时提供首帧和尾帧两张图片', 400);
  }
  const protocols = newApiVideoProtocolCandidates(input.model, preferredProtocol);
  const images = await Promise.all(sources.map((source, index) => stageNewApiEditImage(source, index)));
  try {
    const submitJson = async (protocol: NewApiVideoProtocol) => {
      const imageDataUrls = await Promise.all(images.map(stagedImageDataUrl));
      const body = newApiVideoJsonBody({ ...input, inputImages: imageDataUrls });
      return providerRequest(
        provider,
        secrets,
        newApiVideoSubmitPathForProtocol(protocol),
        body,
      );
    };
    const submitMultipart = async (requestModel: string, protocol: NewApiVideoProtocol) => {
      const body = newApiVideoBody({ ...input, inputImages: sources }) as Record<string, unknown>;
      body.model = requestModel;
      delete body.images;
      delete body.input_reference;
      delete body.image_tail;
      const boundary = `inspiration-video-${randomUUID().replace(/-/g, '')}`;
      const textParts = Object.entries(body)
        .filter((entry): entry is [string, string | number | boolean] => (
          typeof entry[1] === 'string'
          || typeof entry[1] === 'number'
          || typeof entry[1] === 'boolean'
        ))
        .map(([name, value]) => newApiMultipartTextPart(boundary, name, String(value)));
      const fieldNames = images.map((_, index) => (
        input.inputMode === 'FLF' && index === 1 ? 'image_tail' : 'input_reference'
      ));
      for (let index = 0; index < images.length; index += 1) {
        textParts.push(newApiMultipartTextPart(
          boundary,
          fieldNames[index]!,
          await stagedImageDataUrl(images[index]!),
        ));
      }
      const fileHeaders = images.map((image, index) => (
        newApiMultipartFileHeader(boundary, image, fieldNames[index])
      ));
      const fileFooters = images.map(() => Buffer.from('\r\n', 'utf8'));
      const closing = Buffer.from(`--${boundary}--\r\n`, 'utf8');
      const contentLength = textParts.reduce((total, part) => total + part.byteLength, 0)
        + images.reduce((total, image, index) => (
          total + fileHeaders[index]!.byteLength + image.size + fileFooters[index]!.byteLength
        ), 0)
        + closing.byteLength;
      const bodyStream = Readable.from((async function* multipartBody() {
        for (const part of textParts) yield part;
        for (let index = 0; index < images.length; index += 1) {
          const image = images[index]!;
          yield fileHeaders[index]!;
          if (image.path) {
            for await (const chunk of createReadStream(image.path)) yield chunk;
          } else if (image.bytes) {
            yield image.bytes;
          }
          yield fileFooters[index]!;
        }
        yield closing;
      })());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
      try {
        const headers = upstreamHeaders(secrets);
        headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        headers.set('content-length', String(contentLength));
        const request: RequestInit & { duplex?: 'half' } = {
          method: 'POST',
          headers,
          body: Readable.toWeb(bodyStream) as unknown as BodyInit,
          redirect: 'error',
          signal: controller.signal,
          duplex: 'half',
        };
        const response = await fetch(
          providerEndpoint(provider.baseUrl, newApiVideoSubmitPathForProtocol(protocol)),
          request,
        );
        const text = await response.text();
        if (!response.ok) {
          throw new UpstreamImageError(response.status, upstreamErrorMessage(response.status, text));
        }
        return parseProviderValue(text);
      } catch (error) {
        if (error instanceof UpstreamImageError || error instanceof CloudAiError) throw error;
        throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timeout);
        bodyStream.destroy();
      }
    };
    let lastError: unknown;
    for (let index = 0; index < protocols.length; index += 1) {
      const protocol = protocols[index]!;
      try {
        const result = isSourceMixVideoModel(input.model) || isSeedance20VideoModel(input.model)
          ? await submitJson(protocol)
          : await submitMultipart(input.model, protocol);
        return { result, protocol };
      } catch (error) {
        lastError = error;
        if (index === protocols.length - 1 || !isNewApiVideoRouteNotFound(error)) throw error;
        console.warn('[newapi_video_submit_protocol_fallback]', {
          provider: provider.name,
          model: input.model,
          from: protocol,
          to: protocols[index + 1],
        });
      }
    }
    throw lastError;
  } finally {
    await Promise.all(images.map(image => image.cleanup().catch(() => {})));
  }
}

type StagedVideoResult = {
  path: string;
  mime: string;
  size: number;
  cleanup: () => Promise<void>;
};

type PersistedVideoRequestState = {
  kind: 'video_tasks';
  provider: string;
  providerChannelId: string;
  apiProtocol?: NewApiVideoProtocol;
  taskIds: string[];
  completedTaskIds: string[];
  outputs: Record<string, string>;
};

function collectVideoUrls(value: unknown, output: string[] = [], contextKey = ''): string[] {
  if (!value) return output;
  if (typeof value === 'string') {
    const urls = value.match(/https?:\/\/[^\s"'<>)}\]]+/gi);
    if (urls && (!contextKey || /(?:video|url|uri|download|output|file|result|content)/i.test(contextKey))) {
      output.push(...urls
        .map(url => url.replace(/[.,;]+$/g, ''))
        .filter(url => !/\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[?#]|$)/i.test(url)));
    }
    if (/^data:video\//i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoUrls(item, output, contextKey);
    return output;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (/^(?:error|err|message|detail|trace|stack|debug)$/i.test(key)) continue;
      collectVideoUrls(nested, output, key);
    }
  }
  return output;
}

function videoTaskState(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const direct = record.status ?? record.state ?? record.task_status ?? record.taskStatus;
  if (typeof direct === 'string') return direct.trim().toLowerCase();
  for (const key of ['data', 'result', 'task', 'response']) {
    const nested = videoTaskState(record[key]);
    if (nested) return nested;
  }
  return '';
}

function isCompletedVideoState(state: string) {
  return /^(?:completed|complete|succeeded|success|finished|done)$/.test(state);
}

function videoExtension(mime: string, bytes: Uint8Array) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return 'mp4';
}

async function writeVideoResponseToFile(response: Response): Promise<StagedVideoResult> {
  if (!response.body) throw new Error('video content response has no body');
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_RESULT_BYTES) {
    throw new Error('generated video exceeds the 512 MB transfer limit');
  }
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-video-result-'));
  const path = join(directory, 'result.bin');
  const file = await open(path, 'w');
  const reader = response.body.getReader();
  const prefix: Buffer[] = [];
  let prefixLength = 0;
  let total = 0;
  let writeError: unknown = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_RESULT_BYTES) {
        await reader.cancel();
        throw new Error('generated video exceeds the 512 MB transfer limit');
      }
      if (prefixLength < 32) {
        const chunk = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, 32 - prefixLength));
        prefix.push(Buffer.from(chunk));
        prefixLength += chunk.byteLength;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('generated video temporary file write failed');
        offset += bytesWritten;
      }
    }
  } catch (error) {
    writeError = error;
  } finally {
    await file.close();
  }
  if (writeError) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw writeError instanceof Error
      ? writeError
      : new Error(typeof writeError === 'string' ? writeError : 'generated video temporary file write failed');
  }
  if (!total) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error('video content response is empty');
  }
  const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  const extension = videoExtension(headerMime, Buffer.concat(prefix));
  const mime = headerMime.startsWith('video/') ? headerMime
    : extension === 'webm' ? 'video/webm'
      : extension === 'mov' ? 'video/quicktime' : 'video/mp4';
  const finalPath = join(directory, `result.${extension}`);
  await rename(path, finalPath);
  return {
    path: finalPath,
    mime,
    size: total,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function providerVideoContentRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  taskId: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIDEO_RESULT_DOWNLOAD_TIMEOUT_MS);
  try {
    let current = new URL(providerEndpoint(provider.baseUrl, `/v1/videos/${encodeURIComponent(taskId)}/content`));
    const providerOrigin = current.origin;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const headers = current.origin === providerOrigin
        ? upstreamHeaders(secrets)
        : new Headers();
      headers.delete('content-type');
      headers.set('accept', 'video/mp4,video/webm,video/*,application/octet-stream,application/json;q=0.5,*/*;q=0.1');
      const response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects >= 3) throw new Error('video content redirect is invalid');
        current = new URL(location, current);
        await assertPublicProviderUrl(current.toString());
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new UpstreamImageError(response.status, upstreamErrorMessage(response.status, text));
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (contentType.includes('json') || contentType.startsWith('text/')) {
        return { value: parseProviderValue(await response.text()) };
      }
      return { staged: await writeVideoResponseToFile(response) };
    }
    throw new Error('video content redirect limit exceeded');
  } finally {
    clearTimeout(timeout);
  }
}

function videoResultPublicUrl(filename: string) {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/video-results/${filename}`;
}

async function mirrorProviderVideoContent(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  taskId: string,
) {
  const key = createHash('sha256').update(`${provider.id}:${taskId}`).digest('hex');
  for (const extension of ['mp4', 'webm', 'mov']) {
    const filename = `${key}.${extension}`;
    if (await ossUploadService.exists(`generated-videos/${filename}`)) {
      return videoResultPublicUrl(filename);
    }
  }
  const content = await providerVideoContentRequest(provider, secrets, taskId);
  if ('value' in content) {
    return Array.from(new Set(collectVideoUrls(content.value)))[0] || '';
  }
  const staged = content.staged;
  try {
    const extension = videoExtension(staged.mime, Buffer.alloc(0));
    const filename = `${key}.${extension}`;
    const objectName = await ossUploadService.upload({
      namespace: 'generated-videos',
      filename,
      source: staged.path,
      mime: staged.mime,
    });
    if (!await ossUploadService.exists(objectName)) {
      throw new Error('generated video mirror object is missing after upload');
    }
    ossUploadService.getPublicUrl(objectName, { mime: staged.mime, filename });
    return videoResultPublicUrl(filename);
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

function parsePersistedVideoState(value: Prisma.JsonValue | null): PersistedVideoRequestState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.kind !== 'video_tasks' || !Array.isArray(state.taskIds)) return null;
  return {
    kind: 'video_tasks',
    provider: typeof state.provider === 'string' ? state.provider : '',
    providerChannelId: typeof state.providerChannelId === 'string' ? state.providerChannelId : '',
    ...(state.apiProtocol === 'unified-video' || state.apiProtocol === 'openai-videos'
      ? { apiProtocol: state.apiProtocol }
      : {}),
    taskIds: state.taskIds.filter((item): item is string => typeof item === 'string'),
    completedTaskIds: Array.isArray(state.completedTaskIds)
      ? state.completedTaskIds.filter((item): item is string => typeof item === 'string')
      : [],
    outputs: state.outputs && typeof state.outputs === 'object' && !Array.isArray(state.outputs)
      ? Object.fromEntries(Object.entries(state.outputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {},
  };
}

async function recordVideoSubmission(
  prisma: PrismaClient,
  input: VideoInput,
  provider: AiProviderChannel,
  taskIds: string[],
  apiProtocol?: NewApiVideoProtocol,
) {
  const state: PersistedVideoRequestState = {
    kind: 'video_tasks',
    provider: provider.kind,
    providerChannelId: provider.id,
    ...(provider.kind === 'NEW_API'
      ? { apiProtocol: apiProtocol ?? newApiVideoProtocol(input.model) }
      : {}),
    taskIds,
    completedTaskIds: [],
    outputs: {},
  };
  await prisma.aiRequest.update({
    where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    data: { status: 'PROCESSING', result: state },
  });
}

async function recordVideoTaskCompleted(
  prisma: PrismaClient,
  userId: string,
  clientRequestId: string | undefined,
  taskId: string,
  output: string,
) {
  if (!clientRequestId) return;
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
    if (!request || request.capability !== 'VIDEO') return;
    const current = parsePersistedVideoState(request.result) ?? {
      kind: 'video_tasks' as const,
      provider: '',
      providerChannelId: '',
      taskIds: [taskId],
      completedTaskIds: [],
      outputs: {},
    };
    const completedTaskIds = Array.from(new Set([...current.completedTaskIds, taskId]));
    const next: PersistedVideoRequestState = {
      ...current,
      completedTaskIds,
      outputs: { ...current.outputs, [taskId]: output },
    };
    const allCompleted = current.taskIds.length > 0
      && current.taskIds.every(id => completedTaskIds.includes(id));
    if (!allCompleted || request.status === 'SUCCEEDED') {
      await transaction.aiRequest.update({
        where: { id: request.id },
        data: { result: next },
      });
      return;
    }
    if (request.status !== 'RESERVED' && request.status !== 'PROCESSING') return;
    const charged = request.estimatedCredits;
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: { reservedCredits: { decrement: charged }, lifetimeConsumed: { increment: charged } },
    });
    await transaction.aiRequest.update({
      where: { id: request.id },
      data: {
        status: 'SUCCEEDED',
        chargedCredits: charged,
        completedAt: new Date(),
        result: next,
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId: request.id,
        type: 'CHARGE',
        amount: charged,
        balanceAfter: wallet.availableCredits,
        description: '视频任务完成结算',
      },
    });
  });
}

async function reserveVideo(
  prisma: PrismaClient,
  input: VideoInput,
  providerKind: AiProviderChannel['kind'],
) {
  const creditsPerSecond = await configuredVideoCreditsPerSecond(prisma, input.model);
  const durationSeconds = videoDurationSecondsForBilling(input.model, input.duration, providerKind);
  const estimated = calculateVideoGenerationCredits(
    creditsPerSecond,
    input.model,
    input.duration,
    input.count,
    providerKind,
  );
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
    await transaction.walletLedger.create({ data: { userId: input.userId, requestId: request.id, type: 'RESERVE', amount: -estimated, balanceAfter: wallet.availableCredits, description: `视频请求预扣（${durationSeconds}秒 × ${input.count}条）` } });
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
  const provider = await selectVideoProvider(prisma, input.provider, input.providerChannelId);
  const reservation = await reserveVideo(prisma, input, provider.kind);
  try {
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const results: unknown[] = [];
    let submittedProtocol = provider.kind === 'NEW_API'
      ? newApiVideoProtocol(input.model)
      : undefined;
    for (let index = 0; index < input.count; index += 1) {
      let result: unknown;
      if (provider.kind === 'XAIS') {
        result = await providerRequest(provider, secrets, '/xais/workerTaskStart', xaisVideoBody(input));
      } else {
        const submission = await providerNewApiVideoRequest(
          provider,
          secrets,
          input,
          submittedProtocol,
        );
        result = submission.result;
        submittedProtocol = submission.protocol;
      }
      const failure = getFailure(result);
      if (failure) throw new CloudAiError('video_generation_failed', failure, 502);
      results.push(result);
    }
    const taskIds = Array.from(new Set(results
      .map(result => getTaskId(result))
      .filter(taskId => taskId && !/^(?:https?:|data:)/i.test(taskId))));
    if (taskIds.length > 0) {
      await recordVideoSubmission(prisma, input, provider, taskIds, submittedProtocol);
    } else {
      const directOutputs = Array.from(new Set(collectVideoUrls(results)));
      if (directOutputs.length < input.count) {
        throw new CloudAiError('video_generation_failed', '视频渠道没有返回任务 ID 或视频地址', 502);
      }
      await settleVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    }
    return { results, provider: provider.kind, model: input.model, chargedCredits: reservation.estimated.toString() };
  } catch (error) {
    await releaseVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    throw new CloudAiError('video_generation_failed', error instanceof Error ? error.message : '视频生成失败', 502);
  }
}

export function isNewApiVideoRouteNotFound(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : JSON.stringify(error ?? '') ?? '';
  const has404 = /HTTP\s*404/i.test(message)
    || /status[_\s-]*code["']?\s*[:=]\s*404/i.test(message);
  return has404 && (
    /["']detail["']\s*:\s*["'](?:Not Found|未找到)["']/i.test(message)
    || /(?:Invalid URL|route not found)/i.test(message)
  );
}

async function resolveNewApiVideoStatusProtocol(
  prisma: PrismaClient,
  userId: string,
  clientRequestId?: string,
): Promise<NewApiVideoProtocol> {
  if (!clientRequestId) return 'openai-videos';
  const request = await prisma.aiRequest.findUnique({
    where: { userId_clientRequestId: { userId, clientRequestId } },
    select: { capability: true, logicalModel: true, result: true },
  });
  if (!request || request.capability !== 'VIDEO') return 'openai-videos';
  const persisted = parsePersistedVideoState(request.result);
  return persisted?.apiProtocol ?? newApiVideoProtocol(request.logicalModel);
}

async function providerNewApiVideoStatusRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  taskId: string,
  protocol: NewApiVideoProtocol,
) {
  const alternate: NewApiVideoProtocol = protocol === 'unified-video'
    ? 'openai-videos'
    : 'unified-video';
  try {
    return await providerRequest(provider, secrets, newApiVideoStatusPath(protocol, taskId));
  } catch (error) {
    if (!isNewApiVideoRouteNotFound(error)) throw error;
    console.warn('[newapi_video_status_protocol_fallback]', {
      provider: provider.name,
      taskId,
      from: protocol,
      to: alternate,
    });
    return providerRequest(provider, secrets, newApiVideoStatusPath(alternate, taskId));
  }
}

export async function executeWalletVideoStatus(
  prisma: PrismaClient,
  input: { userId: string; provider?: VideoInput['provider']; providerChannelId?: string | undefined; taskId: string; clientRequestId?: string | undefined },
) {
  const provider = await selectVideoProvider(prisma, input.provider, input.providerChannelId);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  let waited: unknown;
  try {
    if (provider.kind === 'XAIS') {
      waited = await providerRequest(
        provider,
        secrets,
        `/xais/workerTaskWait?json=1&id=${encodeURIComponent(input.taskId)}`,
      );
    } else {
      const protocol = await resolveNewApiVideoStatusProtocol(
        prisma,
        input.userId,
        input.clientRequestId,
      );
      waited = await providerNewApiVideoStatusRequest(
        provider,
        secrets,
        input.taskId,
        protocol,
      );
    }
  } catch (error) {
    if (provider.kind === 'XAIS' || !isRecoverableNewApiVideoStatusError(error)) throw error;
    console.warn('[newapi_video_status_recovery]', {
      provider: provider.name,
      taskId: input.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const output = await mirrorProviderVideoContent(provider, secrets, input.taskId);
      if (output) {
        await recordVideoTaskCompleted(
          prisma,
          input.userId,
          input.clientRequestId,
          input.taskId,
          output,
        );
        return { status: 'completed', video_url: output, recovered_from_content: true };
      }
    } catch (contentError) {
      console.warn('[newapi_video_status_and_content_pending]', {
        provider: provider.name,
        taskId: input.taskId,
        error: contentError instanceof Error ? contentError.message : String(contentError),
      });
    }
    return { status: 'processing', content_pending: true, status_retry: true };
  }
  const failure = getFailure(waited);
  if (failure) {
    if (input.clientRequestId) {
      await refundVideoRequest(prisma, input.userId, input.clientRequestId);
    }
    throw new CloudAiError('video_generation_failed', failure, 502);
  }
  if (provider.kind !== 'XAIS') {
    const directOutputs = Array.from(new Set(collectVideoUrls(waited)));
    const state = videoTaskState(waited);
    if (directOutputs.length > 0) {
      await recordVideoTaskCompleted(
        prisma,
        input.userId,
        input.clientRequestId,
        input.taskId,
        directOutputs[0]!,
      );
      return waited;
    }
    if (!isCompletedVideoState(state)) return waited;
    try {
      const output = await mirrorProviderVideoContent(provider, secrets, input.taskId);
      if (!output) {
        return { result: waited, status: 'processing', content_pending: true };
      }
      await recordVideoTaskCompleted(
        prisma,
        input.userId,
        input.clientRequestId,
        input.taskId,
        output,
      );
      return { result: waited, status: 'completed', video_url: output };
    } catch (error) {
      console.warn('[newapi_video_content_recovery_pending]', {
        provider: provider.name,
        taskId: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { result: waited, status: 'processing', content_pending: true };
    }
  }
  const attachments = collectAttachmentIds(waited)
    .filter((value) => !/^(?:pending|processing|queued|completed|success|succeeded|failed|failure|error|cancelled|canceled)$/i.test(value));
  if (!attachments.length) return waited;
  const resolved: unknown[] = [];
  for (const attachment of Array.from(new Set(attachments))) {
    resolved.push(await providerRequest(provider, secrets, `/xais/attUrls?att=${encodeURIComponent(attachment)}`));
  }
  const outputs = Array.from(new Set(collectVideoUrls(resolved)));
  if (outputs.length > 0) {
    await recordVideoTaskCompleted(
      prisma,
      input.userId,
      input.clientRequestId,
      input.taskId,
      outputs[0]!,
    );
  }
  return { result: waited, attachments: resolved };
}

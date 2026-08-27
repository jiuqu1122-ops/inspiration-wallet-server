import { Prisma } from '@prisma/client';
import type { AiCapability, AiProviderChannel, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Agent } from 'undici';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
import { CloudAiError } from './service.js';
import {
  aiPricingModelToken as imageModelToken,
  configuredImageUnitCredits,
  configuredVideoRequestCredits,
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
import { mirrorGeneratedVideoResultToOss } from './video-result-store.js';

export const IMAGE_GENERATION_TIMEOUT_MS = 15 * 60_000;
const longImageRequestDispatcher = new Agent({
  headersTimeout: IMAGE_GENERATION_TIMEOUT_MS,
  bodyTimeout: IMAGE_GENERATION_TIMEOUT_MS,
});
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
const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;
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

const USELG_GROK_GENERATION_MODEL = 'grok-imagine-image-quality';
const USELG_GROK_EDIT_MODEL = 'grok-imagine-image-edit';

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
  'IMAGE_NANO_BANANA_PRO_FAST',
  'IMAGE_NANO_BANANA_2_FAST',
  'IMAGE_NANO_BANANA_DUAL_2K',
  // Kept during the transition so existing database rows remain routable.
  'IMAGE_NANO_BANANA_PRO_1K',
  'IMAGE_GPT',
  'IMAGE_GPT_1K',
  'IMAGE_GROK',
];
const VIDEO_PROVIDER_CAPABILITIES: AiCapability[] = ['VIDEO', 'VIDEO_MINIMAX'];

export function imageCapabilityForModel(model: string, resolution?: string): AiCapability {
  const token = imageModelToken(model);
  if (token.includes('grokimagineimage') || token.includes('grokimage')) {
    return 'IMAGE_GROK';
  }
  if (token.includes('gptimage') || token.includes('image2') || token.includes('img2')) {
    const requestedResolution = String(resolution || '').trim().toLowerCase();
    if (requestedResolution === '1k' || token.includes('1k')) return 'IMAGE_GPT_1K';
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
    const isNanoBananaPro = isNanoBananaProModelToken(token);
    const requestedResolution = String(resolution || '').trim().toLowerCase();
    if (isNanoBananaPro && (requestedResolution === '1k' || token.includes('1k'))) {
      return 'IMAGE_NANO_BANANA_PRO_1K';
    }
    return 'IMAGE_NANO_BANANA';
  }
  return 'IMAGE';
}

export function providerSupportsImageModel(
  provider: { capabilities: readonly AiCapability[] },
  model: string,
  resolution?: string,
) {
  const capability = imageCapabilityForModel(model, resolution);
  const modelToken = imageModelToken(model);
  const requestedResolution = String(resolution || '').trim().toLowerCase();
  if (provider.capabilities.includes('IMAGE')) return true;
  const modelResolution = modelToken.includes('4k')
    ? '4k'
    : modelToken.includes('2k') ? '2k' : modelToken.includes('1k') ? '1k' : '';
  const hasBananaDual2K = provider.capabilities.includes('IMAGE_NANO_BANANA_DUAL_2K')
    || provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_1K');
  const hasFastBananaPro = provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_FAST')
    && isNanoBananaProModelToken(modelToken);
  const hasFastBanana2 = provider.capabilities.includes('IMAGE_NANO_BANANA_2_FAST');
  if (hasBananaDual2K
    && (!requestedResolution || requestedResolution === '2k')
    && (!modelResolution || modelResolution === '2k')
    && (capability === 'IMAGE_NANO_BANANA' || capability === 'IMAGE_NANO_BANANA_2')) {
    return true;
  }
  if (capability === 'IMAGE_GPT'
    && provider.capabilities.includes('IMAGE_GPT_1K')
    && !resolution
    && !modelToken.includes('2k')
    && !modelToken.includes('4k')) {
    // A generic Image2 model can be listed for a 1K-only channel; the
    // requested resolution is checked again when a generation is started.
    return true;
  }
  if (capability === 'IMAGE_NANO_BANANA' && hasFastBananaPro) return true;
  if (capability === 'IMAGE_NANO_BANANA_2' && hasFastBanana2) return true;
  return provider.capabilities.includes(capability)
    || (capability === 'IMAGE_GPT_1K' && provider.capabilities.includes('IMAGE_GPT'));
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
  clientPlatform?: 'tablet' | undefined;
  provider?: 'new-api' | 'xais-chat' | 'mikoto' | 'bigmodel' | 'uselg' | 'openai-compatible' | 'custom' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  negativePrompt?: string | undefined;
  preserveReferenceIdentity?: boolean | undefined;
  inputImages: string[];
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  resolution?: string | undefined;
  outputFormat: 'jpg' | 'jpeg' | 'png' | 'webp';
  background?: 'transparent' | undefined;
  count: number;
};

class UpstreamImageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly responseValue?: unknown,
  ) {
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
  return providers.filter(providerCanServeImageAlongsideAgent);
}

async function listVideoProviders(prisma: PrismaClient) {
  const providers = await prisma.aiProviderChannel.findMany({
    where: {
      status: 'ACTIVE',
      capabilities: { hasSome: VIDEO_PROVIDER_CAPABILITIES },
    },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
  return providers.filter((provider) => !provider.capabilities.includes('LLM'));
}

/**
 * Bigmodel, Mikoto, and uselg expose separate native image and OpenAI-compatible text
 * routes, so one channel may safely advertise both capabilities. Other
 * providers keep the historical isolation between Agent and image channels.
 */
export function providerCanServeImageAlongsideAgent(
  provider: Pick<AiProviderChannel, 'kind' | 'capabilities'>,
) {
  const hasImageCapability = provider.capabilities.some((capability) => (
    IMAGE_PROVIDER_CAPABILITIES.includes(capability)
  ));
  if (!hasImageCapability) return false;
  return provider.kind === 'BIGMODEL'
    || provider.kind === 'MIKOTO'
    || provider.kind === 'USELG'
    || !provider.capabilities.includes('LLM');
}

function isRetryableNewApiTaskPollError(error: unknown) {
  return error instanceof UpstreamImageError
    && (error.status === 0 || error.status === 429 || error.status >= 500);
}

async function selectImageProviders(
  prisma: PrismaClient,
  providerChannelId: string | undefined,
  requestedModel: string,
  requestedResolution?: string,
  clientPlatform?: ImageInput['clientPlatform'],
) {
  const providers = await listImageProviders(prisma);
  const compatible = providers.filter((candidate) => {
    const model = requestedModel.trim() || candidate.defaultModel?.trim() || '';
    if (clientPlatform === 'tablet'
      && candidate.kind === 'XAIS'
      && imageCapabilityForModel(model, requestedResolution) === 'IMAGE_GPT_1K') {
      return false;
    }
    return model
      ? providerSupportsImageModel(candidate, model, requestedResolution)
      : candidate.capabilities.includes('IMAGE');
  });
  const selected = providerChannelId
    ? providers.find((candidate) => candidate.id === providerChannelId)
    : compatible[0];
  if (!selected) {
    throw new CloudAiError(
      'provider_unavailable',
      providerChannelId ? '所选生图渠道不可用或已被停用' : '当前没有可用的生图渠道',
      503,
    );
  }
  const effectiveModel = requestedModel.trim() || selected.defaultModel?.trim() || '';
  if (effectiveModel && !providerSupportsImageModel(selected, effectiveModel, requestedResolution)) {
    throw new CloudAiError(
      'provider_model_family_mismatch',
      '所选生图模型与该渠道启用的模型家族不匹配',
      400,
    );
  }
  return [selected, ...compatible.filter((candidate) => candidate.id !== selected.id)];
}

export function isImageProviderFailoverStatus(status: number) {
  return status >= 500 && status <= 599;
}

export function isTabletImageProviderFailoverStatus(status: number) {
  return status === 0
    || [401, 403, 404, 408, 409, 425, 429].includes(status)
    || isImageProviderFailoverStatus(status);
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
  hasInputImages = false,
) {
  const requested = requestedModel.trim();
  if (requested) {
    if (provider.kind === 'NEW_API') return resolveNewApiImageModel(requested);
    if (provider.kind === 'BIGMODEL') return resolveBigmodelImageModel(requested);
    if (provider.kind === 'MIKOTO') return resolveMikotoImageModel(requested);
    if (provider.kind === 'USELG') return resolveUselgImageModel(requested, hasInputImages);
    return requested;
  }
  const configured = provider.defaultModel?.trim();
  if (configured) {
    if (provider.kind === 'NEW_API') return resolveNewApiImageModel(configured);
    if (provider.kind === 'BIGMODEL') return resolveBigmodelImageModel(configured);
    if (provider.kind === 'MIKOTO') return resolveMikotoImageModel(configured);
    if (provider.kind === 'USELG') return resolveUselgImageModel(configured, hasInputImages);
    return configured;
  }
  throw new CloudAiError('provider_model_missing', '生图请求和渠道都没有配置模型', 503);
}

function upstreamHeaders(secrets: ProviderSecrets, extraHeaders?: Record<string, string>) {
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${secrets.apiKey}`,
    'content-type': 'application/json',
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  return headers;
}

export function resolveXaisPublicImageModel(model: string, resolution?: string) {
  const trimmed = model.trim();
  const token = imageModelToken(trimmed);
  const suffix = String(resolution || '').trim().toLowerCase() === '4k' ? '4K' : '2K';
  if (isNanoBananaProModelToken(token)) return `Xais Nano Pro_${suffix}`;
  if (token.includes('nanobanana2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')
    || token.includes('xaisnano2')
    || token.includes('nano2')) {
    return `Xais Nano2_${suffix}`;
  }
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) {
    return `Xais Img2_${suffix}`;
  }
  return trimmed;
}

function providerRequestUrl(provider: Pick<AiProviderChannel, 'baseUrl'>, pathOrUrl: string) {
  if (!/^https?:\/\//i.test(pathOrUrl)) return providerEndpoint(provider.baseUrl, pathOrUrl);
  const base = new URL(provider.baseUrl);
  const target = new URL(pathOrUrl);
  if (target.origin !== base.origin) {
    throw new UpstreamImageError(502, 'Upstream task URL changed origin unexpectedly');
  }
  return target.toString();
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
  extraHeaders?: Record<string, string>,
) {
  const controller = new AbortController();
  const timeoutMs = timeoutOverrideMs ?? (/(?:video|workerTask)/i.test(path) ? 10 * 60_000 : 4 * 60_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(providerRequestUrl(provider, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: upstreamHeaders(secrets, extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamImageError(
        response.status,
        upstreamErrorMessage(response.status, text),
        parseProviderValue(text),
      );
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

function publicWalletImageProviderKind(provider: Pick<AiProviderChannel, 'kind'>) {
  // USELG is an internal routing channel. The desktop client only needs the
  // existing OpenAI-compatible protocol hint plus providerChannelId.
  return provider.kind === 'USELG' ? 'NEW_API' as const : provider.kind;
}

export async function listWalletImageModels(
  prisma: PrismaClient,
) {
  const [providers, videoProviders, pricing] = await Promise.all([
    listImageProviders(prisma),
    listVideoProviders(prisma),
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
        ? undefined
        : await providerRequest(provider, secrets, '/v1/models', undefined, 15_000);
      const models = provider.kind === 'BIGMODEL'
        ? bigmodelConfiguredImageModels(provider)
        : provider.kind === 'USELG'
          ? uselgConfiguredImageModels(provider, collectProviderModelIds(value))
          : filterProviderImageModels(provider, collectProviderModelIds(value));
      const defaultModel = provider.defaultModel
        && providerSupportsImageModel(provider, provider.defaultModel)
        ? provider.kind === 'USELG'
          ? resolveUselgImageModel(provider.defaultModel)
          : provider.defaultModel
        : null;
      return {
        id: provider.id,
        name: provider.name,
        provider: publicWalletImageProviderKind(provider),
        defaultModel,
        models,
        capabilities: provider.capabilities,
        error: null,
      };
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        provider: publicWalletImageProviderKind(provider),
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
    videoChannels: videoProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      provider: provider.kind,
      defaultModel: provider.defaultModel,
      // Video model IDs are resolved by the provider-specific request adapter;
      // the client only needs the channel and capability to choose the route.
      models: [],
      capabilities: provider.capabilities,
      error: null,
    })),
    pricing,
  };
}

function bigmodelHeaders(secrets: ProviderSecrets, extraHeaders?: Record<string, string>) {
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  // Bigmodel's native Gemini endpoint uses the Google-style API key header.
  headers.set('x-goog-api-key', secrets.apiKey);
  return headers;
}

async function bigmodelRequest(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
  try {
    const response = await fetch(providerRequestUrl(provider, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: bigmodelHeaders(secrets, extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: controller.signal,
      // Node's default Undici dispatcher stops waiting for response headers
      // after 300 seconds. Gemini image generation can legitimately exceed
      // that, so keep the transport timeout aligned with our 15-minute job
      // deadline without changing fetch behavior for ordinary API calls.
      dispatcher: longImageRequestDispatcher,
    } as RequestInit & { dispatcher: Agent });
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamImageError(
        response.status,
        upstreamErrorMessage(response.status, text),
        parseProviderValue(text),
      );
    }
    return parseProviderValue(text);
  } catch (error) {
    if (error instanceof UpstreamImageError) throw error;
    throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveBigmodelImageModel(model: string) {
  const trimmed = model.trim();
  const token = imageModelToken(trimmed);
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) {
    return 'gpt-image-2';
  }
  if (isNanoBananaProModelToken(token)) {
    return 'gemini-3-pro-image-preview';
  }
  if (token.includes('nanobanana2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')) {
    return 'gemini-3.1-flash-image-preview';
  }
  return trimmed;
}

/** Mikoto exposes Gemini image models through its native Gemini endpoint. */
export function resolveMikotoImageModel(model: string) {
  const trimmed = model.trim();
  const token = imageModelToken(trimmed);
  if (isNanoBananaProModelToken(token)) return 'gemini-3-pro-image-preview';
  if (token.includes('nanobanana2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')) {
    return 'gemini-3.1-flash-image-preview';
  }
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) {
    return 'gpt-image-2';
  }
  return trimmed;
}

export function resolveUselgImageModel(model: string, hasInputImages = false) {
  const trimmed = model.trim();
  const token = imageModelToken(trimmed);
  if (token.includes('grokimagineimage') || token.includes('grokimage')) {
    return hasInputImages ? USELG_GROK_EDIT_MODEL : USELG_GROK_GENERATION_MODEL;
  }
  if (isNanoBananaProModelToken(token)) return 'gemini-3-pro-image-preview';
  if (token.includes('nanobanana2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')) {
    return 'gemini-3.1-flash-image-preview';
  }
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) {
    return 'gpt-image-2';
  }
  return trimmed;
}

function uselgPublicImageModels(models: string[]) {
  const normalized = models
    .filter((model) => imageModelToken(model) !== imageModelToken(USELG_GROK_EDIT_MODEL))
    .map((model) => resolveUselgImageModel(model));
  return Array.from(new Set(normalized));
}

function uselgConfiguredImageModels(
  provider: Pick<AiProviderChannel, 'capabilities' | 'defaultModel'>,
  discoveredModels: string[],
) {
  const models = uselgPublicImageModels(discoveredModels);
  const hasBananaDual2K = provider.capabilities.includes('IMAGE_NANO_BANANA_DUAL_2K')
    || provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_1K');
  if (provider.capabilities.includes('IMAGE_NANO_BANANA') || hasBananaDual2K) {
    models.push('gemini-3-pro-image-preview');
  }
  if (provider.capabilities.includes('IMAGE_NANO_BANANA_2') || hasBananaDual2K) {
    models.push('gemini-3.1-flash-image-preview');
  }
  if (provider.capabilities.includes('IMAGE_GPT')
    || provider.capabilities.includes('IMAGE_GPT_1K')) {
    models.push('gpt-image-2');
  }
  if (provider.capabilities.includes('IMAGE_GROK')) {
    models.push(USELG_GROK_GENERATION_MODEL);
  }
  if (provider.defaultModel?.trim()) {
    models.push(resolveUselgImageModel(provider.defaultModel));
  }
  return filterProviderImageModels(provider, Array.from(new Set(models)));
}

function isNanoBananaProModelToken(token: string) {
  return token.includes('nanobananapro')
    || token.includes('nanopro')
    || token.includes('gemini3proimage');
}

function isBigmodelBananaModel(model: string) {
  const capability = imageCapabilityForModel(resolveBigmodelImageModel(model));
  return capability === 'IMAGE_NANO_BANANA' || capability === 'IMAGE_NANO_BANANA_2';
}

function isMikotoBananaModel(model: string) {
  const capability = imageCapabilityForModel(model);
  return capability === 'IMAGE_NANO_BANANA' || capability === 'IMAGE_NANO_BANANA_2';
}

function isUselgGeminiImageModel(model: string) {
  const capability = imageCapabilityForModel(resolveUselgImageModel(model));
  return capability === 'IMAGE_NANO_BANANA' || capability === 'IMAGE_NANO_BANANA_2';
}

function bigmodelImageSize(resolution?: string) {
  const value = String(resolution || '').trim().toUpperCase();
  return value === '1K' || value === '4K' ? value : '2K';
}

function bigmodelInlineImagePart(source: string) {
  const match = source.trim().match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new CloudAiError('invalid_image_reference', 'Gemini 生图参考图必须是图片 data URI 或公网图片 URL', 400);
  return { inlineData: { mimeType: match[1]!, data: match[2]!.replace(/\s+/g, '') } };
}

export async function generateBigmodelBananaImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const model = resolveBigmodelImageModel(input.model);
  const materialized = await Promise.all(input.inputImages.map(materializeNewApiReferenceImage));
  const parts = [
    { text: promptWithConstraints(input) },
    ...materialized.map(bigmodelInlineImagePart),
  ];
  const images: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    let value: unknown;
    try {
      value = await bigmodelRequest(
        provider,
        secrets,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ role: 'user', parts }],
          generationConfig: model === 'gemini-3-pro-image-preview'
            ? {
              responseModalities: ['IMAGE'],
              responseFormat: {
                image: {
                  aspectRatio: input.aspectRatio,
                  imageSize: bigmodelImageSize(input.resolution),
                },
              },
            }
            : {
              responseModalities: ['IMAGE'],
              imageConfig: {
                aspectRatio: input.aspectRatio,
                imageSize: bigmodelImageSize(input.resolution),
              },
            },
        },
      );
    } catch (error) {
      const recovered = error instanceof UpstreamImageError
        ? selectBigmodelImages(error.responseValue, input.inputImages, 1)
        : [];
      if (!recovered.length) throw error;
      images.push(...recovered);
      continue;
    }
    images.push(...selectBigmodelImages(value, input.inputImages, 1));
  }
  const unique = Array.from(new Set(images)).slice(0, input.count);
  if (!unique.length) throw new Error('Bigmodel Banana Pro 没有返回图片数据');
  return unique;
}

export async function generateMikotoBananaImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  return generateGeminiImageConfigImages(
    provider,
    secrets,
    input,
    resolveMikotoImageModel(input.model),
    'Mikoto Banana',
  );
}

export async function generateUselgGeminiImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  return generateGeminiImageConfigImages(
    provider,
    secrets,
    input,
    resolveUselgImageModel(input.model),
    'uselg Gemini',
    true,
    (started) => resolveUselgImageResponse(
      provider,
      secrets,
      started,
      input.inputImages,
      1,
    ),
    (outputIndex) => uselgImageRequestHeaders(input, outputIndex),
  );
}

async function generateGeminiImageConfigImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
  model: string,
  label: string,
  preferUrlResults = false,
  resolvePendingResponse?: (started: unknown) => Promise<string[]>,
  requestHeaders?: (outputIndex: number) => Record<string, string> | undefined,
) {
  const materialized = await Promise.all(input.inputImages.map(materializeNewApiReferenceImage));
  const parts = [
    { text: promptWithConstraints(input) },
    ...materialized.map(bigmodelInlineImagePart),
  ];
  const images: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    let value: unknown;
    try {
      value = await bigmodelRequest(
        provider,
        secrets,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              imageSize: bigmodelImageSize(input.resolution),
              aspectRatio: input.aspectRatio,
            },
          },
        },
        requestHeaders?.(index),
      );
    } catch (error) {
      const recovered = error instanceof UpstreamImageError
        ? selectUniqueImages(error.responseValue, input.inputImages, 1, preferUrlResults)
        : [];
      if (!recovered.length) throw error;
      images.push(...recovered);
      continue;
    }
    const immediate = selectUniqueImages(value, input.inputImages, 1, preferUrlResults);
    images.push(...(
      immediate.length > 0 || !resolvePendingResponse
        ? immediate
        : await resolvePendingResponse(value)
    ));
  }
  const unique = Array.from(new Set(images)).slice(0, input.count);
  if (!unique.length) throw new Error(`${label} 没有返回图片数据`);
  return unique;
}

export function uniqueImages(value: unknown, inputImages: string[], count: number) {
  return selectUniqueImages(value, inputImages, count, false);
}

export function uniqueImagesPreferUrls(value: unknown, inputImages: string[], count: number) {
  return selectUniqueImages(value, inputImages, count, true);
}

function selectUniqueImages(
  value: unknown,
  inputImages: string[],
  count: number,
  preferUrls: boolean,
) {
  const inputs = new Set(inputImages.map((value) => value.trim()));
  const images = Array.from(new Set(collectImageStrings(value).map((value) => value.trim()).filter(Boolean)))
    .filter((value) => !inputs.has(value));
  if (preferUrls) {
    images.sort((left, right) => Number(!/^https?:\/\//i.test(left)) - Number(!/^https?:\/\//i.test(right)));
  }
  return images.slice(0, count);
}

function selectBigmodelImages(value: unknown, inputImages: string[], count: number) {
  const candidateParts: unknown[] = [];
  const visited = new Set<object>();

  const collectCandidateParts = (nested: unknown) => {
    if (!nested || typeof nested !== 'object' || visited.has(nested)) return;
    visited.add(nested);
    if (Array.isArray(nested)) {
      for (const item of nested) collectCandidateParts(item);
      return;
    }

    const record = nested as Record<string, unknown>;
    if (Array.isArray(record.candidates)) {
      for (const candidate of record.candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const content = (candidate as Record<string, unknown>).content;
        if (!content || typeof content !== 'object') continue;
        const parts = (content as Record<string, unknown>).parts;
        if (Array.isArray(parts)) {
          for (const part of parts as unknown[]) candidateParts.push(part);
        }
      }
    }
    for (const child of Object.values(record)) collectCandidateParts(child);
  };

  collectCandidateParts(value);
  const finalParts = candidateParts.filter((part) => {
    if (!part || typeof part !== 'object') return true;
    const record = part as Record<string, unknown>;
    return record.thought !== true && record.isThought !== true && record.is_thought !== true;
  });
  const finalImages = selectUniqueImages(finalParts, inputImages, count, false);
  return finalImages.length > 0
    ? finalImages
    : selectUniqueImages(value, inputImages, count, false);
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

function bigmodelConfiguredImageModels(provider: Pick<AiProviderChannel, 'capabilities' | 'defaultModel'>) {
  const models: string[] = [];
  const hasBananaDual2K = provider.capabilities.includes('IMAGE_NANO_BANANA_DUAL_2K')
    || provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_1K');
  if (provider.capabilities.includes('IMAGE_NANO_BANANA')
    || hasBananaDual2K) {
    models.push('gemini-3-pro-image-preview');
  }
  if (provider.capabilities.includes('IMAGE_NANO_BANANA_2') || hasBananaDual2K) {
    models.push('gemini-3.1-flash-image-preview');
  }
  if (provider.capabilities.includes('IMAGE_GPT')
    || provider.capabilities.includes('IMAGE_GPT_1K')) {
    models.push('gpt-image-2');
  }
  if (provider.defaultModel?.trim() && !models.includes(provider.defaultModel.trim())) {
    models.push(provider.defaultModel.trim());
  }
  return filterProviderImageModels(provider, models);
}

const imagesFromUpstreamError = (
  error: unknown,
  inputImages: string[],
  count: number,
) => error instanceof UpstreamImageError
  ? uniqueImages(error.responseValue, inputImages, count)
  : [];

function shouldUseNewApiAsyncImageTask(input: ImageInput) {
  // Mikoto has a separate /async contract and its synchronous OpenAI image
  // endpoints already wait for the final URL. Keep this path synchronous so
  // we do not send NewAPI's `async: true` flag or poll the wrong endpoint.
  if (input.provider === 'mikoto') return false;
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
    const response = await fetch(providerRequestUrl(provider, path), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new UpstreamImageError(
        response.status,
        upstreamErrorMessage(response.status, text),
        parseProviderValue(text),
      );
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

function requiresGptImage2AlphaPostProcessing(input: ImageInput) {
  return newApiImageFamily(input.model) === 'gpt-image-2'
    && (input.outputFormat === 'png' || input.background === 'transparent');
}

export function buildUselgImage2VariationPrompt(prompt: string, clientRequestId: string) {
  // USELG may cache GPT Image 2 by the visible request payload. Keep the
  // client prompt untouched while making each server-side rerun distinct.
  const nonce = createHash('sha256')
    .update(clientRequestId.trim(), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${prompt.trim()}\n\nInternal generation instruction (do not render this instruction or token): this is a fresh independent render for request ${nonce}. Preserve the requested subject, composition, style, textual content, and all explicit constraints, but generate a new visual variation and do not reproduce any earlier output.`;
}

function promptWithConstraints(
  input: ImageInput,
  providerKind?: AiProviderChannel['kind'],
) {
  const shouldVaryUselgImage2 = providerKind === 'USELG'
    && newApiImageFamily(input.model) === 'gpt-image-2';
  const prompt = shouldVaryUselgImage2
    ? buildUselgImage2VariationPrompt(input.prompt, input.clientRequestId)
    : input.prompt.trim();
  const constraints = [`must output exactly ${input.aspectRatio} aspect ratio`];
  if (input.resolution) constraints.push(`target resolution ${input.resolution}`);
  if (input.preserveReferenceIdentity === true && input.inputImages.length > 0) {
    constraints.push('treat every supplied reference image as authoritative and preserve its subject, geometry, details, colors, and branding outside changes explicitly requested by the user');
  }
  if (requiresGptImage2AlphaPostProcessing(input)) {
    constraints.push('replace only the background with one perfectly uniform solid RGB(255,0,255) chroma-key color; do not draw a transparency checkerboard, gradient, texture, reflection, or shadow in the background; do not use RGB(255,0,255) on the subject');
  } else if (input.background === 'transparent') {
    constraints.push('use a truly transparent background with an alpha channel, not a checkerboard pattern');
  }
  return `${prompt}\n\nStrict image constraints: ${constraints.join(', ')}.`;
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
  providerKind?: AiProviderChannel['kind'],
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
    prompt: promptWithConstraints(input, providerKind),
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

function nestedStringByKeys(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string {
  if (!value || typeof value !== 'object' || depth > 8) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedStringByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof nested === 'string' && nested.trim()) {
      return nested.trim();
    }
  }
  for (const nested of Object.values(record)) {
    const found = nestedStringByKeys(nested, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function uselgPollAfterMs(value: unknown) {
  if (!value || typeof value !== 'object') return 2_000;
  const record = value as Record<string, unknown>;
  const raw = record.poll_after_ms ?? record.pollAfterMs;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.max(2_000, Math.min(10_000, Math.round(parsed))) : 2_000;
}

function isUselgTaskControlUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    return /\/v1\/images\/tasks\/[^/]+\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

function uniqueUselgImages(value: unknown, inputImages: string[], count: number) {
  const inputs = new Set(inputImages.map((item) => item.trim()).filter(Boolean));
  return Array.from(new Set(collectImageStrings(value).map((item) => item.trim()).filter(Boolean)))
    .filter((source) => !inputs.has(source) && !isUselgTaskControlUrl(source))
    .slice(0, Math.max(1, count));
}

type UselgTaskAsset = { key: 'signed_url' | 'download_url' | 'url'; value: string };

function collectUselgTaskAssets(value: unknown, output: UselgTaskAsset[] = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectUselgTaskAssets(item, output, depth + 1));
    return output;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.assets)) {
    for (const asset of record.assets) {
      if (!asset || typeof asset !== 'object') continue;
      const assetRecord = asset as Record<string, unknown>;
      for (const key of ['signed_url', 'download_url', 'url'] as const) {
        const candidate = assetRecord[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          output.push({ key, value: candidate.trim() });
          break;
        }
      }
    }
  }
  for (const key of ['data', 'result', 'task', 'response']) {
    collectUselgTaskAssets(record[key], output, depth + 1);
  }
  return output;
}

export async function resolveUselgImageResponse(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  started: unknown,
  inputImages: string[],
  count: number,
  wait: (milliseconds: number) => Promise<unknown> = (
    milliseconds,
  ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const immediate = uniqueUselgImages(started, inputImages, count);
  if (immediate.length) return immediate;
  const taskId = getTaskId(started);
  if (!taskId) throw new Error('uselg 没有返回图片数据或 task_id');

  let statusUrl = nestedStringByKeys(started, new Set(['status_url', 'poll_url']))
    || `/v1/images/tasks/${encodeURIComponent(taskId)}?view=summary`;
  let resultUrl = nestedStringByKeys(started, new Set(['result_url']));
  let pollAfterMs = uselgPollAfterMs(started);
  let lastStatus: unknown = started;
  let lastPollError: unknown = null;
  const deadline = Date.now() + IMAGE_GENERATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await wait(pollAfterMs);
    try {
      lastStatus = await providerRequest(provider, secrets, statusUrl, undefined, 45_000);
      lastPollError = null;
    } catch (error) {
      const errorImages = imagesFromUpstreamError(error, inputImages, count);
      if (errorImages.length) return errorImages;
      if (!isRetryableNewApiTaskPollError(error)) throw error;
      lastPollError = error;
      continue;
    }

    statusUrl = nestedStringByKeys(lastStatus, new Set(['status_url', 'poll_url'])) || statusUrl;
    resultUrl = nestedStringByKeys(lastStatus, new Set(['result_url'])) || resultUrl;
    pollAfterMs = uselgPollAfterMs(lastStatus);
    const images = uniqueUselgImages(lastStatus, inputImages, count);
    if (images.length) return images;
    const failure = getFailure(lastStatus);
    if (failure) throw new UpstreamImageError(502, failure, lastStatus);
    const state = newApiImageTaskState(lastStatus);
    if (/^(?:failed|failure|error|cancelled|canceled|uncertain|client_disconnected)$/.test(state)) {
      throw new UpstreamImageError(
        502,
        `uselg 图片任务失败（${state}）：${taskId}`,
        lastStatus,
      );
    }
    if (!/^(?:completed|complete|succeeded|success|finished|done)$/.test(state)) continue;

    const completedStatus = lastStatus;
    if (resultUrl) {
      try {
        const result = await providerRequest(provider, secrets, resultUrl, undefined, 45_000);
        const resultImages = uniqueUselgImages(result, inputImages, count);
        if (resultImages.length) return resultImages;
      } catch (error) {
        const resultImages = imagesFromUpstreamError(error, inputImages, count);
        if (resultImages.length) return resultImages;
      }
    }

    const resolvedAssets: string[] = [];
    for (const asset of collectUselgTaskAssets(completedStatus)) {
      if (asset.key === 'signed_url' && /^https?:\/\//i.test(asset.value)) {
        resolvedAssets.push(asset.value);
      } else {
        const content = await providerImageContentRequest(provider, secrets, asset.value);
        resolvedAssets.push(...uniqueUselgImages(content, inputImages, count));
      }
      if (resolvedAssets.length >= count) break;
    }
    if (resolvedAssets.length) return Array.from(new Set(resolvedAssets)).slice(0, count);
    throw new Error(`uselg 图片任务已成功但没有返回可下载资产：${taskId}`);
  }

  const pollDetail = lastPollError instanceof Error ? `：${lastPollError.message}` : '';
  throw new Error(`uselg 图片任务等待超时：${taskId}${pollDetail}`);
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
  if (provider.kind === 'USELG') {
    return resolveUselgImageResponse(provider, secrets, started, inputImages, count, wait);
  }
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
      const errorImages = imagesFromUpstreamError(error, inputImages, count);
      if (errorImages.length) return errorImages;
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
      let content: unknown;
      try {
        content = await providerImageContentRequest(
          provider,
          secrets,
          `/v1/images/${encodeURIComponent(taskId)}/content`,
        );
      } catch (error) {
        const contentImages = imagesFromUpstreamError(error, inputImages, count);
        if (contentImages.length) return contentImages;
        throw error;
      }
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

async function mirrorPublicGeneratedImageResultToOss(source: string, index: number) {
  const staged = await stagePublicGeneratedImageResult(source, index);
  try {
    if (!staged.path) throw new Error('generated image mirror did not create a temporary file');
    const stableUrl = await createImageResultFromFile(staged.path, staged.mime);
    return uploadStoredImageResultToOss(stableUrl);
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

async function mirrorInlineGeneratedImageResultToOss(source: string) {
  const inline = dataUrlImageBytes(source, MAX_GENERATED_IMAGE_BYTES);
  const stableUrl = await createImageResultFromResponse(new Response(inline.bytes, {
    headers: {
      'content-type': inline.mime,
      'content-length': String(inline.bytes.byteLength),
    },
  }));
  return uploadStoredImageResultToOss(stableUrl);
}

async function mirrorGeneratedImageResultToOss(source: string, index: number) {
  if (isStoredImageResultUrl(source)) return uploadStoredImageResultToOss(source);
  if (/^data:image\//i.test(source.trim())) return mirrorInlineGeneratedImageResultToOss(source);
  return mirrorPublicGeneratedImageResultToOss(source, index);
}

export async function mirrorXaisImageResults(
  images: string[],
  providerName: string,
  mirrorImage: (source: string, index: number) => Promise<string> = mirrorPublicGeneratedImageResultToOss,
) {
  return Promise.all(images.map(async (source, index) => {
    if (!isPublicNewApiImageReference(source) || isStoredImageResultUrl(source)) return source;
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

export async function mirrorGeneratedImageResults(
  images: string[],
  providerName: string,
  mirrorImage: (source: string, index: number) => Promise<string> = mirrorGeneratedImageResultToOss,
) {
  return Promise.all(images.map(async (source, index) => {
    const trimmed = source.trim();
    if (!isStoredImageResultUrl(trimmed)
      && !isPublicNewApiImageReference(trimmed)
      && !/^data:image\//i.test(trimmed)) return source;
    try {
      return await mirrorImage(trimmed, index);
    } catch (error) {
      console.warn('[image_result_mirror_failed]', {
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
  let png: Buffer;
  try {
    png = await convertGptImage2ChromaKeyToTransparentPng(sourceBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/(?:did not return a usable chroma-key background|background conversion produced no transparent pixels)/i.test(message)) {
      throw error;
    }
    // The provider still produced a valid image. Transparency is best-effort:
    // never discard a paid generation just because its background cannot be
    // converted safely to alpha.
    console.warn('[gpt_image_2_transparency_fallback]', { index, error: message });
    return source;
  }
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

function newApiMultipartFileHeader(boundary: string, image: StagedNewApiEditImage) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${image.filename}"\r\nContent-Type: ${image.mime}\r\n\r\n`,
    'utf8',
  );
}

function newApiEditFields(
  input: ImageInput,
  asyncOverride?: boolean,
  providerKind?: AiProviderChannel['kind'],
) {
  const body = buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride, providerKind) as Record<string, unknown>;
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

export function uselgImageRequestHeaders(input: Pick<
  ImageInput,
  'clientRequestId' | 'model' | 'prompt' | 'resolution' | 'aspectRatio' | 'outputFormat' | 'inputImages'
>, outputIndex = 0) {
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({
      clientRequestId: input.clientRequestId.trim(),
      model: input.model.trim(),
      prompt: createHash('sha256').update(input.prompt.trim(), 'utf8').digest('hex'),
      resolution: String(input.resolution || '').trim().toLowerCase(),
      aspectRatio: input.aspectRatio,
      outputFormat: input.outputFormat,
      inputImages: input.inputImages.map((source) => createHash('sha256').update(source, 'utf8').digest('hex')),
      outputIndex,
    }), 'utf8')
    .digest('hex');
  return {
    'Idempotency-Key': requestFingerprint,
    'X-Request-Id': requestFingerprint,
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  };
}

function uselgIdempotencyHeaders(provider: Pick<AiProviderChannel, 'kind'>, input: ImageInput) {
  return provider.kind === 'USELG'
    ? uselgImageRequestHeaders(input)
    : undefined;
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
  const textParts = newApiEditFields(input, asyncOverride, provider.kind).map(([name, value]) => (
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
    const headers = upstreamHeaders(
      secrets,
      uselgIdempotencyHeaders(provider, input),
    );
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
      throw new UpstreamImageError(
        response.status,
        upstreamErrorMessage(response.status, text),
        parseProviderValue(text),
      );
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
  let startError: unknown = null;
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
        if (provider.kind === 'USELG') throw error;
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
            buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride, provider.kind),
            IMAGE_GENERATION_TIMEOUT_MS,
            uselgIdempotencyHeaders(provider, input),
          ),
        );
      }
    } else {
      const startGeneration = (asyncOverride: boolean) => providerRequest(
        provider,
        secrets,
        '/v1/images/generations',
        buildNewApiImageGenerationBody(input, input.inputImages, asyncOverride, provider.kind),
        IMAGE_GENERATION_TIMEOUT_MS,
        uselgIdempotencyHeaders(provider, input),
      );
      started = await requestNewApiImageWithAsyncFallback(preferAsync, startGeneration);
    }
  } catch (error) {
    startError = error;
  } finally {
    await Promise.all(stagedImages.map((image) => image.cleanup().catch(() => {})));
  }
  let images: string[];
  if (startError) {
    images = imagesFromUpstreamError(startError, input.inputImages, input.count);
    if (images.length === 0) {
      throw startError instanceof Error
        ? startError
        : new Error(typeof startError === 'string' ? startError : 'Image generation failed');
    }
  } else try {
    images = await resolveNewApiImageResponse(
      provider,
      secrets,
      started,
      input.inputImages,
      input.count,
    );
  } catch (error) {
    images = imagesFromUpstreamError(error, input.inputImages, input.count);
    if (images.length === 0) throw error;
  }
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

function dataUrlImageBytes(source: string, maximumBytes = MAX_IMAGE_REFERENCE_BYTES) {
  const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('reference image is not a supported data URL');
  const mime = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (!bytes.length || bytes.length > maximumBytes) throw new Error('reference image size is invalid');
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

const VIDEO_FAILURE_STATES = new Set([
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'rejected',
  'aborted',
  'expired',
  'timeout',
  'timed_out',
]);

const normalizeTaskState = (value: unknown) => (
  typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : ''
);

const isFailureTaskState = (state: string) => (
  VIDEO_FAILURE_STATES.has(state)
  || /(?:^|_)(?:failed|failure|error|cancelled|canceled|rejected|aborted|expired|timeout|timed_out)(?:_|$)/.test(state)
);

const VIDEO_TASK_ID_KEYS = [
  'task_id',
  'taskId',
  'taskid',
  'video_generation_id',
  'videoGenerationId',
  'video_id',
  'videoId',
  'job_id',
  'jobId',
  'generation_id',
  'generationId',
] as const;

function directVideoTaskIds(value: Record<string, unknown>) {
  const taskIds = VIDEO_TASK_ID_KEYS
    .map(key => value[key])
    .filter((candidate): candidate is string | number => (
      typeof candidate === 'string' || typeof candidate === 'number'
    ))
    .map(candidate => String(candidate).trim())
    .filter(Boolean);
  const genericId = value.id;
  if (typeof genericId === 'string' || typeof genericId === 'number') {
    const normalized = String(genericId).trim();
    if (normalized) taskIds.push(normalized);
  }
  return Array.from(new Set(taskIds));
}

function hasDirectVideoTaskState(value: Record<string, unknown>) {
  return ['status', 'state', 'task_status', 'taskStatus', 'phase']
    .some(key => typeof value[key] === 'string');
}

function pruneMismatchedVideoTasks(
  value: unknown,
  expectedTaskId: string,
  depth = 0,
): unknown {
  if (!value || typeof value !== 'object' || depth > 10) return value;
  if (Array.isArray(value)) {
    return value
      .map(item => pruneMismatchedVideoTasks(item, expectedTaskId, depth + 1))
      .filter(item => item !== undefined);
  }

  const record = value as Record<string, unknown>;
  const taskIds = VIDEO_TASK_ID_KEYS
    .map(key => record[key])
    .filter((candidate): candidate is string | number => (
      typeof candidate === 'string' || typeof candidate === 'number'
    ))
    .map(candidate => String(candidate).trim())
    .filter(Boolean);
  if (hasDirectVideoTaskState(record)
    && (typeof record.id === 'string' || typeof record.id === 'number')) {
    taskIds.push(String(record.id).trim());
  }
  if (taskIds.length > 0 && !taskIds.includes(expectedTaskId)) return undefined;

  return Object.fromEntries(Object.entries(record).flatMap(([key, nested]) => {
    const scoped = pruneMismatchedVideoTasks(nested, expectedTaskId, depth + 1);
    return scoped === undefined ? [] : [[key, scoped]];
  }));
}

function findVideoTaskPayload(
  value: unknown,
  expectedTaskId: string,
  depth = 0,
): unknown {
  if (!value || typeof value !== 'object' || depth > 10) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = findVideoTaskPayload(item, expectedTaskId, depth + 1);
      if (matched !== undefined) return matched;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  // Prefer the narrowest matching task object over an outer response wrapper.
  // H3 may return current and historical jobs together in one response.
  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== 'object') continue;
    const matched = findVideoTaskPayload(nested, expectedTaskId, depth + 1);
    if (matched !== undefined) return matched;
  }

  return directVideoTaskIds(record).includes(expectedTaskId)
    ? pruneMismatchedVideoTasks(record, expectedTaskId, depth)
    : undefined;
}

/**
 * Select only the H3 task requested by the client. This keeps historical task
 * failures and result URLs from affecting the current task or its OSS mirror.
 */
export function selectVideoTaskPayload(value: unknown, taskId: string): unknown {
  const expectedTaskId = String(taskId || '').trim();
  if (!expectedTaskId) return undefined;
  return findVideoTaskPayload(value, expectedTaskId);
}

/**
 * A newly accepted MiniMax task can be briefly absent from the provider's
 * query response. Keep polling with a task-scoped, media-free placeholder
 * instead of treating historical rows as the current task or failing early.
 */
export function scopeMiniMaxVideoStatusPayload(value: unknown, taskId: string): unknown {
  const expectedTaskId = String(taskId || '').trim();
  if (!expectedTaskId) return undefined;
  return selectVideoTaskPayload(value, expectedTaskId) ?? {
    task_id: expectedTaskId,
    status: 'processing',
  };
}

function getFailure(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 8) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = getFailure(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'error',
    'err',
    'fail_reason',
    'failure_reason',
    'failureReason',
    'error_message',
    'errorMessage',
  ]) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const failure = normalizeXaisFailure(candidate);
      if (failure) return failure;
    } else if (candidate && typeof candidate === 'object') {
      const candidateRecord = candidate as Record<string, unknown>;
      for (const messageKey of ['message', 'msg', 'detail']) {
        const message = candidateRecord[messageKey];
        if (typeof message !== 'string') continue;
        const failure = normalizeXaisFailure(message);
        if (failure) return failure;
      }
      const found = getFailure(candidate, depth + 1);
      if (found) return found;
    }
  }
  const state = normalizeTaskState(
    record.status
      ?? record.state
      ?? record.task_status
      ?? record.taskStatus
      ?? record.phase,
  );
  if (isFailureTaskState(state)) {
    for (const key of ['message', 'msg', 'detail']) {
      const candidate = record[key];
      if (typeof candidate !== 'string') continue;
      const failure = normalizeXaisFailure(candidate);
      if (failure) return failure;
    }
    return state;
  }
  if (record.success === false || record.ok === false) {
    for (const key of ['message', 'msg', 'detail']) {
      const candidate = record[key];
      if (typeof candidate !== 'string') continue;
      const failure = normalizeXaisFailure(candidate);
      if (failure) return failure;
    }
    return 'upstream request failed';
  }
  const numericCode = Number(record.code ?? record.statusCode ?? record.errorCode ?? record.status);
  if (Number.isFinite(numericCode) && numericCode >= 400) {
    for (const key of ['message', 'msg', 'detail']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return `HTTP ${numericCode}`;
  }
  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = key.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (
      normalizedKey === 'data'
      || normalizedKey === 'result'
      || normalizedKey === 'results'
      || normalizedKey === 'task'
      || normalizedKey === 'tasks'
      || normalizedKey === 'response'
      || normalizedKey === 'payload'
      || normalizedKey === 'job'
      || normalizedKey === 'operation'
      || normalizedKey === 'meta'
      || (nested && typeof nested === 'object')
    ) {
      const found = getFailure(nested, depth + 1);
      if (found) return found;
    }
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
  capabilities?: readonly string[],
) {
  const unitCredits = await configuredImageUnitCredits(
    prisma,
    input.model,
    input.resolution,
    capabilities,
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

function effectiveImageInputForProvider(provider: AiProviderChannel, input: ImageInput) {
  if (provider.kind === 'XAIS' && input.inputImages.length > 8) {
    throw new CloudAiError('invalid_request', 'XAIS 生图最多支持 8 张参考图', 400);
  }
  const isImage2OneKOnly = provider.capabilities.includes('IMAGE_GPT_1K')
    && !provider.capabilities.includes('IMAGE_GPT')
    && !provider.capabilities.includes('IMAGE');
  const isBananaDualTwoKOnly = (
    provider.capabilities.includes('IMAGE_NANO_BANANA_DUAL_2K')
      || provider.capabilities.includes('IMAGE_NANO_BANANA_PRO_1K')
  )
    && !provider.capabilities.includes('IMAGE_NANO_BANANA')
    && !provider.capabilities.includes('IMAGE_NANO_BANANA_2')
    && !provider.capabilities.includes('IMAGE');
  return {
    ...input,
    model: input.clientPlatform === 'tablet' && provider.kind === 'XAIS'
      ? resolveXaisPublicImageModel(input.model, input.resolution)
      : resolveImageModel(provider, input.model, input.inputImages.length > 0),
    ...(isImage2OneKOnly && !input.resolution ? { resolution: '1k' } : {}),
    ...(isBananaDualTwoKOnly && !input.resolution ? { resolution: '2k' } : {}),
  };
}

export function splitTabletImageProviderInputs(input: ImageInput): ImageInput[] {
  if (input.clientPlatform !== 'tablet' || input.count <= 1) return [input];
  return Array.from({ length: input.count }, (_, index) => {
    const suffix = `:output:${index + 1}`;
    const requestId = `${input.clientRequestId.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
    return {
      ...input,
      clientRequestId: requestId,
      count: 1,
    };
  });
}

export function boundProviderImageResults(images: string[], count: number) {
  return Array.from(new Set(images)).slice(0, Math.max(0, count));
}

async function generateImagesFromProvider(
  provider: AiProviderChannel,
  effectiveInput: ImageInput,
) {
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const generateBatch = async (input: ImageInput) => provider.kind === 'XAIS'
    ? generateXaisImages(provider, secrets, input)
    : provider.kind === 'BIGMODEL' && isBigmodelBananaModel(input.model)
      ? generateBigmodelBananaImages(provider, secrets, input)
      : provider.kind === 'MIKOTO' && isMikotoBananaModel(input.model)
        ? generateMikotoBananaImages(provider, secrets, input)
        : provider.kind === 'USELG' && isUselgGeminiImageModel(input.model)
          ? generateUselgGeminiImages(provider, secrets, input)
          : generateNewApiImages(provider, secrets, input);
  const providerImages: string[] = [];
  for (const input of splitTabletImageProviderInputs(effectiveInput)) {
    providerImages.push(...await generateBatch(input));
  }
  const boundedProviderImages = boundProviderImageResults(providerImages, effectiveInput.count);
  const images = provider.kind === 'XAIS'
    ? await mirrorXaisImageResults(boundedProviderImages, provider.name)
    : await mirrorGeneratedImageResults(boundedProviderImages, provider.name);
  if (!images.length) throw new Error('渠道没有返回图片数据');
  return images;
}

export async function executeWalletImageGeneration(prisma: PrismaClient, input: ImageInput) {
  const providers = await selectImageProviders(
    prisma,
    input.providerChannelId,
    input.model,
    input.resolution,
    input.clientPlatform,
  );
  const primaryProvider = providers[0]!;
  const reservationInput = effectiveImageInputForProvider(primaryProvider, input);
  await assertPublicProviderUrl(primaryProvider.baseUrl);
  const reservation = await reserveImageCredits(
    prisma,
    reservationInput,
    primaryProvider.capabilities,
  );
  let activeProvider = primaryProvider;
  let activeInput = reservationInput;
  try {
    for (let index = 0; index < providers.length; index += 1) {
      activeProvider = providers[index]!;
      activeInput = index === 0
        ? reservationInput
        : effectiveImageInputForProvider(activeProvider, input);
      if (index > 0) await assertPublicProviderUrl(activeProvider.baseUrl);
      try {
        const images = await generateImagesFromProvider(activeProvider, activeInput);
        const charged = await settleImageCredits(
          prisma,
          activeInput,
          reservation.requestId,
          reservation.estimated,
          reservation.unitCredits,
          images.length,
          {
            images,
            provider: publicWalletImageProviderKind(activeProvider),
            providerChannelId: activeProvider.id,
            providerChannelName: activeProvider.name,
            model: activeInput.model,
          },
        );
        return {
          images,
          provider: publicWalletImageProviderKind(activeProvider),
          providerChannelId: activeProvider.id,
          providerChannelName: activeProvider.name,
          model: activeInput.model,
          chargedCredits: charged.toString(),
        };
      } catch (error) {
        const nextProvider = providers[index + 1];
        const canFailOver = input.clientPlatform === 'tablet'
          ? isTabletImageProviderFailoverStatus(error instanceof UpstreamImageError ? error.status : -1)
          : isImageProviderFailoverStatus(error instanceof UpstreamImageError ? error.status : -1);
        if (!(error instanceof UpstreamImageError)
          || !canFailOver
          || !nextProvider) throw error;
        console.warn('[image_provider_failover]', {
          clientRequestId: input.clientRequestId,
          model: input.model,
          status: error.status,
          fromProviderId: activeProvider.id,
          fromProvider: activeProvider.name,
          toProviderId: nextProvider.id,
          toProvider: nextProvider.name,
        });
      }
    }
    throw new Error('全部生图渠道请求失败');
  } catch (error) {
    await releaseImageCredits(prisma, reservationInput, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    if (error instanceof UpstreamImageError) {
      if (activeProvider.kind === 'NEW_API' && isNewApiParamOverrideCopyError(error)) {
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
  provider?: 'new-api' | 'xais-chat' | 'mikoto' | 'minimax' | undefined;
  providerChannelId?: string | undefined;
  model: string;
  prompt: string;
  inputImages: string[];
  inputVideos: string[];
  inputAudios: string[];
  aspectRatio: string;
  resolution?: string | undefined;
  duration?: number | undefined;
  inputMode?: 'REF' | 'FLF' | undefined;
  count: number;
};

const isSeedance20VideoModel = (model: string) => {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token === 'seedance2'
    || token === 'seedance20'
    || token === 'seedance2fast'
    || token === 'seedance20fast'
    || token === 'sourcemix20'
    || token === 'sourcemix20fast';
};

const isMiniMaxH3VideoModel = (model: string) => (
  model.trim().toLowerCase().replace(/[\s_.-]+/g, '') === 'minimaxh3'
);

const VIDEO_RESULT_KEYS = /^(?:result|results|output|outputs|video|videos|video_url|videoUrl|url|urls|uri|uris|href|download|downloads|file|files)$/i;
const VIDEO_REFERENCE_KEYS = /^(?:image|images|input|inputs|reference|references|referenceImages|referenceVideos|referenceAudios|audio|audios)$/i;

function hasImageResultExtension(value: string) {
  try {
    return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function collectGeneratedVideoStrings(
  value: unknown,
  output: string[] = [],
  trusted = false,
  depth = 0,
): string[] {
  if (!value || depth > 10) return output;
  if (typeof value === 'string') {
    const dataUrls = value.match(/data:video\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+/gi);
    if (dataUrls) output.push(...dataUrls.map(item => item.replace(/\s+/g, '')));
    const urls = value.match(/https?:\/\/[^\s"'<>)}\]]+/gi) || [];
    for (const candidate of urls) {
      const source = candidate.replace(/[.,;，。；]+$/g, '');
      if (!hasImageResultExtension(source)
        && (trusted || /\.(?:avi|m4v|mov|mp4|webm)(?:$|[?#])/i.test(source)
          || /\/v1\/ai\/video-results\/|\/generated-videos\//i.test(source))) {
        output.push(source);
      }
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectGeneratedVideoStrings(
        item,
        output,
        item && typeof item === 'object' ? false : trusted,
        depth + 1,
      );
    }
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (VIDEO_REFERENCE_KEYS.test(key) || /^(?:error|err|message|msg|detail|trace|stack|debug)$/i.test(key)) continue;
    const nestedTrusted = VIDEO_RESULT_KEYS.test(key);
    if (typeof nested === 'string' && /^(?:b64_json|video_base64|base64)$/i.test(key)) {
      output.push(`data:video/mp4;base64,${nested.replace(/^data:video\/[a-zA-Z0-9.+-]+;base64,/i, '')}`);
      continue;
    }
    collectGeneratedVideoStrings(nested, output, nestedTrusted, depth + 1);
  }
  return output;
}

export async function mirrorGeneratedVideoResponse(
  value: unknown,
  providerName: string,
  mirrorVideo: (source: string) => Promise<string> = mirrorGeneratedVideoResultToOss,
  trusted = false,
) {
  const sources = Array.from(new Set(collectGeneratedVideoStrings(value, [], trusted)));
  if (!sources.length) return value;
  const mirrored = await Promise.all(sources.map(async (source, index) => {
    try {
      return await mirrorVideo(source);
    } catch (error) {
      console.warn('[video_result_mirror_failed]', {
        provider: providerName,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      return source;
    }
  }));
  return { walletVideoResults: mirrored, upstream: value };
}

function providerVideoResultMirror(
  provider: Pick<AiProviderChannel, 'baseUrl'>,
  secrets: ProviderSecrets,
  cacheScope?: string,
) {
  const providerOrigin = new URL(provider.baseUrl).origin;
  return (source: string) => {
    if (!/^https?:\/\//i.test(source)) {
      return mirrorGeneratedVideoResultToOss(source, undefined, cacheScope);
    }
    const sourceOrigin = new URL(source).origin;
    return sourceOrigin === providerOrigin
      ? mirrorGeneratedVideoResultToOss(source, upstreamHeaders(secrets), cacheScope)
      : mirrorGeneratedVideoResultToOss(source, undefined, cacheScope);
  };
}

const isKlingVideoModel = (model: string) => /kling/i.test(model.trim());

function videoProviderKind(provider?: VideoInput['provider']) {
  if (provider === 'xais-chat') return 'XAIS' as const;
  if (provider === 'new-api') return 'NEW_API' as const;
  if (provider === 'mikoto') return 'MIKOTO' as const;
  if (provider === 'minimax') return 'MINIMAX' as const;
  return undefined;
}

export async function selectVideoProvider(prisma: PrismaClient, preference?: VideoInput['provider'], providerChannelId?: string) {
  const kind = videoProviderKind(preference);
  const common = { status: 'ACTIVE' as const, capabilities: { hasSome: VIDEO_PROVIDER_CAPABILITIES } };
  if (providerChannelId) {
    const selected = await prisma.aiProviderChannel.findFirst({ where: { ...common, id: providerChannelId, ...(kind ? { kind } : {}) } });
    if (!selected) throw new CloudAiError('provider_unavailable', '所选视频渠道不可用或已被停用', 503);
    await assertPublicProviderUrl(selected.baseUrl);
    return selected;
  }
  const preferred = kind
    ? await prisma.aiProviderChannel.findMany({ where: { ...common, kind }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }] })
    : [];
  if (kind && preferred.length === 0) {
    throw new CloudAiError(
      'provider_unavailable',
      `Video provider ${preference} is unavailable or disabled`,
      503,
    );
  }
  const fallback = preferred.length === 0
    ? await prisma.aiProviderChannel.findMany({ where: common, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }] })
    : [];
  const provider = chooseProviderForCapability(preferred.length ? preferred : fallback, 'VIDEO');
  if (!provider) throw new CloudAiError('provider_unavailable', '当前没有可用的视频渠道', 503);
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
}

function xaisVideoBody(input: VideoInput) {
  const references = [...input.inputImages, ...input.inputVideos, ...input.inputAudios];
  return {
    prompt: input.prompt,
    model: input.model,
    ref: references,
    ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
    custom_field: {
      res: input.resolution || '720p',
      input: isSeedance20VideoModel(input.model) ? 'REF' : input.inputMode || 'REF',
      duration: String(input.duration || 15),
      outputFormat: 'video/mp4',
    },
  };
}

export function resolveMikotoSeedanceModel(model: string, resolution?: string) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  const isFast = token.includes('sourcemix20fast')
    || token.includes('seedance2fast')
    || token.includes('seedance20fast')
    || token.includes('seedancefast');
  const normalizedResolution = String(resolution || '').trim().toLowerCase();
  if (isFast) return normalizedResolution === '480p' ? 'seedance-fast-480p' : 'seedance-fast-720p';
  return normalizedResolution === '1080p' ? 'seedance-2.0-1080p' : 'seedance-2.0-720p';
}

function isMikotoOmniKlingModel(model: string) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token.includes('omni') || token.includes('klingo1');
}

function isMikotoKlingModelForFamily(model: string, omni: boolean) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token.includes('kling') && isMikotoOmniKlingModel(model) === omni;
}

export function resolveMikotoKlingModel(model: string) {
  const trimmed = model.trim();
  const token = trimmed.toLowerCase().replace(/[\s_.-]+/g, '');
  if (token === 'klingomnivideo') return 'kling-o1-text-to-video';
  if (token === 'klingvideo') return 'kling-v2.6-pro-t2v';
  return trimmed;
}

export function resolveMikotoVideoModel(model: string, resolution?: string) {
  return isKlingVideoModel(model)
    ? resolveMikotoKlingModel(model)
    : resolveMikotoSeedanceModel(model, resolution);
}

function isMikotoFastSeedanceModel(model: string) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token.includes('sourcemix20fast')
    || token.includes('seedance2fast')
    || token.includes('seedance20fast')
    || token.includes('seedancefast');
}

function isMikotoSoraV3ProModel(model: string) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token === 'sorav3pro';
}

function isMikotoSeedanceModelForFamily(model: string, fast: boolean) {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  if (!token.includes('seedance') && !token.includes('sourcemix')) return false;
  return isMikotoFastSeedanceModel(model) === fast;
}

/**
 * Mikoto deployments do not all expose the same public model alias. Prefer
 * the channel's configured model when it matches the requested family, then
 * try the resolution-aware aliases used by older deployments and the two
 * canonical Seedance aliases used by newer deployments.
 */
export function mikotoSeedanceModelCandidates(input: VideoInput, configuredModel?: string | null) {
  const fast = isMikotoFastSeedanceModel(input.model);
  const resolution = String(input.resolution || '720p').trim().toLowerCase();
  const referenceCount = (input.inputImages?.length ?? 0)
    + (input.inputVideos?.length ?? 0)
    + (input.inputAudios?.length ?? 0);
  const supportsSoraV3Pro = !fast && resolution === '720p' && referenceCount <= 12;
  const candidates = [
    configuredModel?.trim(),
    resolveMikotoSeedanceModel(input.model, input.resolution),
    fast ? 'seedance-2.0-fast' : 'seedance-2.0',
    fast ? 'seedance2fast' : 'seedance2',
    ...(supportsSoraV3Pro ? ['sora-v3-pro'] : []),
  ].filter((model): model is string => (
    !!model && (
      isMikotoSeedanceModelForFamily(model, fast)
      || (supportsSoraV3Pro && isMikotoSoraV3ProModel(model))
    )
  ));
  return Array.from(new Set(candidates));
}

/**
 * The canvas uses stable public Kling names, while Mikoto exposes versioned
 * upstream model IDs. Prefer an explicitly configured channel model, then the
 * known Mikoto alias, followed by matching IDs reported by /v1/models.
 */
export function mikotoKlingModelCandidates(
  input: VideoInput,
  configuredModel?: string | null,
  discoveredModels: string[] = [],
) {
  const omni = isMikotoOmniKlingModel(input.model);
  const candidates = [
    configuredModel?.trim(),
    resolveMikotoKlingModel(input.model),
    ...discoveredModels.map(model => model.trim()),
    input.model.trim(),
  ].filter((model): model is string => (
    !!model && isMikotoKlingModelForFamily(model, omni)
  ));
  return Array.from(new Set(candidates));
}

function mikotoVideoModel(input: VideoInput, modelOverride?: string) {
  return modelOverride?.trim() || resolveMikotoVideoModel(input.model, input.resolution);
}

export function mikotoSoraV3ProVideoBody(input: VideoInput, model = 'sora-v3-pro') {
  const duration = Math.max(4, Math.min(15, Math.round(Number(input.duration) || 15)));
  const [imageUrl, ...referenceImageUrls] = input.inputImages;
  const referenceMode = input.inputMode === 'FLF'
    ? input.inputImages.length >= 2 ? 'start_end' : 'start_frame'
    : 'auto';
  return {
    model,
    prompt: input.prompt,
    seconds: String(duration),
    aspect_ratio: input.aspectRatio || '16:9',
    resolution: '720p',
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(referenceImageUrls.length ? { reference_image_urls: referenceImageUrls } : {}),
    ...(input.inputVideos.length === 1
      ? { reference_video: input.inputVideos[0] }
      : input.inputVideos.length > 1 ? { reference_videos: input.inputVideos } : {}),
    ...(input.inputAudios.length
      ? { audio_url: input.inputAudios.length === 1 ? input.inputAudios[0] : input.inputAudios }
      : {}),
    video_config: { reference_mode: referenceMode },
  };
}

function mikotoVideoBody(input: VideoInput, modelOverride?: string) {
  const requestedDuration = Math.max(4, Math.min(15, Math.round(Number(input.duration) || 15)));
  const duration = isKlingVideoModel(input.model)
    ? ([5, 10, 15].find(value => value >= requestedDuration) ?? 15)
    : requestedDuration;
  const model = mikotoVideoModel(input, modelOverride);
  if (isMikotoSoraV3ProModel(model)) return mikotoSoraV3ProVideoBody(input, model);
  const hasReferences = input.inputImages.length > 0
    || input.inputVideos.length > 0
    || input.inputAudios.length > 0;
  if (isKlingVideoModel(input.model)) {
    const isOmni = /omni/i.test(input.model);
    const resolution = input.resolution === '1080p' ? '1080p' : '720p';
    const vertical = input.aspectRatio === '9:16';
    const size = resolution === '1080p'
      ? (vertical ? '1080x1920' : '1920x1080')
      : (vertical ? '720x1280' : '1280x720');
    const content = [
      { type: 'text', text: input.prompt },
      ...input.inputImages.map(url => ({
        type: 'image_url',
        image_url: { url, detail: 'high' },
      })),
    ];
    const extraBody = {
      seconds: duration,
      duration,
      aspect_ratio: input.aspectRatio || '16:9',
      aspectRatio: input.aspectRatio || '16:9',
      resolution,
      size,
      reference_mode: isOmni ? 'element' : 'frame',
    };
    return {
      model,
      prompt: input.prompt,
      messages: [{ role: 'user', content: input.inputImages.length ? content : input.prompt }],
      seconds: String(duration),
      duration,
      aspect_ratio: input.aspectRatio || '16:9',
      aspectRatio: input.aspectRatio || '16:9',
      resolution,
      size,
      reference_mode: isOmni ? 'element' : 'frame',
      extra_body: extraBody,
    };
  }
  return {
    model,
    prompt: input.prompt,
    duration,
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.inputImages.length ? { images: input.inputImages } : {}),
    ...(input.inputVideos.length ? { referenceVideos: input.inputVideos } : {}),
    ...(input.inputAudios.length ? { referenceAudios: input.inputAudios } : {}),
    ...(hasReferences ? { reference_mode: input.inputMode === 'FLF' ? 'frame' : 'media' } : {}),
  };
}

export function minimaxVideoBody(input: VideoInput) {
  const isFirstLastFrame = input.inputMode === 'FLF';
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.prompt },
    ...input.inputImages.map((url, index) => ({
      type: 'image_url',
      image_url: { url },
      role: isFirstLastFrame
        ? index === 0 ? 'first_frame' : 'last_frame'
        : 'reference_image',
    })),
    ...input.inputVideos.map((url) => ({
      type: 'video_url',
      video_url: { url },
      role: 'reference_video',
    })),
    ...input.inputAudios.map((url) => ({
      type: 'audio_url',
      audio_url: { url },
      role: 'reference_audio',
    })),
  ];
  const requestedResolution = String(input.resolution || '').trim().toLowerCase();
  // MiniMax H3 accepts only its native 768P/2K labels. Keep the client's
  // Seedance-compatible 480p/720p/1080p controls and translate them here.
  const resolution = requestedResolution === '1080p' || requestedResolution === '2k'
    ? '2K'
    : '768P';
  const ratio = String(input.aspectRatio || 'adaptive').trim() || 'adaptive';
  const duration = Math.max(4, Math.min(15, Math.round(Number(input.duration) || 5)));
  return {
    model: 'MiniMax-H3',
    content,
    resolution,
    duration,
    ratio,
  };
}

function shouldTryMikotoVideoModel(error: unknown) {
  if (error instanceof UpstreamImageError) {
    return [400, 404, 422, 500, 502, 503, 504].includes(error.status);
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '';
  return /(?:503|temporarily unavailable|no available channel|model.+(?:not found|unavailable))/i.test(message);
}

async function reserveVideo(prisma: PrismaClient, input: VideoInput) {
  const estimated = await configuredVideoRequestCredits(
    prisma,
    input.model,
    input.duration,
    input.resolution,
    input.count,
    {
      imageCount: input.inputImages.length,
      videoCount: input.inputVideos.length,
    },
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
  if (isSeedance20VideoModel(input.model)
    && (input.inputImages.length > 9 || input.inputVideos.length > 3 || input.inputAudios.length > 3)) {
    throw new CloudAiError('invalid_request', 'Seedance 2.0 supports 9 images, 3 videos, and 3 audios at most', 400);
  }
  if (isMiniMaxH3VideoModel(input.model)
    && (input.inputImages.length > 9 || input.inputVideos.length > 3 || input.inputAudios.length > 3)) {
    throw new CloudAiError('invalid_request', 'MiniMax H3 supports 9 images, 3 videos, and 3 audios at most', 400);
  }
  const reservation = await reserveVideo(prisma, input);
  try {
    const provider = await selectVideoProvider(prisma, input.provider, input.providerChannelId);
    if (provider.kind === 'MIKOTO' && isKlingVideoModel(input.model)) {
      const maxImages = /omni/i.test(input.model) ? 3 : 2;
      if (input.inputImages.length > maxImages || input.inputVideos.length > 0 || input.inputAudios.length > 0) {
        throw new CloudAiError(
          'invalid_request',
          `Mikoto ${/omni/i.test(input.model) ? 'Kling Omni' : 'Kling'} 最多支持 ${maxImages} 张参考图，且不支持参考视频或参考音频`,
          400,
        );
      }
    }
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    let mikotoVideoModels: string[] = [];
    if (provider.kind === 'MIKOTO' && isKlingVideoModel(input.model)) {
      try {
        const value = await providerRequest(provider, secrets, '/v1/models', undefined, 15_000);
        mikotoVideoModels = collectProviderModelIds(value);
      } catch (error) {
        console.warn('[mikoto_video_models_discovery_failed]', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const results: unknown[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const path = provider.kind === 'XAIS'
        ? '/xais/workerTaskStart'
        : provider.kind === 'MIKOTO' ? '/v1/videos'
          : provider.kind === 'MINIMAX' ? '/api/minimax/v2/video_generation'
          : '/v1/video/generations';
      const mikotoModels = provider.kind === 'MIKOTO'
        ? isSeedance20VideoModel(input.model)
          ? mikotoSeedanceModelCandidates(input, provider.defaultModel)
          : isKlingVideoModel(input.model)
            ? mikotoKlingModelCandidates(input, provider.defaultModel, mikotoVideoModels)
            : []
        : [];
      const modelAttempts = mikotoModels.length > 0 ? mikotoModels : [undefined];
      let result: unknown = null;
      let lastError: unknown = null;
      for (let modelIndex = 0; modelIndex < modelAttempts.length; modelIndex += 1) {
        const modelOverride = modelAttempts[modelIndex];
        const body = provider.kind === 'XAIS' ? xaisVideoBody(input) : provider.kind === 'MIKOTO' ? mikotoVideoBody(input, modelOverride) : provider.kind === 'MINIMAX' ? minimaxVideoBody(input) : {
          model: input.model,
          prompt: input.prompt,
          n: 1,
          ...(input.inputImages.length ? { images: input.inputImages } : {}),
          ...(input.inputVideos.length ? { videos: input.inputVideos } : {}),
          ...(input.inputAudios.length ? { audios: input.inputAudios } : {}),
          ...(isSeedance20VideoModel(input.model)
            ? { ref: [...input.inputImages, ...input.inputVideos, ...input.inputAudios] }
            : {}),
          ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio, ratio: input.aspectRatio } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.duration ? { duration: input.duration } : {}),
        };
        try {
          result = await providerRequest(provider, secrets, path, body);
          const failure = getFailure(result);
          if (failure) {
            lastError = new Error(failure);
            if (provider.kind === 'MIKOTO'
              && (isSeedance20VideoModel(input.model) || isKlingVideoModel(input.model))
              && modelIndex < modelAttempts.length - 1
              && shouldTryMikotoVideoModel(lastError)) {
              continue;
            }
            throw new CloudAiError('video_generation_failed', failure, 502);
          }
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (provider.kind === 'MIKOTO'
            && (isSeedance20VideoModel(input.model) || isKlingVideoModel(input.model))
            && modelIndex < modelAttempts.length - 1
            && shouldTryMikotoVideoModel(error)) {
            continue;
          }
          throw error;
        }
      }
      if (lastError instanceof Error) throw lastError;
      if (lastError) throw new Error('Mikoto video generation failed');
      results.push(await mirrorGeneratedVideoResponse(
        result,
        provider.name,
        provider.kind === 'MIKOTO'
          ? providerVideoResultMirror(provider, secrets)
          : mirrorGeneratedVideoResultToOss,
      ));
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
    : provider.kind === 'MIKOTO'
      ? `/v1/videos/${encodeURIComponent(input.taskId)}`
      : provider.kind === 'MINIMAX'
        ? `/api/minimax/v2/query/video_generation?task_id=${encodeURIComponent(input.taskId)}`
      : `/v1/video/generations/${encodeURIComponent(input.taskId)}`;
  const upstreamStatus = await providerRequest(provider, secrets, path);
  const selectedMiniMaxStatus = provider.kind === 'MINIMAX'
    ? selectVideoTaskPayload(upstreamStatus, input.taskId)
    : undefined;
  if (provider.kind === 'MINIMAX' && selectedMiniMaxStatus === undefined) {
    console.warn('[minimax_video_status_task_mismatch]', {
      provider: provider.name,
      expectedTaskId: input.taskId,
      receivedTaskId: getTaskId(upstreamStatus) || undefined,
    });
  }
  const waited = provider.kind === 'MINIMAX'
    ? scopeMiniMaxVideoStatusPayload(upstreamStatus, input.taskId)
    : upstreamStatus;
  const failure = getFailure(waited);
  if (failure) {
    if (input.clientRequestId) {
      await refundVideoRequest(prisma, input.userId, input.clientRequestId);
    }
    throw new CloudAiError('video_generation_failed', failure, 502);
  }
  if (provider.kind !== 'XAIS') {
    const cacheScope = `${provider.id}:${input.taskId}`;
    const mirrorVideo = provider.kind === 'MIKOTO'
      ? providerVideoResultMirror(provider, secrets, cacheScope)
      : (source: string) => mirrorGeneratedVideoResultToOss(
        source,
        undefined,
        cacheScope,
      );
    return mirrorGeneratedVideoResponse(waited, provider.name, mirrorVideo);
  }
  const attachments = collectAttachmentIds(waited)
    .filter((value) => !/^(?:pending|processing|queued|completed|success|succeeded|failed|failure|error|cancelled|canceled)$/i.test(value));
  if (!attachments.length) return mirrorGeneratedVideoResponse(waited, provider.name);
  const resolved: unknown[] = [];
  for (const attachment of Array.from(new Set(attachments))) {
    resolved.push(await providerRequest(provider, secrets, `/xais/attUrls?att=${encodeURIComponent(attachment)}`));
  }
  return mirrorGeneratedVideoResponse(
    { result: waited, attachments: resolved },
    provider.name,
    mirrorGeneratedVideoResultToOss,
    true,
  );
}

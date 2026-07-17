import type { AiProviderChannel, AiProviderKind, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
import { CloudAiError } from './service.js';

const UNIT_CREDITS = BigInt(env.IMAGE_REQUEST_CREDITS);
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

type ImageInput = {
  userId: string;
  clientRequestId: string;
  provider?: 'new-api' | 'xais-chat' | 'openai-compatible' | 'custom' | undefined;
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

function preferredKind(provider?: ImageInput['provider']): AiProviderKind | undefined {
  if (provider === 'xais-chat') return 'XAIS';
  if (provider === 'new-api') return 'NEW_API';
  return undefined;
}

async function selectImageProvider(prisma: PrismaClient, preference?: ImageInput['provider']) {
  const kind = preferredKind(preference);
  const common = { status: 'ACTIVE' as const, capabilities: { has: 'IMAGE' as const } };
  const provider = await prisma.aiProviderChannel.findFirst({
    where: kind ? { ...common, kind } : common,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });
  if (!provider) {
    throw new CloudAiError(
      'provider_unavailable',
      kind ? `当前没有启用的 ${kind === 'XAIS' ? 'XAIS' : 'NewAPI'} 生图渠道` : '当前没有可用的生图渠道',
      503,
    );
  }
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
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
) {
  const controller = new AbortController();
  const timeoutMs = /(?:video|workerTask)/i.test(path) ? 10 * 60_000 : 4 * 60_000;
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
    if (!response.ok) throw new UpstreamImageError(response.status, `HTTP ${response.status}`);
    return parseProviderValue(text);
  } catch (error) {
    if (error instanceof UpstreamImageError) throw error;
    throw new UpstreamImageError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function collectImageStrings(value: unknown, output: string[] = []): string[] {
  if (!value) return output;
  if (typeof value === 'string') {
    const dataUrls = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g);
    if (dataUrls) output.push(...dataUrls);
    output.push(...Array.from(value.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map((match) => match[1] ?? ''));
    const urls = value.match(/https?:\/\/[^\s"'<>)}\]]+/gi);
    if (urls) output.push(...urls.map((url) => url.replace(/[.,;，。；]+$/g, '')));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageStrings(item, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
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
      collectImageStrings(nested, output);
    }
  }
  return output;
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

function promptWithConstraints(input: ImageInput) {
  const constraints = [`must output exactly ${input.aspectRatio} aspect ratio`];
  if (input.resolution) constraints.push(`target resolution ${input.resolution}`);
  return `${input.prompt.trim()}\n\nStrict image constraints: ${constraints.join(', ')}.`;
}

function chatContent(input: ImageInput) {
  const prompt = promptWithConstraints(input);
  if (!input.inputImages.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...input.inputImages.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

async function generateNewApiImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const body = {
    model: input.model,
    n: input.count,
    size: sizeFromRatio(input.aspectRatio),
    aspect_ratio: input.aspectRatio,
    ratio: input.aspectRatio,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    messages: [{ role: 'user', content: chatContent(input) }],
    stream: false,
    max_tokens: 8192,
  };
  let firstError: unknown = null;
  try {
    const value = await providerRequest(provider, secrets, '/v1/chat/completions', body);
    const images = uniqueImages(value, input.inputImages, input.count);
    if (images.length) return images;
  } catch (error) {
    firstError = error;
    if (error instanceof UpstreamImageError && error.status === 401) throw error;
  }
  try {
    const value = await providerRequest(provider, secrets, '/v1/images/generations', {
      model: input.model,
      prompt: promptWithConstraints(input),
      n: input.count,
      size: sizeFromRatio(input.aspectRatio),
      response_format: 'url',
    });
    const images = uniqueImages(value, input.inputImages, input.count);
    if (images.length) return images;
  } catch (error) {
    if (!firstError) firstError = error;
  }
  if (firstError instanceof Error) throw firstError;
  throw new Error('渠道没有返回图片数据');
}

export function resolveXaisModel(model: string) {
  return XAIS_MODEL_MAP[model.trim()] ?? model.trim();
}

function isXaisWorkerModel(model: string) {
  return Boolean(XAIS_MODEL_MAP[model.trim()]) || /^(?:Nano_Banana|Image2_|Xais_)/i.test(model.trim());
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
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['task_id', 'taskId', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate).trim();
  }
  for (const key of ['data', 'result', 'task', 'response']) {
    const found = getTaskId(record[key]);
    if (found) return found;
  }
  return '';
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
      collectAttachmentIds(nested, output, trusted || /^(result|results|att|atts|attachment|attachments|output|outputs|file|files)$/i.test(key));
    }
  }
  return Array.from(new Set(output));
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runXaisWorkerTask(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  const model = resolveXaisModel(input.model);
  const started = await providerRequest(provider, secrets, '/xais/workerTaskStart', {
    prompt: input.prompt,
    model,
    ratio: input.aspectRatio,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(input.inputImages.length ? { ref: input.inputImages } : {}),
    custom_field: {
      outputFormat: input.outputFormat === 'png' ? 'image/png' : 'image/jpeg',
      ...(!/^Nano_Banana/i.test(model) || /Lite/i.test(model) ? { quality: /高画质|_H$/i.test(input.model) ? 'high' : 'medium' } : {}),
    },
  });
  const immediate = uniqueImages(started, input.inputImages, 1);
  if (immediate.length) return immediate[0]!;
  const startFailure = getFailure(started);
  if (startFailure) throw new Error(startFailure);
  const taskId = getTaskId(started);
  if (!taskId) throw new Error('Xais 没有返回任务 ID');
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    await delay(2_200);
    const waited = await providerRequest(
      provider,
      secrets,
      `/xais/workerTaskWait?json=1&id=${encodeURIComponent(taskId)}`,
    );
    const failure = getFailure(waited);
    if (failure) throw new Error(failure);
    const images = uniqueImages(waited, input.inputImages, 1);
    if (images.length) return images[0]!;
    for (const attachment of collectAttachmentIds(waited)) {
      const resolved = await providerRequest(
        provider,
        secrets,
        `/xais/attUrls?att=${encodeURIComponent(attachment)}`,
      );
      const resolvedImages = uniqueImages(resolved, input.inputImages, 1);
      if (resolvedImages.length) return resolvedImages[0]!;
    }
  }
  throw new Error('Xais 生图任务等待超时');
}

async function generateXaisImages(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  input: ImageInput,
) {
  if (isXaisWorkerModel(input.model)) {
    const results = await Promise.all(Array.from({ length: input.count }, () => (
      runXaisWorkerTask(provider, secrets, input)
    )));
    return Array.from(new Set(results)).slice(0, input.count);
  }
  try {
    const value = await providerRequest(provider, secrets, '/v1/images/generations', {
      model: resolveXaisModel(input.model),
      prompt: promptWithConstraints(input),
      n: input.count,
      size: sizeFromRatio(input.aspectRatio),
      response_format: 'url',
    });
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
  });
  return uniqueImages(value, input.inputImages, input.count);
}

async function reserveImageCredits(prisma: PrismaClient, input: ImageInput) {
  const estimated = UNIT_CREDITS * BigInt(input.count);
  const requestId = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.aiRequest.findUnique({
      where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    });
    if (existing) throw new CloudAiError('duplicate_request', '该生图请求已经提交过', 409);
    const updated = await transaction.wallet.updateMany({
      where: { userId: input.userId, availableCredits: { gte: estimated } },
      data: { availableCredits: { decrement: estimated }, reservedCredits: { increment: estimated } },
    });
    if (updated.count !== 1) throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
    const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
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
  const charged = UNIT_CREDITS * BigInt(generatedCount);
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
  const reservation = await reserveImageCredits(prisma, input);
  try {
    const provider = await selectImageProvider(prisma, input.provider);
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const images = provider.kind === 'XAIS'
      ? await generateXaisImages(provider, secrets, input)
      : await generateNewApiImages(provider, secrets, input);
    if (!images.length) throw new Error('渠道没有返回图片数据');
    const charged = await settleImageCredits(
      prisma,
      input,
      reservation.requestId,
      reservation.estimated,
      images.length,
    );
    return {
      images,
      provider: provider.kind,
      model: input.model,
      chargedCredits: charged.toString(),
    };
  } catch (error) {
    await releaseImageCredits(prisma, input, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    if (error instanceof UpstreamImageError) {
      throw new CloudAiError(
        error.status === 401 ? 'provider_auth_failed' : 'provider_request_failed',
        error.status === 401 ? '生图渠道鉴权失败，请管理员检查渠道密钥' : `生图渠道请求失败${error.status ? `（HTTP ${error.status}）` : ''}`,
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

async function selectVideoProvider(prisma: PrismaClient, preference?: VideoInput['provider']) {
  const kind = videoProviderKind(preference);
  const common = { status: 'ACTIVE' as const, capabilities: { has: 'VIDEO' as const } };
  const preferred = kind
    ? await prisma.aiProviderChannel.findFirst({ where: { ...common, kind }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
    : null;
  const provider = preferred ?? await prisma.aiProviderChannel.findFirst({ where: common, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
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
    const existing = await transaction.aiRequest.findUnique({ where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } } });
    if (existing) throw new CloudAiError('duplicate_request', '该视频请求已经提交过', 409);
    const updated = await transaction.wallet.updateMany({
      where: { userId: input.userId, availableCredits: { gte: estimated } },
      data: { availableCredits: { decrement: estimated }, reservedCredits: { increment: estimated } },
    });
    if (updated.count !== 1) throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
    const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    const request = await transaction.aiRequest.create({ data: { userId: input.userId, clientRequestId: input.clientRequestId, capability: 'VIDEO', logicalModel: input.model, status: 'RESERVED', estimatedCredits: estimated } });
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
    const wallet = await transaction.wallet.update({ where: { userId }, data: { availableCredits: { increment: released }, reservedCredits: { decrement: released } } });
    await transaction.aiRequest.update({ where: { id: requestId }, data: { status: 'FAILED', completedAt: new Date() } });
    await transaction.walletLedger.create({ data: { userId, requestId, type: 'RELEASE', amount: released, balanceAfter: wallet.availableCredits, description: '视频请求失败，释放额度' } });
  });
}

export async function executeWalletVideoGeneration(prisma: PrismaClient, input: VideoInput) {
  const reservation = await reserveVideo(prisma, input);
  try {
    const provider = await selectVideoProvider(prisma, input.provider);
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
      results.push((await providerRequest(provider, secrets, path, body)));
    }
    await settleVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    return { results, provider: provider.kind, model: input.model, chargedCredits: reservation.estimated.toString() };
  } catch (error) {
    await releaseVideo(prisma, input.userId, reservation.requestId, reservation.estimated);
    if (error instanceof CloudAiError) throw error;
    throw new CloudAiError('video_generation_failed', error instanceof Error ? error.message : '视频生成失败', 502);
  }
}

export async function executeWalletVideoStatus(prisma: PrismaClient, input: { provider?: VideoInput['provider']; taskId: string }) {
  const provider = await selectVideoProvider(prisma, input.provider);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const path = provider.kind === 'XAIS'
    ? `/xais/workerTaskWait?json=1&id=${encodeURIComponent(input.taskId)}`
    : `/v1/video/generations/${encodeURIComponent(input.taskId)}`;
  const waited = await providerRequest(provider, secrets, path);
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

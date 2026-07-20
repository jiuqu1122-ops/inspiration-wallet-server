import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';

const REQUEST_CREDITS = BigInt(env.AGENT_REQUEST_CREDITS);

export class CloudAiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CloudAiError';
  }
}

async function listProviders(prisma: PrismaClient) {
  return prisma.aiProviderChannel.findMany({
    where: { status: 'ACTIVE', capabilities: { has: 'LLM' } },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
}

async function selectProvider(prisma: PrismaClient) {
  const provider = (await listProviders(prisma))[0];
  if (!provider) {
    throw new CloudAiError('provider_unavailable', '当前没有可用的 Agent 渠道', 503);
  }
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
}

function upstreamHeaders(apiKey: string, customHeaders: Record<string, string>) {
  const headers = new Headers({
    accept: 'text/event-stream, application/json',
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  for (const [name, value] of Object.entries(customHeaders)) headers.set(name, value);
  return headers;
}

function providerFailureMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = providerFailureMessage(item);
      if (found) return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'err', 'fail_reason', 'failure_reason']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const nested = providerFailureMessage(candidate);
      if (nested) return nested;
    }
  }
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (/^(failed|failure|error|cancelled|canceled)$/.test(status)) {
    return typeof record.message === 'string' && record.message.trim() ? record.message.trim() : status;
  }
  for (const key of ['data', 'result', 'task', 'response']) {
    const found = providerFailureMessage(record[key]);
    if (found) return found;
  }
  return '';
}

async function discoverModel(
  provider: { baseUrl: string; defaultModel: string | null },
  apiKey: string,
  customHeaders: Record<string, string>,
  preferredModel?: string,
  preferProviderDefault = false,
) {
  const configuredModel = resolveConfiguredAgentModel(
    provider,
    preferredModel,
    preferProviderDefault,
  );
  if (configuredModel) return configuredModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(providerEndpoint(provider.baseUrl, '/v1/models'), {
      headers: upstreamHeaders(apiKey, customHeaders),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    const data: unknown = value && typeof value === 'object' && 'data' in value
      ? (value as { data?: unknown }).data
      : null;
    const model: unknown = Array.isArray(data)
      ? (data as unknown[]).find((item: unknown) => (
          item !== null
          && typeof item === 'object'
          && 'id' in item
          && typeof (item as { id?: unknown }).id === 'string'
        ))
      : null;
    const modelId = model
      && typeof model === 'object'
      && 'id' in model
      && typeof (model as { id?: unknown }).id === 'string'
      ? (model as { id: string }).id
      : '';
    if (!modelId) {
      throw new CloudAiError(
        'provider_model_missing',
        '渠道没有配置默认 Agent 模型，也未能自动读取模型',
        503,
      );
    }
    return modelId;
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_AGENT_MODEL_SENTINELS = new Set([
  'unmind-agent',
  'auto',
  'default',
  'recommended',
]);

export function isDefaultAgentModelSentinel(value?: string | null) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return !normalized || DEFAULT_AGENT_MODEL_SENTINELS.has(normalized);
}

export function resolveConfiguredAgentModel(
  provider: { defaultModel: string | null },
  requestedModel?: string | null,
  preferProviderDefault = false,
) {
  const requested = isDefaultAgentModelSentinel(requestedModel)
    ? ''
    : requestedModel?.trim() ?? '';
  const configured = provider.defaultModel?.trim() ?? '';
  return preferProviderDefault
    ? configured || requested || null
    : requested || configured || null;
}

const NON_AGENT_TEXT_MODEL_PATTERN = /(?:^|[-_/.\s])(?:embeddings?|embed|rerank|re-rank|image|images|imagen|img2|flux|sdxl|stable[-_.\s]?diffusion|dall[-_.\s]?e|recraft|ideogram|midjourney|seedream|nano[-_.\s]?banana|hidream|kolors|jimeng|video|sora|veo|kling|seedance|tts|speech|whisper|transcrib(?:e|er)|transcription|moderation)(?:$|[-_/.\s\d])/i;

export function isLikelyAgentTextModel(model: string) {
  const normalized = model.trim();
  if (!normalized) return false;
  if (/^xais\s+(?:nano|img)/i.test(normalized)) return false;
  return !NON_AGENT_TEXT_MODEL_PATTERN.test(normalized);
}

export function buildAgentModelCandidates(
  provider: { defaultModel: string | null },
  requestedModel: string | null | undefined,
  discoveredModels: string[],
  preferProviderDefault = false,
) {
  const requested = isDefaultAgentModelSentinel(requestedModel) ? '' : requestedModel?.trim() ?? '';
  const configured = provider.defaultModel?.trim() ?? '';
  const preferred = preferProviderDefault
    ? [configured, requested]
    : [requested, configured];
  return Array.from(new Set([
    ...preferred,
    ...discoveredModels.filter(isLikelyAgentTextModel),
  ].filter(Boolean)));
}

const AGENT_PROTOCOL_FALLBACK_STATUSES = new Set([400, 401, 403, 404, 405, 422, 429]);

export function isAgentProtocolFallbackStatus(status: number) {
  return AGENT_PROTOCOL_FALLBACK_STATUSES.has(status);
}

export function isAgentProviderFallbackStatus(status: number) {
  return status >= 500 || isAgentProtocolFallbackStatus(status);
}

const AGENT_PROVIDER_RETRY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

export function isAgentProviderRetryStatus(status: number) {
  return AGENT_PROVIDER_RETRY_STATUSES.has(status);
}

export function sanitizeAgentUpstreamDetail(value: string) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:api[_ -]?key|token|authorization|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|access_token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function scalarString(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function upstreamErrorDetail(status: number, text: string) {
  let message = '';
  let code = '';
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const error = record.error && typeof record.error === 'object'
        ? record.error as Record<string, unknown>
        : null;
      message = scalarString(error?.message) || scalarString(record.message)
        || (typeof record.error === 'string' ? record.error.trim() : '');
      code = scalarString(error?.code) || scalarString(error?.type) || scalarString(record.code);
    }
  } catch {
    message = text;
  }
  const safeMessage = sanitizeAgentUpstreamDetail(message);
  const safeCode = code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);
  return [
    `HTTP ${status}`,
    safeCode ? `[${safeCode}]` : '',
    safeMessage ? `：${safeMessage}` : '',
  ].filter(Boolean).join('');
}

type AgentToolCallAccumulator = {
  id: string;
  type: string;
  name: string;
  arguments: string;
};

type AgentChoiceAccumulator = {
  index: number;
  role: string;
  content: string;
  refusal: string;
  toolCalls: Map<number, AgentToolCallAccumulator>;
  finishReason: unknown;
  logprobs?: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function streamedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    const record = objectValue(part);
    return typeof record?.text === 'string' ? record.text : '';
  }).join('');
}

function appendStableFragment(current: string, fragment: unknown) {
  if (typeof fragment !== 'string' || !fragment) return current;
  if (!current) return fragment;
  return current === fragment ? current : `${current}${fragment}`;
}

function mergeStreamedToolCalls(
  accumulator: AgentChoiceAccumulator,
  value: unknown,
) {
  if (!Array.isArray(value)) return;
  for (const [fallbackIndex, item] of value.entries()) {
    const call = objectValue(item);
    if (!call) continue;
    const index = typeof call.index === 'number' ? call.index : fallbackIndex;
    const existing = accumulator.toolCalls.get(index) ?? {
      id: '',
      type: 'function',
      name: '',
      arguments: '',
    };
    const fn = objectValue(call.function);
    existing.id = appendStableFragment(existing.id, call.id);
    existing.type = typeof call.type === 'string' && call.type ? call.type : existing.type;
    existing.name = appendStableFragment(existing.name, fn?.name);
    if (typeof fn?.arguments === 'string') existing.arguments += fn.arguments;
    accumulator.toolCalls.set(index, existing);
  }
}

function mergeStreamedChoice(
  choices: Map<number, AgentChoiceAccumulator>,
  value: unknown,
  fallbackIndex: number,
) {
  const choice = objectValue(value);
  if (!choice) return;
  const index = typeof choice.index === 'number' ? choice.index : fallbackIndex;
  const accumulator: AgentChoiceAccumulator = choices.get(index) ?? {
    index,
    role: 'assistant',
    content: '',
    refusal: '',
    toolCalls: new Map<number, AgentToolCallAccumulator>(),
    finishReason: null,
  };
  const delta = objectValue(choice.delta) ?? objectValue(choice.message);
  if (typeof delta?.role === 'string' && delta.role) accumulator.role = delta.role;
  accumulator.content += streamedText(delta?.content);
  accumulator.refusal += streamedText(delta?.refusal);
  mergeStreamedToolCalls(accumulator, delta?.tool_calls);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    accumulator.finishReason = choice.finish_reason;
  }
  if (choice.logprobs !== undefined) accumulator.logprobs = choice.logprobs;
  choices.set(index, accumulator);
}

export function parseAgentCompletionResponseText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CloudAiError('provider_invalid_response', 'Agent channel returned an empty response', 502);
  }
  const eventPayloads = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (eventPayloads.length === 0) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new CloudAiError('provider_invalid_response', 'Agent channel returned invalid JSON', 502);
    }
  }

  const metadata: Record<string, unknown> = {};
  const choices = new Map<number, AgentChoiceAccumulator>();
  let lastPayload: unknown;
  for (const payload of eventPayloads) {
    if (payload === '[DONE]') break;
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      throw new CloudAiError('provider_invalid_response', 'Agent channel returned an invalid stream event', 502);
    }
    lastPayload = value;
    const record = objectValue(value);
    if (!record) continue;
    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
      if (record[key] !== undefined && record[key] !== null) metadata[key] = record[key];
    }
    if (record.usage !== undefined && record.usage !== null) metadata.usage = record.usage;
    if (Array.isArray(record.choices)) {
      record.choices.forEach((choice, index) => mergeStreamedChoice(choices, choice, index));
    }
  }

  if (choices.size === 0) {
    if (lastPayload !== undefined) return lastPayload;
    throw new CloudAiError('provider_invalid_response', 'Agent channel stream did not contain a result', 502);
  }
  return {
    ...metadata,
    object: 'chat.completion',
    choices: Array.from(choices.values())
      .sort((left, right) => left.index - right.index)
      .map(choice => ({
        index: choice.index,
        message: {
          role: choice.role,
          content: choice.content,
          ...(choice.refusal ? { refusal: choice.refusal } : {}),
          ...(choice.toolCalls.size > 0 ? {
            tool_calls: Array.from(choice.toolCalls.entries())
              .sort(([left], [right]) => left - right)
              .map(([, call]) => ({
                id: call.id,
                type: call.type,
                function: { name: call.name, arguments: call.arguments },
              })),
          } : {}),
        },
        finish_reason: choice.finishReason,
        ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
      })),
  };
}

class AgentUpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'AgentUpstreamHttpError';
  }
}

function agentProviderFailureDetail(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) return error.detail;
  if (error instanceof CloudAiError) return sanitizeAgentUpstreamDetail(error.message) || error.code;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '上游 Agent 请求超时';
    return sanitizeAgentUpstreamDetail(error.message) || error.name;
  }
  return typeof error === 'string'
    ? sanitizeAgentUpstreamDetail(error)
    : '未知通道错误';
}

function canFallbackToNextAgentProvider(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) {
    return isAgentProviderFallbackStatus(error.status);
  }
  if (error instanceof CloudAiError) {
    return [
      'provider_model_missing',
      'provider_request_failed',
      'provider_invalid_response',
    ].includes(error.code);
  }
  return error instanceof Error;
}

function canRetrySingleAgentProvider(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) {
    return isAgentProviderRetryStatus(error.status);
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError');
}

function canTryAlternativeAgentModel(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) {
    return error.status !== 401
      && error.status !== 403
      && (isAgentProviderRetryStatus(error.status) || [400, 404, 405, 422, 429].includes(error.status));
  }
  if (error instanceof CloudAiError) {
    return ['provider_model_missing', 'provider_request_failed', 'provider_invalid_response'].includes(error.code);
  }
  return error instanceof Error;
}

const waitForAgentProviderRetry = () => new Promise(resolve => setTimeout(resolve, 800));

async function requestAgentCompletionFromProvider(
  provider: AiProviderChannel,
  input: {
    messages: unknown[];
    tools?: unknown[] | undefined;
    model?: string | undefined;
  },
  preferProviderDefault = false,
) {
  await assertPublicProviderUrl(provider.baseUrl);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const preferredModel = isDefaultAgentModelSentinel(input.model) ? undefined : input.model;
  const model = await discoverModel(
    provider,
    secrets.apiKey,
    secrets.headers,
    preferredModel,
    preferProviderDefault,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4 * 60_000);
  let response: Response;
  let text: string;
  try {
    response = await fetch(providerEndpoint(provider.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: upstreamHeaders(secrets.apiKey, secrets.headers),
      body: JSON.stringify({
        model,
        messages: input.messages,
        stream: true,
        ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new AgentUpstreamHttpError(
      response.status,
      upstreamErrorDetail(response.status, text),
    );
  }
  let result: unknown;
  try {
    result = parseAgentCompletionResponseText(text);
  } catch {
    throw new CloudAiError('provider_invalid_response', 'Agent 渠道返回格式无效', 502);
  }
  const providerFailure = providerFailureMessage(result);
  if (providerFailure) {
    throw new CloudAiError(
      'provider_request_failed',
      `Agent upstream failed: ${sanitizeAgentUpstreamDetail(providerFailure)}`,
      502,
    );
  }
  return result;
}

async function readProviderModels(
  provider: { baseUrl: string },
  apiKey: string,
  customHeaders: Record<string, string>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(providerEndpoint(provider.baseUrl, '/v1/models'), {
      headers: upstreamHeaders(apiKey, customHeaders),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CloudAiError(
        'provider_request_failed',
        `Agent 模型列表请求失败（HTTP ${response.status}）`,
        502,
      );
    }
    const value: unknown = await response.json();
    const data = value && typeof value === 'object' && 'data' in value
      ? (value as { data?: unknown }).data
      : value;
    return Array.from(new Set((Array.isArray(data) ? data : [])
      .map((item: unknown) => item && typeof item === 'object' && 'id' in item ? (item as { id?: unknown }).id : item)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(id => id.trim())));
  } finally {
    clearTimeout(timeout);
  }
}

export async function listWalletAgentModels(prisma: PrismaClient) {
  const provider = await selectProvider(prisma);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const models = await readProviderModels(provider, secrets.apiKey, secrets.headers);
  return { models, defaultModel: provider.defaultModel?.trim() || models[0] || null };
}

async function reserveCredits(
  prisma: PrismaClient,
  input: { userId: string; clientRequestId: string },
) {
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.aiRequest.findUnique({
      where: {
        userId_clientRequestId: {
          userId: input.userId,
          clientRequestId: input.clientRequestId,
        },
      },
    });
    if (existing) {
      throw new CloudAiError('duplicate_request', '该 Agent 请求已经提交过', 409);
    }
    const updated = await transaction.wallet.updateMany({
      where: { userId: input.userId, availableCredits: { gte: REQUEST_CREDITS } },
      data: {
        availableCredits: { decrement: REQUEST_CREDITS },
        reservedCredits: { increment: REQUEST_CREDITS },
      },
    });
    if (updated.count !== 1) {
      throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
    }
    const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    const request = await transaction.aiRequest.create({
      data: {
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        capability: 'LLM',
        logicalModel: 'unmind-agent',
        status: 'RESERVED',
        estimatedCredits: REQUEST_CREDITS,
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId: input.userId,
        requestId: request.id,
        type: 'RESERVE',
        amount: -REQUEST_CREDITS,
        balanceAfter: wallet.availableCredits,
        description: 'Agent 请求预扣',
      },
    });
    return request.id;
  });
}

async function settleCredits(prisma: PrismaClient, userId: string, requestId: string) {
  await prisma.$transaction(async (transaction) => {
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        reservedCredits: { decrement: REQUEST_CREDITS },
        lifetimeConsumed: { increment: REQUEST_CREDITS },
      },
    });
    await transaction.aiRequest.update({
      where: { id: requestId },
      data: {
        status: 'SUCCEEDED',
        chargedCredits: REQUEST_CREDITS,
        completedAt: new Date(),
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId,
        type: 'CHARGE',
        amount: REQUEST_CREDITS,
        balanceAfter: wallet.availableCredits,
        description: 'Agent 请求结算',
      },
    });
  });
}

async function releaseCredits(prisma: PrismaClient, userId: string, requestId: string) {
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || (request.status !== 'RESERVED' && request.status !== 'PROCESSING')) return;
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        availableCredits: { increment: REQUEST_CREDITS },
        reservedCredits: { decrement: REQUEST_CREDITS },
      },
    });
    await transaction.aiRequest.update({
      where: { id: requestId },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId,
        type: 'RELEASE',
        amount: REQUEST_CREDITS,
        balanceAfter: wallet.availableCredits,
        description: 'Agent 请求失败，释放预扣额度',
      },
    });
  });
}

export async function executeWalletAgentChat(
  prisma: PrismaClient,
  input: {
    userId: string;
    clientRequestId: string;
    messages: unknown[];
    tools?: unknown[] | undefined;
    model?: string | undefined;
  },
) {
  const requestId = await reserveCredits(prisma, input);
  try {
    const providers = await listProviders(prisma);
    if (providers.length === 0) {
      throw new CloudAiError('provider_unavailable', '当前没有可用的 Agent 渠道', 503);
    }
    const failures: string[] = [];
    let result: unknown;
    for (const [index, provider] of providers.entries()) {
      try {
        result = await requestAgentCompletionFromProvider(provider, input, index > 0);
        break;
      } catch (error) {
        let finalError = error;
        let fallbackModel = '';
        if (providers.length === 1 && canTryAlternativeAgentModel(error)) {
          try {
            const secrets = decryptProviderSecrets(provider.encryptedSecrets);
            const models = await readProviderModels(provider, secrets.apiKey, secrets.headers);
            const failedModel = resolveConfiguredAgentModel(provider, input.model, index > 0) || models[0] || '';
            fallbackModel = buildAgentModelCandidates(
              provider,
              input.model,
              models,
              index > 0,
            ).find(model => model !== failedModel) || '';
          } catch {
            fallbackModel = '';
          }
        }
        if (providers.length === 1 && (fallbackModel || canRetrySingleAgentProvider(error))) {
          await waitForAgentProviderRetry();
          try {
            result = await requestAgentCompletionFromProvider(
              provider,
              fallbackModel ? { ...input, model: fallbackModel } : input,
            );
            break;
          } catch (retryError) {
            finalError = retryError;
          }
        }
        const modelDetail = fallbackModel ? `（已自动改用模型 ${fallbackModel}）` : '';
        failures.push(`${provider.name}${modelDetail}：${agentProviderFailureDetail(finalError)}`);
        const hasNextProvider = index + 1 < providers.length;
        if (!hasNextProvider || !canFallbackToNextAgentProvider(finalError)) {
          const lastFailure = failures[failures.length - 1] || '未知通道错误';
          throw new CloudAiError(
            'provider_request_failed',
            providers.length > 1
              ? `全部 Agent 渠道请求失败（已尝试 ${failures.length} 个）；末次错误：${lastFailure}`
              : `Agent 渠道请求失败：${lastFailure}`,
            502,
          );
        }
      }
    }
    if (result === undefined) {
      throw new CloudAiError('provider_request_failed', '全部 Agent 渠道请求失败', 502);
    }
    await settleCredits(prisma, input.userId, requestId);
    return result;
  } catch (error) {
    await releaseCredits(prisma, input.userId, requestId);
    throw error;
  }
}

export async function executeFreeInspirationAnalysis(
  prisma: PrismaClient,
  input: {
    itemId: string;
    imageSource: string;
    userTags?: string[] | undefined;
    userNotes?: string[] | undefined;
    existingProfile?: unknown;
    model?: string | undefined;
  },
) {
  const provider = await selectProvider(prisma);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const model = await discoverModel(provider, secrets.apiKey, secrets.headers, input.model);
  const prompt = `Analyze this saved design inspiration image. Return JSON only with this exact shape:
{"itemId":"${input.itemId}","summary":"","objects":[],"category":"","form":{"silhouette":[],"geometry":[],"proportion":[]},"cmf":{"colors":[],"materials":[],"finishes":[]},"style":[],"interaction":[],"scene":[],"mood":[],"userTags":[],"userNotes":[]}
Explain what it is useful as a design reference for. Keep fields concise. Preserve supplied user tags and notes.
User tags: ${JSON.stringify(input.userTags ?? [])}
User notes: ${JSON.stringify(input.userNotes ?? '')}
Existing profile: ${JSON.stringify(input.existingProfile ?? null)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4 * 60_000);
  let response: Response;
  let text: string;
  try {
    response = await fetch(providerEndpoint(provider.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: upstreamHeaders(secrets.apiKey, secrets.headers),
      body: JSON.stringify({
        model,
        stream: true,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: input.imageSource, detail: 'low' } },
          ],
        }],
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new CloudAiError('provider_request_failed', `灵感自动分析渠道请求失败（HTTP ${response.status}）`, 502);
  }
  let value: unknown;
  try { value = parseAgentCompletionResponseText(text); } catch {
    throw new CloudAiError('provider_invalid_response', '灵感自动分析渠道返回格式无效', 502);
  }
  const content = (value as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => {
        if (!part || typeof part !== 'object' || !('text' in part)) return '';
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      }).join('')
      : '';
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return { profile: JSON.parse(jsonText) as unknown }; } catch {
    throw new CloudAiError('provider_invalid_response', '灵感自动分析未返回有效 JSON', 502);
  }
}

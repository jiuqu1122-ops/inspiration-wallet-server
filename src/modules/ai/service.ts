import type { AiCapability, AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
import { MIN_AI_IMAGE_TAGS, normalizeImageTagAnalysis } from './tag-analysis.js';
import {
  configuredAgentRequestCredits,
  configuredInspirationAnalysisCredits,
} from './pricing.js';
import { extractChatTokenUsage } from './chat-pricing.js';
import { creditDecimal } from '../wallets/credit-amount.js';
import { proxyAgentChatReferenceImages } from './reference-upload-service.js';
import { ensureAiCatalogSeeded } from './catalog-seed.js';
import {
  catalogDelegateAvailable,
  legacyUpstreamModelForCanonical,
  resolveAutomaticChatModel,
  resolveCatalogModel,
} from './model-catalog.js';
import {
  calculateSnapshotCharge,
  capturePricingSnapshot,
  estimateSnapshotCredits,
  toInputJson,
  type ChargeBreakdown,
  type PricingSnapshot,
} from './pricing-center.js';

const REQUEST_CREDITS = BigInt(env.AGENT_REQUEST_CREDITS);

export const getAgentRequestCredits = () => REQUEST_CREDITS;

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

async function listProviders(prisma: PrismaClient, capability: 'LLM' | 'VISION' = 'LLM') {
  return prisma.aiProviderChannel.findMany({
    where: { status: 'ACTIVE', capabilities: { has: capability } },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
}

export function providerSupportsInspirationAnalysis(
  provider: Pick<AiProviderChannel, 'capabilities'>,
) {
  return provider.capabilities.includes('VISION');
}

async function listInspirationProviders(prisma: PrismaClient) {
  const visionProviders = (await listProviders(prisma, 'VISION'))
    .filter(providerSupportsInspirationAnalysis);
  // Existing installations only have LLM channels. Keep them working until a
  // dedicated visual channel is configured in the manager. USELG is excluded
  // from this legacy fallback so its independent LLM and Vision checkboxes keep
  // their intended meaning.
  if (visionProviders.length > 0) return visionProviders;
  return (await listProviders(prisma)).filter(provider => (
    provider.kind !== 'USELG'
  ));
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
  if (configuredModel && isLikelyAgentTextModel(configuredModel)) return configuredModel;
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
          && isLikelyAgentTextModel((item as { id: string }).id)
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
        '渠道没有配置可用于 Agent 的文本模型，也未能自动读取模型',
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
  // An explicit client selection is authoritative on every channel. Provider
  // defaults are only used for automatic requests.
  if (preferProviderDefault && !requested) return configured || null;
  return requested || configured || null;
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
) {
  const requested = isDefaultAgentModelSentinel(requestedModel) ? '' : requestedModel?.trim() ?? '';
  if (requested) return [requested];

  const configured = provider.defaultModel?.trim() ?? '';
  const discovered = Array.from(new Set(discoveredModels.filter(isLikelyAgentTextModel)));
  const numericParts = (model: string) => (
    (model.match(/\d+(?:\.\d+)*/)?.[0] || '')
      .split('.')
      .filter(Boolean)
      .map(part => Number(part))
  );
  const sorted = discovered
    .map((model, index) => ({ model, index, numericParts: numericParts(model) }))
    .sort((left, right) => {
      const length = Math.max(left.numericParts.length, right.numericParts.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (right.numericParts[index] || 0) - (left.numericParts[index] || 0);
        if (difference !== 0) return difference;
      }
      return left.index - right.index;
    })
    .map(item => item.model);
  return sorted.length > 0 ? sorted : [configured].filter(Boolean);
}

export function buildSingleProviderAgentRetryModels(
  provider: { defaultModel: string | null },
  requestedModel: string | null | undefined,
  discoveredModels: string[],
  failedModel: string,
  retryFailedModel: boolean,
) {
  const alternatives = buildAgentModelCandidates(
    provider,
    requestedModel,
    discoveredModels,
  ).filter(model => model !== failedModel);
  return Array.from(new Set([
    ...(retryFailedModel && failedModel ? [failedModel] : []),
    ...alternatives,
  ]));
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
  reasoningContent: string;
  refusal: string;
  toolCalls: Map<number, AgentToolCallAccumulator>;
  finishReason: unknown;
  logprobs?: unknown;
};

export type AgentExecutionProgress = {
  stage: string;
  progress: number;
  provider?: string;
  model?: string;
  attempt?: number;
  durationMs?: number;
  firstChunkMs?: number;
  upstreamStatus?: number;
};

export type AgentExecutionOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: AgentExecutionProgress) => void | Promise<void>;
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
    reasoningContent: '',
    refusal: '',
    toolCalls: new Map<number, AgentToolCallAccumulator>(),
    finishReason: null,
  };
  const delta = objectValue(choice.delta) ?? objectValue(choice.message);
  if (typeof delta?.role === 'string' && delta.role) accumulator.role = delta.role;
  accumulator.content += streamedText(delta?.content);
  accumulator.reasoningContent += streamedText(delta?.reasoning_content);
  accumulator.refusal += streamedText(delta?.refusal);
  mergeStreamedToolCalls(accumulator, delta?.tool_calls);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    accumulator.finishReason = choice.finish_reason;
  }
  if (choice.logprobs !== undefined) accumulator.logprobs = choice.logprobs;
  choices.set(index, accumulator);
}

function buildAgentCompletionResult(
  metadata: Record<string, unknown>,
  choices: Map<number, AgentChoiceAccumulator>,
  lastPayload: unknown,
) {
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
          ...(choice.reasoningContent ? { reasoning_content: choice.reasoningContent } : {}),
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

export class AgentCompletionSseParser {
  private buffer = '';
  private readonly metadata: Record<string, unknown> = {};
  private readonly choices = new Map<number, AgentChoiceAccumulator>();
  private lastPayload: unknown;
  private sawEvent = false;
  private done = false;

  push(chunk: string) {
    if (this.done || !chunk) return;
    this.buffer += chunk;
    let boundary = this.buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0 && !this.done) {
      const event = this.buffer.slice(0, boundary);
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      this.buffer = this.buffer.slice(boundary + separator.length);
      this.consumeEvent(event);
      boundary = this.buffer.search(/\r?\n\r?\n/);
    }
    if (!this.done && /^\s*data\s*:\s*\[DONE\]\s*$/i.test(this.buffer)) {
      this.consumeEvent(this.buffer);
      this.buffer = '';
    }
  }

  isDone() {
    return this.done;
  }

  finish() {
    if (this.buffer.trim()) this.consumeEvent(this.buffer);
    this.buffer = '';
    if (!this.sawEvent) {
      throw new CloudAiError('provider_invalid_response', 'Agent channel stream did not contain an event', 502);
    }
    const hasFinishReason = Array.from(this.choices.values())
      .some(choice => choice.finishReason !== null && choice.finishReason !== undefined);
    if (!this.done && this.choices.size > 0 && !hasFinishReason) {
      throw new CloudAiError('provider_stream_interrupted', 'Agent channel stream ended unexpectedly', 502);
    }
    return buildAgentCompletionResult(this.metadata, this.choices, this.lastPayload);
  }

  private consumeEvent(event: string) {
    const data = event
      .split(/\r?\n/)
      .filter(line => !line.startsWith(':'))
      .filter(line => /^data(?::|$)/.test(line))
      .map(line => line.startsWith('data:') ? line.slice(5).trimStart() : '')
      .join('\n')
      .trim();
    if (!data) return;
    this.sawEvent = true;
    if (data === '[DONE]') {
      this.done = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      throw new CloudAiError('provider_invalid_response', 'Agent channel returned an invalid stream event', 502);
    }
    this.lastPayload = value;
    const record = objectValue(value);
    if (!record) return;
    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
      if (record[key] !== undefined && record[key] !== null) this.metadata[key] = record[key];
    }
    if (record.usage !== undefined && record.usage !== null) this.metadata.usage = record.usage;
    if (Array.isArray(record.choices)) {
      record.choices.forEach((choice, index) => mergeStreamedChoice(this.choices, choice, index));
    }
  }
}

export function looksLikeAgentSsePayload(value: string) {
  const firstLine = value
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find(line => line.trim().length > 0);
  return !!firstLine && /^\s*(?::|(?:data|event|id|retry)\s*:)/i.test(firstLine);
}

export class AgentCompletionResponseAccumulator {
  private parser: AgentCompletionSseParser | null;
  private buffered = '';

  constructor(contentType = '') {
    this.parser = contentType.toLowerCase().includes('text/event-stream')
      ? new AgentCompletionSseParser()
      : null;
  }

  push(chunk: string) {
    if (!chunk || this.parser?.isDone()) return;
    if (this.parser) {
      this.parser.push(chunk);
      return;
    }
    this.buffered += chunk;
    if (!looksLikeAgentSsePayload(this.buffered)) return;
    this.parser = new AgentCompletionSseParser();
    this.parser.push(this.buffered);
    this.buffered = '';
  }

  isDone() {
    return this.parser?.isDone() ?? false;
  }

  finish() {
    return this.parser
      ? this.parser.finish()
      : parseAgentCompletionResponseText(this.buffered);
  }
}

export function parseAgentCompletionResponseText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CloudAiError('provider_invalid_response', 'Agent channel returned an empty response', 502);
  }
  if (!/^\s*(?:data(?::|$)|:)/m.test(text)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new CloudAiError('provider_invalid_response', 'Agent channel returned invalid JSON', 502);
    }
  }
  const parser = new AgentCompletionSseParser();
  parser.push(text);
  return parser.finish();
}

function analysisResponseContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      const partRecord = objectValue(part);
      if (!partRecord) return '';
      if (typeof partRecord.text === 'string') return partRecord.text;
      if (partRecord.json && typeof partRecord.json === 'object') {
        return JSON.stringify(partRecord.json);
      }
      return '';
    }).join('');
  }
  return value && typeof value === 'object' ? JSON.stringify(value) : '';
}

function jsonObjectTextCandidates(text: string) {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!normalized) return [];
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(normalized.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return Array.from(new Set([normalized, ...objects.reverse()]));
}

export function parseImageAnalysisResponsePayloads(value: unknown) {
  const root = objectValue(value);
  const choice = Array.isArray(root?.choices) ? objectValue(root.choices[0]) : null;
  const message = objectValue(choice?.message);
  const response = objectValue(root?.response);
  const texts = [
    analysisResponseContentText(message?.content),
    analysisResponseContentText(message?.reasoning_content),
    analysisResponseContentText(choice?.text),
    analysisResponseContentText(root?.output_text),
    analysisResponseContentText(response?.output_text),
    root && ('tags' in root || 'cmf' in root || 'form' in root) ? JSON.stringify(root) : '',
  ].filter(Boolean);
  const payloads: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const candidate of jsonObjectTextCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const parsedRecord = objectValue(parsed);
        if (!parsedRecord) continue;
        const key = JSON.stringify(parsedRecord);
        if (seen.has(key)) continue;
        seen.add(key);
        payloads.push(parsedRecord);
      } catch {
        // A compatible JSON object may still appear later in the same text.
      }
    }
  }
  return payloads;
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
      'provider_stream_interrupted',
    ].includes(error.code);
  }
  return error instanceof Error;
}

function canRetrySingleAgentProvider(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) {
    return isAgentProviderRetryStatus(error.status);
  }
  if (error instanceof CloudAiError) return error.code === 'provider_stream_interrupted';
  return error instanceof Error && (
    error.name === 'AbortError'
    || error.name === 'TypeError'
    || 'code' in error && ['UPSTREAM_IDLE_TIMEOUT', 'ECONNRESET'].includes(String(error.code))
  );
}

function canTryAlternativeAgentModel(error: unknown) {
  if (error instanceof AgentUpstreamHttpError) {
    return error.status !== 401
      && error.status !== 403
      && isAgentProviderFallbackStatus(error.status);
  }
  if (error instanceof CloudAiError) {
    return [
      'provider_model_missing',
      'provider_request_failed',
      'provider_invalid_response',
      'provider_stream_interrupted',
    ].includes(error.code);
  }
  return error instanceof Error;
}

function waitForAgentProviderRetry(attempt: number, signal?: AbortSignal) {
  const base = [1_000, 2_500, 5_500][Math.min(attempt, 2)] ?? 5_500;
  const delay = base + Math.round(Math.random() * Math.max(250, base * 0.2));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Task cancelled'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function emitAgentProgress(
  options: AgentExecutionOptions | undefined,
  progress: AgentExecutionProgress,
) {
  await options?.onProgress?.(progress);
}

function linkedAbortController(signal?: AbortSignal) {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
) {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('上游 Agent 流长时间没有返回数据'), {
        name: 'AbortError',
        code: 'UPSTREAM_IDLE_TIMEOUT',
      });
      controller.abort(error);
      reject(error);
    }, env.AI_UPSTREAM_IDLE_TIMEOUT_MS);
    reader.read().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export const AGENT_STREAM_CLOSE_GRACE_MS = 2_000;

// Give successful SSE responses time to reach EOF. Cancelling immediately after
// [DONE] makes upstream gateways record an otherwise successful request as client_gone.
export async function drainAgentCompletionStreamAfterDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  graceMs = AGENT_STREAM_CLOSE_GRACE_MS,
): Promise<'eof' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, graceMs));
  });

  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then(
          value => ({ kind: 'read' as const, value }),
          () => ({ kind: 'read-error' as const }),
        ),
        graceExpired,
      ]);
      if (next.kind === 'timeout') {
        await reader.cancel(new Error('Agent stream did not close after [DONE]')).catch(() => undefined);
        return 'timeout';
      }
      if (next.kind === 'read-error') return 'timeout';
      if (next.value.done) return 'eof';
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requestStreamingCompletion(
  provider: AiProviderChannel,
  model: string,
  body: Record<string, unknown>,
  options: AgentExecutionOptions | undefined,
  attempt: number,
) {
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const controller = linkedAbortController(options?.signal);
  const startedAt = Date.now();
  const connectTimeout = setTimeout(() => {
    controller.abort(Object.assign(new Error('上游 Agent 连接超时'), { name: 'AbortError' }));
  }, env.AI_UPSTREAM_CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    await emitAgentProgress(options, {
      stage: 'connecting',
      progress: 12,
      provider: provider.name,
      model,
      attempt,
    });
    // Bigmodel/Mikoto/USELG use the OpenAI-compatible text route here. Their
    // native image protocols are isolated in image-service.ts and never share
    // this body.
    const endpoint = providerEndpoint(provider.baseUrl, '/v1/chat/completions');
    const send = (includeUsage: boolean) => fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders(secrets.apiKey, secrets.headers),
      body: JSON.stringify({
        ...body,
        model,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    response = await send(true);
    // Some older OpenAI-compatible gateways reject stream_options entirely.
    // A rejected 400/422 request has not generated output, so retrying once
    // without this optional field preserves compatibility; billing then uses
    // the configured fixed fallback if the gateway omits usage.
    if (response.status === 400 || response.status === 422) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(false);
    }
  } finally {
    clearTimeout(connectTimeout);
  }

  if (!response.ok) {
    const errorBodyTimeout = setTimeout(() => {
      controller.abort(Object.assign(new Error('读取上游错误响应超时'), { name: 'AbortError' }));
    }, Math.min(10_000, env.AI_UPSTREAM_IDLE_TIMEOUT_MS));
    let text: string;
    try {
      text = await response.text();
    } finally {
      clearTimeout(errorBodyTimeout);
    }
    await emitAgentProgress(options, {
      stage: 'upstream_error',
      progress: 10,
      provider: provider.name,
      model,
      attempt,
      durationMs: Date.now() - startedAt,
      upstreamStatus: response.status,
    });
    throw new AgentUpstreamHttpError(
      response.status,
      upstreamErrorDetail(response.status, text),
    );
  }
  if (!response.body) {
    throw new CloudAiError('provider_invalid_response', 'Agent channel returned an empty body', 502);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator = new AgentCompletionResponseAccumulator(contentType);
  let firstChunkMs: number | undefined;
  let lastProgressAt = 0;
  let byteCount = 0;
  while (true) {
    const chunk = await readChunkWithIdleTimeout(reader, controller);
    if (chunk.done) break;
    if (!chunk.value?.byteLength) continue;
    byteCount += chunk.value.byteLength;
    const decoded = decoder.decode(chunk.value, { stream: true });
    accumulator.push(decoded);
    const now = Date.now();
    if (firstChunkMs === undefined) {
      firstChunkMs = now - startedAt;
      await emitAgentProgress(options, {
        stage: 'generating',
        progress: 25,
        provider: provider.name,
        model,
        attempt,
        firstChunkMs,
        upstreamStatus: response.status,
      });
      lastProgressAt = now;
    } else if (now - lastProgressAt >= 5_000) {
      await emitAgentProgress(options, {
        stage: 'generating',
        progress: Math.min(85, 25 + Math.floor((now - startedAt) / 5_000) * 3),
        provider: provider.name,
        model,
        attempt,
        durationMs: now - startedAt,
        firstChunkMs,
        upstreamStatus: response.status,
      });
      lastProgressAt = now;
    }
    if (accumulator.isDone()) {
      await drainAgentCompletionStreamAfterDone(reader);
      break;
    }
  }
  const tail = decoder.decode();
  accumulator.push(tail);
  const result = accumulator.finish();
  await emitAgentProgress(options, {
    stage: 'aggregating',
    progress: 90,
    provider: provider.name,
    model,
    attempt,
    durationMs: Date.now() - startedAt,
    ...(firstChunkMs !== undefined ? { firstChunkMs } : {}),
    upstreamStatus: response.status,
  });
  return { result, model, byteCount };
}

export function buildAgentProviderRequestBody(input: {
  messages: unknown[];
  tools?: unknown[] | undefined;
  toolChoice?: unknown;
}) {
  return {
    messages: input.messages,
    ...(input.tools?.length
      ? {
          tools: input.tools,
          tool_choice: input.toolChoice ?? 'auto',
        }
      : {}),
  };
}

async function requestAgentCompletionFromProvider(
  provider: AiProviderChannel,
  input: {
    messages: unknown[];
    tools?: unknown[] | undefined;
    toolChoice?: unknown;
    model?: string | undefined;
  },
  preferProviderDefault = false,
  options?: AgentExecutionOptions,
  attempt = 1,
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
  const { result } = await requestStreamingCompletion(
    provider,
    model,
    buildAgentProviderRequestBody(input),
    options,
    attempt,
  );
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
  if (catalogDelegateAvailable(prisma)) {
    await ensureAiCatalogSeeded(prisma);
    const models = await prisma.aiModel.findMany({
      where: { modality: 'chat', enabled: true, visible: true, status: 'PUBLISHED' },
      orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
      select: { canonicalModelKey: true },
    });
    return {
      models: models.map(model => model.canonicalModelKey),
      defaultModel: models[0]?.canonicalModelKey ?? null,
    };
  }
  const provider = await selectProvider(prisma);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const models = (await readProviderModels(provider, secrets.apiKey, secrets.headers))
    .filter(isLikelyAgentTextModel);
  const configuredModel = provider.defaultModel?.trim() ?? '';
  return {
    models,
    defaultModel: isLikelyAgentTextModel(configuredModel) ? configuredModel : models[0] || null,
  };
}

async function reserveCredits(
  prisma: PrismaClient,
  input: {
    userId: string;
    clientRequestId: string;
    credits: bigint | string;
    capability: AiCapability;
    logicalModel: string;
    description: string;
    pricingSnapshot?: PricingSnapshot | undefined;
  },
) {
  const credits = creditDecimal(input.credits);
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
      where: { userId: input.userId, availableCredits: { gte: credits } },
      data: {
        availableCredits: { decrement: credits },
        reservedCredits: { increment: credits },
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
        capability: input.capability,
        logicalModel: input.logicalModel,
        ...(input.pricingSnapshot ? {
          canonicalModelId: input.pricingSnapshot.canonicalModelId,
          routeId: input.pricingSnapshot.routeId,
          priceVersionId: input.pricingSnapshot.priceVersionId,
          pricingSnapshot: toInputJson(input.pricingSnapshot),
        } : {}),
        status: 'RESERVED',
        estimatedCredits: credits,
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId: input.userId,
        requestId: request.id,
        type: 'RESERVE',
        amount: credits.negated(),
        balanceAfter: wallet.availableCredits,
        description: input.description,
      },
    });
    return request.id;
  });
}

type CreditSettlement = {
  chargedCredits: string;
  logicalModel?: string | undefined;
  billingResult?: ChargeBreakdown | undefined;
  actualRouteId?: string | null | undefined;
  description?: string | undefined;
};

async function settleCredits(
  prisma: PrismaClient,
  userId: string,
  requestId: string,
  settlement?: CreditSettlement,
) {
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findFirst({
      where: { id: requestId, userId, status: { in: ['RESERVED', 'PROCESSING'] } },
    });
    if (!request) return;
    const reserved = creditDecimal(request.estimatedCredits);
    const charged = creditDecimal(settlement?.chargedCredits ?? reserved);
    const release = reserved.gt(charged) ? reserved.minus(charged) : creditDecimal(0);
    const extra = charged.gt(reserved) ? charged.minus(reserved) : creditDecimal(0);
    const requestUpdate: Prisma.AiRequestUpdateManyMutationInput = {
      status: 'SUCCEEDED',
      chargedCredits: charged,
      completedAt: new Date(),
      ...(settlement?.logicalModel ? { logicalModel: settlement.logicalModel } : {}),
      ...(settlement?.actualRouteId !== undefined ? { routeId: settlement.actualRouteId } : {}),
      ...(settlement?.billingResult
        ? { result: toInputJson(settlement.billingResult), chargeBreakdown: toInputJson(settlement.billingResult) }
        : {}),
    };
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: requestId, userId, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: requestUpdate,
    });
    if (claimed.count !== 1) return;
    if (settlement?.billingResult && catalogDelegateAvailable(prisma)) {
      await transaction.aiBillingSettlement.create({
        data: {
          requestId,
          canonicalModelId: request.canonicalModelId,
          routeId: settlement.actualRouteId ?? request.routeId,
          priceVersionId: request.priceVersionId,
          chargedCredits: charged,
          breakdown: toInputJson(settlement.billingResult),
        },
      });
    }
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        reservedCredits: { decrement: reserved },
        ...(release.gt(0) ? { availableCredits: { increment: release } } : {}),
        ...(extra.gt(0) ? { availableCredits: { decrement: extra } } : {}),
        lifetimeConsumed: { increment: charged },
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId,
        type: 'CHARGE',
        amount: charged,
        balanceAfter: wallet.availableCredits,
        description: settlement?.description
          ?? (request.capability === 'VISION' ? '图片分析结算' : 'Agent 请求结算'),
      },
    });
    if (release.gt(0)) {
      await transaction.walletLedger.create({
        data: {
          userId,
          requestId,
          type: 'RELEASE',
          amount: release,
          balanceAfter: wallet.availableCredits,
          description: 'Chat Token 结算，释放多余预扣额度',
        },
      });
    }
  });
}

async function releaseCredits(prisma: PrismaClient, userId: string, requestId: string) {
  await prisma.$transaction(async (transaction) => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || (request.status !== 'RESERVED' && request.status !== 'PROCESSING')) return;
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: requestId, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const credits = request.estimatedCredits;
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        availableCredits: { increment: credits },
        reservedCredits: { decrement: credits },
      },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        requestId,
        type: 'RELEASE',
        amount: credits,
        balanceAfter: wallet.availableCredits,
        description: request.capability === 'VISION'
          ? '图片分析失败，释放预扣额度'
          : 'Agent 请求失败，释放预扣额度',
      },
    });
  });
}

export async function releaseRequestCreditsForClientRequest(
  prisma: PrismaClient,
  userId: string,
  clientRequestId: string,
) {
  const request = await prisma.aiRequest.findUnique({
    where: { userId_clientRequestId: { userId, clientRequestId } },
    select: { id: true },
  });
  if (request) await releaseCredits(prisma, userId, request.id);
}

export const releaseAgentCreditsForClientRequest = releaseRequestCreditsForClientRequest;

export async function executeWalletAgentChat(
  prisma: PrismaClient,
  input: {
    userId: string;
    clientRequestId: string;
    messages: unknown[];
    tools?: unknown[] | undefined;
    toolChoice?: unknown;
    model?: string | undefined;
  },
  options?: AgentExecutionOptions,
) {
  const fallbackCredits = await configuredAgentRequestCredits(prisma);
  await ensureAiCatalogSeeded(prisma);
  const resolved = catalogDelegateAvailable(prisma)
    ? isDefaultAgentModelSentinel(input.model)
      ? await resolveAutomaticChatModel(prisma)
      : await resolveCatalogModel(prisma, input.model ?? '', 'chat', { requireEnabled: true })
    : null;
  const canonicalModel = resolved?.model ?? null;
  const route = resolved?.route ?? null;
  const canonicalModelKey = canonicalModel?.canonicalModelKey ?? (input.model?.trim() || 'unmind-agent');
  const pricingSnapshot = canonicalModel
    ? await capturePricingSnapshot(prisma, canonicalModel, route?.id ?? null, {
      fallbackCredits: fallbackCredits.toString(),
    })
    : undefined;
  const credits = pricingSnapshot ? estimateSnapshotCredits(pricingSnapshot) : fallbackCredits;
  const requestId = await reserveCredits(prisma, {
    userId: input.userId,
    clientRequestId: input.clientRequestId,
    credits,
    capability: 'LLM',
    logicalModel: canonicalModelKey,
    description: 'Agent 请求预扣',
    pricingSnapshot,
  });
  try {
    const providerInput = {
      ...input,
      messages: await proxyAgentChatReferenceImages(prisma, input.userId, input.messages),
    };
    const allProviders = await listProviders(prisma);
    const providersById = new Map(allProviders.map(provider => [provider.id, provider]));
    const routedProviders = resolved?.enabledRoutes.flatMap(candidate => {
      const provider = candidate.channelId ? providersById.get(candidate.channelId) : undefined;
      return provider ? [provider] : [];
    }) ?? [];
    const providers = routedProviders.length > 0
      ? Array.from(new Map(routedProviders.map(provider => [provider.id, provider])).values())
      : allProviders;
    if (providers.length === 0) {
      throw new CloudAiError('provider_unavailable', '当前没有可用的 Agent 渠道', 503);
    }
    const failures: string[] = [];
    let result: unknown;
    let requestAttempt = 0;
    let successfulRouteId = route?.id ?? null;
    const automaticModelSelection = isDefaultAgentModelSentinel(input.model);
    for (const [index, provider] of providers.entries()) {
      let discoveredModels: string[] = [];
      if (automaticModelSelection) {
        try {
          const secrets = decryptProviderSecrets(provider.encryptedSecrets);
          discoveredModels = await readProviderModels(provider, secrets.apiKey, secrets.headers);
        } catch {
          discoveredModels = [];
        }
      }
      const providerRoute = resolved?.enabledRoutes.find(candidate => candidate.channelId === provider.id);
      const requestedUpstreamModel = providerRoute?.upstreamModelId
        ?? (canonicalModel ? legacyUpstreamModelForCanonical(canonicalModelKey, 'chat') : input.model);
      const modelCandidates = buildAgentModelCandidates(provider, requestedUpstreamModel, discoveredModels);
      const initialModel = modelCandidates[0];
      const providerAttemptInput = initialModel
        ? { ...providerInput, model: initialModel }
        : providerInput;
      try {
        requestAttempt += 1;
        result = await requestAgentCompletionFromProvider(
          provider,
          providerAttemptInput,
          false,
          options,
          requestAttempt,
        );
        successfulRouteId = providerRoute?.id ?? null;
        break;
      } catch (error) {
        if (options?.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error('Task cancelled');
        }
        let finalError = error;
        const retriedModels: string[] = [];
        if (canTryAlternativeAgentModel(error) || canRetrySingleAgentProvider(error)) {
          const failedModel = resolveConfiguredAgentModel(provider, providerAttemptInput.model) || '';
          const retryModels = automaticModelSelection
            ? buildSingleProviderAgentRetryModels(
              provider,
              input.model,
              discoveredModels,
              failedModel || discoveredModels[0] || '',
              canRetrySingleAgentProvider(error),
            )
            : canRetrySingleAgentProvider(error) && failedModel
              ? [failedModel]
              : [];
          const attempts: Array<string | null> = retryModels.length > 0
            ? retryModels
            : canRetrySingleAgentProvider(error) ? [null] : [];
          for (const retryModel of attempts) {
            await emitAgentProgress(options, {
              stage: 'retrying',
              progress: 10,
              provider: provider.name,
              model: retryModel ?? failedModel,
              attempt: requestAttempt + 1,
            });
            await waitForAgentProviderRetry(retriedModels.length, options?.signal);
            try {
              requestAttempt += 1;
              result = await requestAgentCompletionFromProvider(
                provider,
                retryModel ? { ...providerAttemptInput, model: retryModel } : providerAttemptInput,
                false,
                options,
                requestAttempt,
              );
              successfulRouteId = providerRoute?.id ?? null;
              break;
            } catch (retryError) {
              if (options?.signal?.aborted) {
                throw options.signal.reason instanceof Error
                  ? options.signal.reason
                  : new Error('Task cancelled');
              }
              finalError = retryError;
              retriedModels.push(retryModel || failedModel || 'default');
              if (!canTryAlternativeAgentModel(retryError)
                && !canRetrySingleAgentProvider(retryError)) {
                break;
              }
            }
          }
          if (result !== undefined) break;
        }
        const modelDetail = retriedModels.length > 0
          ? `（同渠道已重试模型 ${retriedModels.join(' → ')}）`
          : '';
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
    const billingSnapshot = pricingSnapshot
      ? { ...pricingSnapshot, routeId: successfulRouteId }
      : undefined;
    const billing = billingSnapshot
      ? calculateSnapshotCharge(billingSnapshot, { usage: extractChatTokenUsage(result) })
      : {
        schemaVersion: 1 as const,
        model: canonicalModelKey,
        modality: 'chat' as const,
        route: null,
        priceVersion: 0,
        billingType: 'fallback',
        quantity: '1',
        baseCharge: creditDecimal(credits).toFixed(6),
        surcharges: [],
        totalCredits: creditDecimal(credits).toFixed(6),
        details: { fallbackReason: 'catalog_unavailable' },
      };
    const usage = billing.details.usage as Record<string, string> | null | undefined;
    const description = usage
      ? `Chat Token 结算 · ${billing.model} · 输入 ${usage.normalInputTokens} · 缓存读 ${usage.cachedInputTokens} · 缓存写 ${usage.cacheWriteTokens} · 输出 ${usage.outputTokens}`
      : `Chat 请求结算 · ${billing.model}`;
    await settleCredits(prisma, input.userId, requestId, {
      chargedCredits: billing.totalCredits,
      logicalModel: canonicalModelKey,
      billingResult: billing,
      actualRouteId: successfulRouteId,
      description,
    });
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
  },
  options?: AgentExecutionOptions,
) {
  const prompt = `You are an industrial-design, CMF, and product-visual-analysis expert.
Analyze the attached saved inspiration image. Return one JSON object only; no markdown and no explanation.
Use only visual evidence. Do not infer brands, hidden structures, or invisible materials. The primary result must be tags, not prose.
Allowed tag categories are exactly: 产品类别, 设计领域, 风格, 材质, 色彩, 形态, 场景, 视角.
Do not use generic or subjective labels such as 图片, 照片, 素材, 设计作品, 漂亮, 好看, 高级, 产品, 设计.
Return this exact JSON shape:
{"tags":[{"name":"","category":"产品类别","confidence":0.0}],"description":"","objects":[],"colors":[],"form":{"silhouette":[],"geometry":[],"proportion":[]},"cmf":{"colors":[],"materials":[],"finishes":[]},"style":[],"interaction":[],"scene":[]}
Generate 5-16 concise tags. Confidence must be a number from 0 to 1. Keep uncertain fields empty.
User tags: ${JSON.stringify(input.userTags ?? [])}
User notes: ${JSON.stringify(input.userNotes ?? [])}
Existing profile: ${JSON.stringify(input.existingProfile ?? null)}`;
  const providers = await listInspirationProviders(prisma);
  if (providers.length === 0) {
    throw new CloudAiError('provider_unavailable', '当前没有可用的灵感分析渠道', 503);
  }
  let value: unknown;
  let requestAttempt = 0;
  const failures: string[] = [];
  for (const [providerIndex, provider] of providers.entries()) {
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const model = await discoverModel(
      provider,
      secrets.apiKey,
      secrets.headers,
      undefined,
      providerIndex > 0,
    );
    let finalError: unknown;
    for (let retry = 0; retry < 3; retry += 1) {
      if (retry > 0) {
        await emitAgentProgress(options, {
          stage: 'retrying',
          progress: 10,
          provider: provider.name,
          model,
          attempt: requestAttempt + 1,
        });
        await waitForAgentProviderRetry(retry - 1, options?.signal);
      }
      requestAttempt += 1;
      try {
        const completion = await requestStreamingCompletion(provider, model, {
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: input.imageSource, detail: 'low' } },
            ],
          }],
        }, options, requestAttempt);
        value = completion.result;
        break;
      } catch (error) {
        if (options?.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error('Task cancelled');
        }
        finalError = error;
        if (retry >= 2 || !canRetrySingleAgentProvider(error)) break;
      }
    }
    if (value !== undefined) break;
    failures.push(`${provider.name}：${agentProviderFailureDetail(finalError)}`);
    if (!canFallbackToNextAgentProvider(finalError)) break;
  }
  if (value === undefined) {
    throw new CloudAiError(
      'provider_request_failed',
      `灵感自动分析渠道请求失败：${failures.at(-1) ?? '未知通道错误'}`,
      502,
    );
  }
  const payloads = parseImageAnalysisResponsePayloads(value);
  if (payloads.length === 0) {
    throw new CloudAiError('provider_invalid_response', '灵感自动分析未返回有效 JSON', 502);
  }
  let bestAnalysis: ReturnType<typeof normalizeImageTagAnalysis> | null = null;
  for (const payload of payloads) {
    const analysis = normalizeImageTagAnalysis(payload, input);
    if (!bestAnalysis || analysis.tags.length > bestAnalysis.tags.length) bestAnalysis = analysis;
    if (analysis.tags.length >= MIN_AI_IMAGE_TAGS) return analysis;
  }
  if (bestAnalysis?.tags.length) return bestAnalysis;
  throw new CloudAiError('provider_invalid_response', '灵感自动分析没有返回有效标签', 502);
}

export async function executeWalletInspirationAnalysis(
  prisma: PrismaClient,
  input: {
    userId: string;
    clientRequestId: string;
    itemId: string;
    imageSource: string;
    userTags?: string[] | undefined;
    userNotes?: string[] | undefined;
    existingProfile?: unknown;
  },
  options?: AgentExecutionOptions,
) {
  const credits = await configuredInspirationAnalysisCredits(prisma);
  const requestId = await reserveCredits(prisma, {
    userId: input.userId,
    clientRequestId: input.clientRequestId,
    credits,
    capability: 'VISION',
    logicalModel: 'inspiration-analysis',
    description: '图片分析预扣',
  });
  try {
    const result = await executeFreeInspirationAnalysis(prisma, input, options);
    await settleCredits(prisma, input.userId, requestId);
    return result;
  } catch (error) {
    await releaseCredits(prisma, input.userId, requestId);
    throw error;
  }
}

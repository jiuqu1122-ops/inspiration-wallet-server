import type { PrismaClient } from '@prisma/client';
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

async function selectProvider(prisma: PrismaClient) {
  const provider = await prisma.aiProviderChannel.findFirst({
    where: { status: 'ACTIVE', capabilities: { has: 'LLM' } },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
  });
  if (!provider) {
    throw new CloudAiError('provider_unavailable', '当前没有可用的 Agent 渠道', 503);
  }
  await assertPublicProviderUrl(provider.baseUrl);
  return provider;
}

function upstreamHeaders(apiKey: string, customHeaders: Record<string, string>) {
  const headers = new Headers({
    accept: 'application/json',
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
) {
  if (preferredModel?.trim()) return preferredModel.trim();
  if (provider.defaultModel?.trim()) return provider.defaultModel.trim();
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

async function readProviderModels(
  provider: { baseUrl: string },
  apiKey: string,
  customHeaders: Record<string, string>,
) {
  const response = await fetch(providerEndpoint(provider.baseUrl, '/v1/models'), {
    headers: upstreamHeaders(apiKey, customHeaders),
    redirect: 'error',
  });
  if (!response.ok) throw new CloudAiError('provider_request_failed', `Agent 妯″瀷鍒楄〃璇锋眰澶辫触（HTTP ${response.status}）`, 502);
  const value: unknown = await response.json();
  const data = value && typeof value === 'object' && 'data' in value
    ? (value as { data?: unknown }).data
    : value;
  return Array.from(new Set((Array.isArray(data) ? data : [])
    .map((item: unknown) => item && typeof item === 'object' && 'id' in item ? (item as { id?: unknown }).id : item)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map(id => id.trim())));
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
    const provider = await selectProvider(prisma);
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const model = await discoverModel(provider, secrets.apiKey, secrets.headers, input.model);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4 * 60_000);
    let response: Response;
    try {
      response = await fetch(providerEndpoint(provider.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: upstreamHeaders(secrets.apiKey, secrets.headers),
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: false,
          ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
        }),
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new CloudAiError(
        'provider_request_failed',
        `Agent 渠道请求失败（HTTP ${response.status}）`,
        502,
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new CloudAiError('provider_invalid_response', 'Agent 渠道返回格式无效', 502);
    }
    const providerFailure = providerFailureMessage(result);
    if (providerFailure) {
      throw new CloudAiError('provider_request_failed', `Agent upstream failed: ${providerFailure}`, 502);
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
  try {
    response = await fetch(providerEndpoint(provider.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: upstreamHeaders(secrets.apiKey, secrets.headers),
      body: JSON.stringify({
        model,
        stream: false,
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
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CloudAiError('provider_request_failed', `灵感自动分析渠道请求失败（HTTP ${response.status}）`, 502);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new CloudAiError('provider_invalid_response', '灵感自动分析渠道返回格式无效', 502);
  }
  const content = (value as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
      : '';
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return { profile: JSON.parse(jsonText) as unknown }; } catch {
    throw new CloudAiError('provider_invalid_response', '灵感自动分析未返回有效 JSON', 502);
  }
}

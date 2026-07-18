import type {
  AiCapability,
  AiProviderChannel,
  AiProviderKind,
  PrismaClient,
} from '@prisma/client';
import {
  decryptProviderSecrets,
  encryptProviderSecrets,
  ProviderSecretsConfigurationError,
  type ProviderSecrets,
} from '../../lib/provider-secrets.js';
import {
  assertPublicProviderUrl,
  normalizeProviderBaseUrl,
  providerEndpoint,
} from './url.js';

export class ProviderServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderServiceError';
  }
}

type ProviderInput = {
  name: string;
  kind: AiProviderKind;
  priority?: number | undefined;
  baseUrl: string;
  defaultModel?: string | undefined;
  apiKey: string;
  headers: Record<string, string>;
  allowInsecureHttp?: boolean | undefined;
  capabilities?: AiCapability[] | undefined;
  enabled?: boolean | undefined;
  idempotencyKey: string;
};

type ProviderUpdateInput = {
  name?: string | undefined;
  priority?: number | undefined;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  allowInsecureHttp?: boolean | undefined;
  capabilities?: AiCapability[] | undefined;
  enabled?: boolean | undefined;
  idempotencyKey: string;
};

function configurationError(error: unknown): never {
  if (error instanceof ProviderSecretsConfigurationError) {
    throw new ProviderServiceError('provider_encryption_not_configured', error.message, 503);
  }
  throw error;
}

function serializeProvider(provider: AiProviderChannel) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    enabled: provider.status === 'ACTIVE',
    priority: provider.priority,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    allowInsecureHttp: provider.allowInsecureHttp,
    apiKeyConfigured: true,
    apiKeyLast4: provider.apiKeyLast4,
    capabilities: provider.capabilities,
    lastTestStatus: provider.lastTestStatus,
    lastTestMessage: provider.lastTestMessage,
    lastTestModelCount: provider.lastTestModelCount,
    lastTestedAt: provider.lastTestedAt?.toISOString() ?? null,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function defaultCapabilities(): AiCapability[] {
  return ['LLM'];
}

function cleanHeaders(headers: Record<string, string>) {
  const blocked = new Set([
    'authorization',
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'proxy-authorization',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
  ]);
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = rawValue.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new ProviderServiceError('invalid_header', `Invalid custom header name: ${name}`, 400);
    }
    if (blocked.has(name.toLowerCase())) {
      throw new ProviderServiceError('invalid_header', `Custom header is not allowed: ${name}`, 400);
    }
    if (!value || /[\r\n]/.test(value)) {
      throw new ProviderServiceError('invalid_header', `Invalid custom header value: ${name}`, 400);
    }
    result[name] = value;
  }
  return result;
}

async function normalizeAndValidate(
  kind: AiProviderKind,
  baseUrl: string,
  allowInsecureHttp: boolean,
) {
  let normalized: string;
  try {
    normalized = normalizeProviderBaseUrl(kind, baseUrl, allowInsecureHttp);
    await assertPublicProviderUrl(normalized);
  } catch (error) {
    throw new ProviderServiceError(
      'invalid_provider_url',
      error instanceof Error ? error.message : 'Provider Base URL is invalid',
      400,
    );
  }
  return normalized;
}

async function replayProviderOperation(prisma: PrismaClient, idempotencyKey: string) {
  return prisma.adminOperation.findUnique({ where: { idempotencyKey } });
}

export async function listProviders(prisma: PrismaClient) {
  const providers = await prisma.aiProviderChannel.findMany({
    orderBy: [{ priority: 'asc' }, { kind: 'asc' }, { name: 'asc' }],
  });
  return { items: providers.map(serializeProvider) };
}

export async function createProvider(prisma: PrismaClient, input: ProviderInput) {
  const replayed = await replayProviderOperation(prisma, input.idempotencyKey);
  if (replayed) return { replayed: true, provider: replayed.result };

  const allowInsecureHttp = input.allowInsecureHttp === true;
  const baseUrl = await normalizeAndValidate(input.kind, input.baseUrl, allowInsecureHttp);
  const headers = cleanHeaders(input.headers);
  let encryptedSecrets: string;
  try {
    encryptedSecrets = encryptProviderSecrets({ apiKey: input.apiKey.trim(), headers });
  } catch (error) {
    configurationError(error);
  }
  const capabilities = input.capabilities ?? defaultCapabilities();

  try {
    return await prisma.$transaction(async (tx) => {
      const provider = await tx.aiProviderChannel.create({
        data: {
          name: input.name.trim(),
          kind: input.kind,
          status: input.enabled === false ? 'DISABLED' : 'ACTIVE',
          priority: input.priority ?? 100,
          baseUrl,
          defaultModel: input.defaultModel?.trim() || null,
          allowInsecureHttp,
          encryptedSecrets,
          apiKeyLast4: input.apiKey.trim().slice(-4),
          capabilities,
        },
      });
      const serialized = serializeProvider(provider);
      await tx.adminOperation.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: 'CREATE_PROVIDER',
          description: `Created ${input.kind} provider ${provider.name}`,
          result: serialized,
        },
      });
      return { replayed: false, provider: serialized };
    });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      const concurrentReplay = await replayProviderOperation(prisma, input.idempotencyKey);
      if (concurrentReplay) return { replayed: true, provider: concurrentReplay.result };
      throw new ProviderServiceError('provider_name_conflict', 'Provider name already exists', 409);
    }
    throw error;
  }
}

export async function updateProvider(
  prisma: PrismaClient,
  providerId: string,
  input: ProviderUpdateInput,
) {
  const replayed = await replayProviderOperation(prisma, input.idempotencyKey);
  if (replayed) return { replayed: true, provider: replayed.result };
  const current = await prisma.aiProviderChannel.findUnique({ where: { id: providerId } });
  if (!current) throw new ProviderServiceError('provider_not_found', 'Provider not found', 404);

  const allowInsecureHttp = input.allowInsecureHttp ?? current.allowInsecureHttp;
  const baseUrl = input.baseUrl || input.allowInsecureHttp !== undefined
    ? await normalizeAndValidate(current.kind, input.baseUrl ?? current.baseUrl, allowInsecureHttp)
    : current.baseUrl;
  let encryptedSecrets = current.encryptedSecrets;
  let apiKeyLast4 = current.apiKeyLast4;
  if (input.apiKey !== undefined || input.headers !== undefined) {
    let currentSecrets: ProviderSecrets;
    try {
      currentSecrets = decryptProviderSecrets(current.encryptedSecrets);
    } catch (error) {
      configurationError(error);
    }
    const apiKey = input.apiKey?.trim() || currentSecrets.apiKey;
    const headers = input.headers === undefined ? currentSecrets.headers : cleanHeaders(input.headers);
    try {
      encryptedSecrets = encryptProviderSecrets({ apiKey, headers });
    } catch (error) {
      configurationError(error);
    }
    apiKeyLast4 = apiKey.slice(-4);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const provider = await tx.aiProviderChannel.update({
        where: { id: providerId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.enabled !== undefined ? { status: input.enabled ? 'ACTIVE' : 'DISABLED' } : {}),
          ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
          ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel.trim() || null } : {}),
          baseUrl,
          allowInsecureHttp,
          encryptedSecrets,
          apiKeyLast4,
          lastTestStatus: null,
          lastTestMessage: null,
          lastTestModelCount: null,
          lastTestedAt: null,
        },
      });
      const serialized = serializeProvider(provider);
      await tx.adminOperation.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: 'UPDATE_PROVIDER',
          description: `Updated ${provider.kind} provider ${provider.name}`,
          result: serialized,
        },
      });
      return { replayed: false, provider: serialized };
    });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      const concurrentReplay = await replayProviderOperation(prisma, input.idempotencyKey);
      if (concurrentReplay) return { replayed: true, provider: concurrentReplay.result };
      throw new ProviderServiceError('provider_name_conflict', 'Provider name already exists', 409);
    }
    throw error;
  }
}

async function readLimitedBody(response: Response, limit = 1_048_576) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Provider response exceeded the 1 MiB safety limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responsePreview(value: string, secrets: ProviderSecrets) {
  let preview = value.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  for (const secret of [secrets.apiKey, ...Object.values(secrets.headers)]) {
    if (secret) preview = preview.split(secret).join('[redacted]');
  }
  return preview;
}

async function providerGet(
  url: string,
  secrets: ProviderSecrets,
  options?: { bearerToken?: string | undefined; headers?: Record<string, string> | undefined },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = new Headers({
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${options?.bearerToken ?? secrets.apiKey}`,
      'user-agent': 'Inspiration-Wallet-Server/1',
    });
    for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
    for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value);
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readLimitedBody(response);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responsePreview(body, secrets) || 'empty response'}`);
    }
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function valueAt(value: unknown, pointers: string[]) {
  for (const pointer of pointers) {
    let current: unknown = value;
    for (const segment of pointer.split('/').filter(Boolean)) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = Reflect.get(current, segment);
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function numericAt(value: unknown, pointers: string[]) {
  const candidate = valueAt(value, pointers);
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === 'string' && candidate.trim()) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanAt(value: unknown, pointers: string[]) {
  const candidate = valueAt(value, pointers);
  return candidate === true || candidate === 1 || (
    typeof candidate === 'string' && ['true', 'yes', '1'].includes(candidate.trim().toLowerCase())
  );
}

function decimal(value: number | null) {
  if (value === null) return null;
  if (Number.isInteger(value)) return value.toFixed(0);
  return Number(value.toFixed(4)).toString();
}

export function normalizeProviderBalance(
  kind: AiProviderKind,
  endpoint: string,
  value: unknown,
) {
  if (kind === 'XAIS') {
    const rawBalance = numericAt(value, ['/data/balance', '/balance']);
    const available = rawBalance === null ? null : rawBalance / 10_000;
    return {
      available: available !== null,
      endpoint,
      totalGranted: null,
      totalUsed: null,
      totalAvailable: decimal(available),
      unlimited: false,
      currency: 'points',
      display: available === null
        ? 'XAIS 接口可访问，但响应中没有 balance 字段'
        : `剩余积分 ${decimal(available)}`,
    };
  }

  const totalGranted = numericAt(value, [
    '/data/total_granted', '/total_granted', '/data/quota', '/quota', '/data/total',
  ]);
  const totalUsed = numericAt(value, [
    '/data/total_used', '/total_used', '/data/used_quota', '/used_quota', '/data/used',
  ]);
  const directAvailable = numericAt(value, [
    '/data/total_available', '/total_available', '/data/balance', '/balance',
    '/data/quota', '/quota', '/data/remain_quota', '/remain_quota',
    '/data/available_quota', '/available_quota', '/data/credit_grants/total_available',
  ]);
  const totalAvailable = directAvailable ?? (
    totalGranted !== null && totalUsed !== null ? totalGranted - totalUsed : null
  );
  const unlimited = booleanAt(value, [
    '/data/unlimited_quota', '/unlimited_quota', '/data/unlimited', '/unlimited',
  ]);
  const available = unlimited || totalAvailable !== null || totalGranted !== null;
  const currencyValue = valueAt(value, ['/data/currency', '/currency']);
  const currency = typeof currencyValue === 'string' ? currencyValue : null;
  return {
    available,
    endpoint,
    totalGranted: decimal(totalGranted),
    totalUsed: decimal(totalUsed),
    totalAvailable: decimal(totalAvailable),
    unlimited,
    currency,
    display: unlimited
      ? '无限额度'
      : available
        ? `总额度 ${decimal(totalGranted) ?? '-'} · 已使用 ${decimal(totalUsed) ?? '-'} · 剩余额度 ${decimal(totalAvailable) ?? '-'}`
        : '接口可访问，但响应中没有可识别的余额字段',
  };
}

function headerValue(headers: Record<string, string>, names: string[]) {
  for (const [name, value] of Object.entries(headers)) {
    if (names.some((candidate) => candidate.toLowerCase() === name.toLowerCase()) && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function newApiManagementAuth(secrets: ProviderSecrets) {
  const token = headerValue(secrets.headers, [
    'X-Linggan-NewAPI-Access-Token', 'X-NewAPI-Access-Token',
    'NewAPI-Access-Token', 'NewAPI-User-Token',
  ]);
  const user = headerValue(secrets.headers, [
    'X-Linggan-NewAPI-User', 'X-Linggan-NewAPI-User-ID', 'X-NewAPI-User',
    'X-NewAPI-User-ID', 'New-Api-User', 'NewAPI-User', 'NewAPI-User-ID',
  ]);
  return token && user ? { token, user } : null;
}

export async function getProviderBalance(prisma: PrismaClient, providerId: string) {
  const provider = await prisma.aiProviderChannel.findUnique({ where: { id: providerId } });
  if (!provider) throw new ProviderServiceError('provider_not_found', 'Provider not found', 404);
  await normalizeAndValidate(provider.kind, provider.baseUrl, provider.allowInsecureHttp);

  let secrets: ProviderSecrets;
  try {
    secrets = decryptProviderSecrets(provider.encryptedSecrets);
  } catch (error) {
    configurationError(error);
  }

  const candidates = provider.kind === 'XAIS'
    ? [{ name: 'XAIS /xais/userProfile', path: '/xais/userProfile' }]
    : [
      { name: 'NewAPI /api/usage/token/', path: '/api/usage/token/' },
      { name: 'NewAPI /api/user/self', path: '/api/user/self' },
      { name: 'NewAPI /newapi/balance', path: '/newapi/balance' },
      { name: 'OpenAI /dashboard/billing/credit_grants', path: '/dashboard/billing/credit_grants' },
    ];
  const managementAuth = provider.kind === 'NEW_API' ? newApiManagementAuth(secrets) : null;
  const errors: string[] = [];
  let reachableResult: ReturnType<typeof normalizeProviderBalance> | null = null;

  for (const candidate of candidates) {
    try {
      const useManagementAuth = candidate.path === '/api/user/self' && managementAuth;
      const value = await providerGet(
        providerEndpoint(provider.baseUrl, candidate.path),
        secrets,
        useManagementAuth
          ? { bearerToken: managementAuth.token, headers: { 'New-Api-User': managementAuth.user } }
          : undefined,
      );
      const result = normalizeProviderBalance(provider.kind, candidate.name, value);
      if (result.available) return result;
      reachableResult = result;
    } catch (error) {
      errors.push(`${candidate.name}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  if (reachableResult) return reachableResult;
  throw new ProviderServiceError(
    'provider_balance_failed',
    `Unable to query provider balance: ${errors.join(' | ').slice(0, 1_200)}`,
    502,
  );
}

function modelIds(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const data: unknown = Reflect.get(value, 'data');
  if (!Array.isArray(data)) return [];
  return data
    .map((item: unknown) => (
      item && typeof item === 'object' && 'id' in item ? Reflect.get(item, 'id') : null
    ))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 50);
}

export async function testProvider(prisma: PrismaClient, providerId: string) {
  const provider = await prisma.aiProviderChannel.findUnique({ where: { id: providerId } });
  if (!provider) throw new ProviderServiceError('provider_not_found', 'Provider not found', 404);
  await normalizeAndValidate(provider.kind, provider.baseUrl, provider.allowInsecureHttp);

  let secrets: ProviderSecrets;
  try {
    secrets = decryptProviderSecrets(provider.encryptedSecrets);
  } catch (error) {
    configurationError(error);
  }

  let status = 'FAILED';
  let message = 'Provider connection failed';
  let models: string[] = [];
  try {
    const value = await providerGet(providerEndpoint(provider.baseUrl, '/v1/models'), secrets);
    models = modelIds(value);
    status = 'OK';
    message = models.length
      ? `Connected successfully; ${models.length} models discovered`
      : 'Connected successfully; the provider returned no model IDs';
  } catch (modelsError) {
    if (provider.kind !== 'XAIS') throw modelsError;
    await providerGet(providerEndpoint(provider.baseUrl, '/xais/userProfile'), secrets);
    status = 'OK';
    message = 'Connected successfully through XAIS userProfile';
  }

  const testedAt = new Date();
  await prisma.aiProviderChannel.update({
    where: { id: provider.id },
    data: {
      lastTestStatus: status,
      lastTestMessage: message,
      lastTestModelCount: models.length,
      lastTestedAt: testedAt,
    },
  });
  return { ok: true, message, modelCount: models.length, models, testedAt: testedAt.toISOString() };
}

export async function recordProviderTestFailure(
  prisma: PrismaClient,
  providerId: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : 'Provider connection failed';
  await prisma.aiProviderChannel.updateMany({
    where: { id: providerId },
    data: {
      lastTestStatus: 'FAILED',
      lastTestMessage: message.slice(0, 500),
      lastTestModelCount: null,
      lastTestedAt: new Date(),
    },
  });
  throw new ProviderServiceError('provider_test_failed', message, 502);
}

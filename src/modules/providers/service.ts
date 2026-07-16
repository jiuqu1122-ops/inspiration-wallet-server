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
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  capabilities?: AiCapability[] | undefined;
  enabled?: boolean | undefined;
  idempotencyKey: string;
};

type ProviderUpdateInput = {
  name?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
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
    baseUrl: provider.baseUrl,
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
  return ['LLM', 'IMAGE', 'VIDEO'];
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

async function normalizeAndValidate(kind: AiProviderKind, baseUrl: string) {
  let normalized: string;
  try {
    normalized = normalizeProviderBaseUrl(kind, baseUrl);
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
    orderBy: [{ kind: 'asc' }, { updatedAt: 'desc' }],
  });
  return { items: providers.map(serializeProvider) };
}

export async function createProvider(prisma: PrismaClient, input: ProviderInput) {
  const replayed = await replayProviderOperation(prisma, input.idempotencyKey);
  if (replayed) return { replayed: true, provider: replayed.result };

  const baseUrl = await normalizeAndValidate(input.kind, input.baseUrl);
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
          baseUrl,
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

  const baseUrl = input.baseUrl
    ? await normalizeAndValidate(current.kind, input.baseUrl)
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
          ...(input.enabled !== undefined ? { status: input.enabled ? 'ACTIVE' : 'DISABLED' } : {}),
          ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
          baseUrl,
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

async function providerGet(url: string, secrets: ProviderSecrets) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = new Headers({
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${secrets.apiKey}`,
      'user-agent': 'Inspiration-Wallet-Server/1',
    });
    for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
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
  await normalizeAndValidate(provider.kind, provider.baseUrl);

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

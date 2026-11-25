import type { AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { metasoMiniMaxDispatcher } from '../providers/metaso-transport.js';
import { assertPublicProviderUrl, isMetasoMiniMax, minimaxH3EndpointPath, providerEndpoint } from '../providers/url.js';
import { buildFailureDiagnostic } from './failure-diagnostic.js';
import {
  catalogAliasKey,
  explicitCanonicalModelKey,
  type AiModality,
} from './model-catalog.js';
import { refreshSuggestedPriceForModel } from './model-admin.js';

export type NormalizedUpstreamModel = {
  provider: string;
  upstreamModelId: string;
  modality: AiModality | null;
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  capabilities: Prisma.InputJsonValue | null;
  context: Prisma.InputJsonValue | null;
  resolution: Prisma.InputJsonValue | null;
  duration: Prisma.InputJsonValue | null;
  cost: Prisma.InputJsonValue | null;
  metadata: Prisma.InputJsonValue;
  configuredAdapterKey?: 'MINIMAX_NATIVE_VIDEO';
};

export interface UpstreamModelAdapter {
  listModels(provider: AiProviderChannel): Promise<NormalizedUpstreamModel[]>;
}

export type UpstreamSyncChange = {
  kind: 'NEW_MODEL' | 'COST_CHANGED' | 'STATUS_CHANGED';
  providerId: string;
  providerName: string;
  upstreamModelId: string;
  canonicalModelId: string | null;
  before: Prisma.InputJsonValue | string | null;
  after: Prisma.InputJsonValue | string | null;
};

const objectValue = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const jsonValue = (value: unknown): Prisma.InputJsonValue | null => {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return null;
  }
};

function modelId(item: unknown) {
  if (typeof item === 'string') return item.trim();
  const record = objectValue(item);
  const raw = record?.id ?? record?.name ?? record?.model ?? record?.model_id;
  return typeof raw === 'string' ? raw.replace(/^models\//, '').trim() : '';
}

function providerModalityHints(provider: Pick<AiProviderChannel, 'capabilities'>) {
  const hints = new Set<AiModality>();
  if (provider.capabilities.some(capability => capability === 'LLM' || capability === 'VISION')) hints.add('chat');
  if (provider.capabilities.some(capability => capability.startsWith('IMAGE'))) hints.add('image');
  if (provider.capabilities.some(capability => capability.startsWith('VIDEO'))) hints.add('video');
  return [...hints];
}

const explicitModalityFields = [
  'modality',
  'type',
  'model_type',
  'modelType',
  'category',
  'task_type',
  'taskType',
] as const;

export function explicitUpstreamModality(item: unknown): AiModality | null {
  const record = objectValue(item);
  if (!record) return null;
  for (const field of explicitModalityFields) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
    if (new Set(['image', 'image_generation', 'image-generation', 'text-to-image', 'text_to_image']).has(normalized)) {
      return 'image';
    }
    if (new Set(['video', 'video_generation', 'video-generation', 'text-to-video', 'text_to_video', 'image-to-video', 'image_to_video']).has(normalized)) {
      return 'video';
    }
    if (new Set(['chat', 'llm', 'text', 'completion', 'text_generation', 'text-generation']).has(normalized)) {
      return 'chat';
    }
  }
  return null;
}

export function providerSpecificModality(
  provider: Pick<AiProviderChannel, 'kind'>,
  upstreamModelId: string,
): AiModality | null {
  if (provider.kind === 'VOLCENGINE_ARK' && /^doubao-seedream-/i.test(upstreamModelId)) return 'image';
  if (provider.kind.toUpperCase() !== 'USELG') return null;
  const id = upstreamModelId.trim().toLowerCase();
  if (/^sd[-_.]?2[._-][05](?:[-_.]|$)/.test(id) || /^sd-2-fast(?:[-_.]|$)/.test(id)) return 'video';
  if (/^seedance(?:[-_.]?2(?:[._-][05])?)(?:[-_.]|$)/.test(id)) return 'video';
  if (/^minimax[-_]h3(?:[-_.]|$)/.test(id)) return 'video';
  return null;
}

export function genericModelNameModality(id: string): AiModality | null {
  const token = catalogAliasKey(id);
  // This is advisory only. It never maps or opens a model.
  // Model discovery must not be constrained by the legacy channel enum: a
  // newly launched model may not have a matching enum value yet.
  if (/(?:image|imagen|img|banana|flux|dalle|recraft)/.test(token)) return 'image';
  if (/(?:stablediffusion|sdxl)/.test(token) || /^sd3(?:[-_.]|$)/i.test(id.trim())) return 'image';
  if (/(?:video|sora|veo|kling|seedance|minimaxh3)/.test(token)) return 'video';
  return null;
}

export function inferSuggestedModality(
  provider: Pick<AiProviderChannel, 'kind' | 'capabilities'>,
  id: string,
  item?: unknown,
): AiModality | null {
  if (provider.kind === 'VOLCENGINE_ARK') {
    const domain = objectValue(item)?.domain;
    if (domain === 'ImageGeneration') return 'image';
    if (domain === 'VideoGeneration') return 'video';
    if (domain === 'LLM' || domain === 'VLM') return 'chat';
    if (typeof domain === 'string' && domain) return null;
  }
  const hints = providerModalityHints(provider);
  return explicitUpstreamModality(item)
    ?? providerSpecificModality(provider, id)
    ?? genericModelNameModality(id)
    ?? (hints.length === 1 ? hints[0]! : null);
}

function preservesConfiguredRouteCapabilities(metadata: unknown) {
  const source = objectValue(metadata)?.capabilitiesOverrideSource;
  return source === 'MANUAL' || source === 'INHERIT';
}

function refreshedRouteMetadata(current: unknown, discovered: Prisma.InputJsonValue) {
  const existing = objectValue(current);
  const preserveCapabilities = preservesConfiguredRouteCapabilities(current);
  if (!preserveCapabilities && !existing?.canvasLayers) return discovered;
  return {
    ...(preserveCapabilities ? existing : {}),
    ...(objectValue(discovered) ?? {}),
    ...(preserveCapabilities ? { capabilitiesOverrideSource: existing?.capabilitiesOverrideSource } : {}),
    ...(existing?.canvasLayers ? { canvasLayers: existing.canvasLayers } : {}),
  } as Prisma.InputJsonValue;
}

function normalizeModel(provider: AiProviderChannel, item: unknown): NormalizedUpstreamModel | null {
  const upstreamModelId = modelId(item);
  if (!upstreamModelId) return null;
  const record = objectValue(item) ?? {};
  const modality = inferSuggestedModality(provider, upstreamModelId, item);
  const availableValue = record.available ?? record.enabled ?? record.active;
  const availability = availableValue === false
    ? 'UNAVAILABLE'
    : availableValue === true ? 'AVAILABLE' : 'UNKNOWN';
  return {
    provider: provider.kind,
    upstreamModelId,
    modality,
    availability,
    capabilities: jsonValue(record.capabilities),
    context: jsonValue(record.context ?? record.context_window ?? record.contextWindow),
    resolution: jsonValue(record.resolution ?? record.resolutions),
    duration: jsonValue(record.duration ?? record.durations),
    cost: jsonValue(record.cost ?? record.pricing ?? record.price),
    metadata: jsonValue({
      raw: record,
      adapter: provider.kind === 'BIGMODEL' ? 'gemini' : provider.kind === 'VOLCENGINE_ARK' ? 'volcengine-ark' : 'openai',
      inferredModality: modality,
    }) ?? {},
  };
}

async function fetchProviderJson(provider: AiProviderChannel, path: string, dispatcher?: typeof metasoMiniMaxDispatcher) {
  await assertPublicProviderUrl(provider.baseUrl);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${secrets.apiKey}`,
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  if (provider.kind !== 'VOLCENGINE_ARK' && !dispatcher) headers.set('x-goog-api-key', secrets.apiKey);
  for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      headers,
      redirect: 'error',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Upstream model sync failed with HTTP ${response.status}`), { status: response.status });
    }
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

class JsonModelAdapter implements UpstreamModelAdapter {
  constructor(private readonly path: string) {}

  async listModels(provider: AiProviderChannel) {
    const value = await fetchProviderJson(provider, this.path);
    const root = objectValue(value);
    if (provider.kind === 'VOLCENGINE_ARK' && !Array.isArray(root?.data)) {
      throw new Error('火山方舟返回的模型列表格式不正确');
    }
    const candidates: unknown[] = Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models) ? root.models
        : Array.isArray(value) ? value : [];
    const configured = provider.kind === 'VOLCENGINE_ARK' ? provider.defaultModel?.trim() : '';
    const entries = configured ? [...candidates, { id: configured, domain: 'ImageGeneration' }] : candidates;
    return entries
      .map(item => normalizeModel(provider, item))
      .filter((item): item is NormalizedUpstreamModel => item !== null)
      .filter((item, index, all) => all.findIndex(other => other.upstreamModelId === item.upstreamModelId) === index)
      .slice(0, 1000);
  }
}

const openAiAdapter = new JsonModelAdapter('/v1/models');
const geminiAdapter = new JsonModelAdapter('/v1beta/models');
const arkAdapter = new JsonModelAdapter('/models');

const metasoMiniMaxAdapter: UpstreamModelAdapter = {
  async listModels(provider) {
    const path = minimaxH3EndpointPath(provider.baseUrl, '/v2/credits/balance');
    try {
      const balance = objectValue(await fetchProviderJson(provider, path, metasoMiniMaxDispatcher));
      if (!balance || balance.error || balance.type === 'error' || balance.success === false) {
        throw new Error('MiniMax H3 account probe returned an invalid response');
      }
    } catch (error) {
      const diagnostic = buildFailureDiagnostic(error, { stage: 'video_task' });
      const reason = diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}` : diagnostic.causeCode ?? diagnostic.message;
      throw new Error(`MiniMax H3 渠道校验失败（${reason}）`);
    }

    // The account probe validates connectivity and credentials. The channel
    // uses a fixed model ID and the probe supplies no model health or prices.
    const model = normalizeModel(provider, { id: 'MiniMax-H3', type: 'video' })!;
    return [{ ...model, configuredAdapterKey: 'MINIMAX_NATIVE_VIDEO',
      metadata: { adapter: 'minimax-h3', catalogSource: 'configured', inferredModality: 'video' } }];
  },
};

export function upstreamAdapterFor(provider: AiProviderChannel): UpstreamModelAdapter {
  if (provider.kind === 'VOLCENGINE_ARK') return arkAdapter;
  if (provider.kind === 'MINIMAX' && isMetasoMiniMax(provider.baseUrl)) return metasoMiniMaxAdapter;
  return provider.kind === 'BIGMODEL' ? geminiAdapter : openAiAdapter;
}

async function updateMappedRouteCost(
  prisma: PrismaClient,
  route: { id: string; canonicalModelId: string | null; costProfile: Prisma.JsonValue | null },
  cost: Prisma.InputJsonValue | null,
) {
  if (!cost) {
    await prisma.aiModelRoute.update({
      where: { id: route.id },
      data: { pricingSyncStatus: route.costProfile ? 'WARNING_STALE_COST' : 'WARNING_COST_UNAVAILABLE' },
    });
    return false;
  }
  const changed = JSON.stringify(route.costProfile) !== JSON.stringify(cost);
  await prisma.aiModelRoute.update({
    where: { id: route.id },
    data: { costProfile: cost, costUpdatedAt: new Date(), pricingSyncStatus: 'OK' },
  });
  if (changed) {
    await prisma.aiRouteCostHistory.create({
      data: { routeId: route.id, costProfile: cost, pricingSyncStatus: 'OK' },
    });
  }
  if (route.canonicalModelId) await refreshSuggestedPriceForModel(prisma, route.canonicalModelId);
  return changed;
}

async function confirmedMappedModel(
  prisma: PrismaClient,
  provider: AiProviderChannel,
  item: NormalizedUpstreamModel,
) {
  const modalities = item.modality ? [item.modality] : [];
  for (const modality of modalities) {
    const explicitKey = explicitCanonicalModelKey(modality, item.upstreamModelId, provider.capabilities);
    if (explicitKey) {
      const model = await prisma.aiModel.findUnique({ where: { canonicalModelKey: explicitKey } });
      if (model) return model;
    }
    const alias = await prisma.aiModelAlias.findUnique({
      where: { modality_aliasKey: { modality, aliasKey: catalogAliasKey(item.upstreamModelId) } },
      include: { canonicalModel: true },
    });
    if (alias?.confirmed) return alias.canonicalModel;
  }
  return null;
}

export async function syncUpstreamModels(prisma: PrismaClient, providerId: string) {
  const provider = await prisma.aiProviderChannel.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error('Provider was not found');
  const models = await upstreamAdapterFor(provider).listModels(provider);
  let mapped = 0;
  let unmapped = 0;
  let newModels = 0;
  let costChanges = 0;
  let statusChanges = 0;
  const changes: UpstreamSyncChange[] = [];
  for (const item of models) {
    const configuredAdapterKey = item.configuredAdapterKey;
    const upstreamAvailable = item.availability !== 'UNAVAILABLE';
    const healthStatus = configuredAdapterKey ? 'UNKNOWN' : upstreamAvailable ? 'HEALTHY' : 'UNAVAILABLE';
    const existingRoute = await prisma.aiModelRoute.findFirst({
      where: { provider: provider.kind, channelId: provider.id, upstreamModelId: item.upstreamModelId },
    });
    if (existingRoute) {
      if (!configuredAdapterKey && (existingRoute.upstreamAvailable !== upstreamAvailable
        || existingRoute.healthStatus !== healthStatus)) {
        statusChanges += 1;
        changes.push({
          kind: 'STATUS_CHANGED',
          providerId: provider.id,
          providerName: provider.name,
          upstreamModelId: item.upstreamModelId,
          canonicalModelId: existingRoute.canonicalModelId,
          before: existingRoute.healthStatus,
          after: healthStatus,
        });
      }
      await prisma.aiModelRoute.update({
        where: { id: existingRoute.id },
        data: configuredAdapterKey ? {
          lastSyncedAt: new Date(),
          ...(existingRoute.adapterKey ? {} : { adapterKey: configuredAdapterKey }),
        } : {
          upstreamAvailable,
          healthStatus,
          lastSyncedAt: new Date(),
          ...(item.capabilities && !preservesConfiguredRouteCapabilities(existingRoute.metadata)
            ? { capabilitiesOverride: item.capabilities }
            : {}),
          metadata: refreshedRouteMetadata(existingRoute.metadata, item.metadata),
        },
      });
      if (!configuredAdapterKey && await updateMappedRouteCost(prisma, existingRoute, item.cost)) {
        costChanges += 1;
        changes.push({
          kind: 'COST_CHANGED',
          providerId: provider.id,
          providerName: provider.name,
          upstreamModelId: item.upstreamModelId,
          canonicalModelId: existingRoute.canonicalModelId,
          before: existingRoute.costProfile,
          after: item.cost,
        });
      }
      const currentRoute = !existingRoute.canonicalModelId
        ? await prisma.aiModelRoute.findUnique({
          where: { id: existingRoute.id },
          select: { canonicalModelId: true },
        })
        : existingRoute;
      if (currentRoute && !currentRoute.canonicalModelId) {
        const knownDiscovery = await prisma.aiUpstreamDiscovery.findUnique({
          where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
        });
        await prisma.aiUpstreamDiscovery.upsert({
          where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
          create: {
            provider: provider.kind,
            channelId: provider.id,
            upstreamModelId: item.upstreamModelId,
            suggestedModality: item.modality,
            availability: item.availability,
            ...(item.capabilities ? { capabilities: item.capabilities } : {}),
            ...(item.context ? { context: item.context } : {}),
            ...(item.resolution ? { resolution: item.resolution } : {}),
            ...(item.duration ? { duration: item.duration } : {}),
            ...(item.cost ? { discoveredCost: item.cost } : {}),
            metadata: item.metadata,
            status: 'UNMAPPED',
          },
          update: {
            suggestedModality: item.modality,
            availability: item.availability,
            ...(item.capabilities ? { capabilities: item.capabilities } : {}),
            ...(item.context ? { context: item.context } : {}),
            ...(item.resolution ? { resolution: item.resolution } : {}),
            ...(item.duration ? { duration: item.duration } : {}),
            ...(item.cost ? { discoveredCost: item.cost } : {}),
            metadata: item.metadata,
            lastSyncedAt: new Date(),
          },
        });
        if (!knownDiscovery) {
          newModels += 1;
          changes.push({
            kind: 'NEW_MODEL',
            providerId: provider.id,
            providerName: provider.name,
            upstreamModelId: item.upstreamModelId,
            canonicalModelId: null,
            before: null,
            after: item.cost,
          });
        }
        unmapped += 1;
      } else {
        mapped += 1;
      }
      continue;
    }
    const canonical = await confirmedMappedModel(prisma, provider, item);
    if (canonical) {
      const route = await prisma.aiModelRoute.create({
        data: {
          canonicalModelId: canonical.id,
          provider: provider.kind,
          channelId: provider.id,
          upstreamModelId: item.upstreamModelId,
          // A newly discovered route is never put into production automatically.
          enabled: false,
          priority: provider.priority,
          healthStatus,
          upstreamAvailable,
          lastSyncedAt: new Date(),
          ...(configuredAdapterKey ? { adapterKey: configuredAdapterKey } : {}),
          ...(item.cost ? { costProfile: item.cost } : {}),
          ...(item.capabilities ? { capabilitiesOverride: item.capabilities } : {}),
          metadata: item.metadata,
          pricingSyncStatus: item.cost ? 'OK' : 'WARNING_COST_UNAVAILABLE',
          ...(item.cost ? { costUpdatedAt: new Date() } : {}),
        },
      });
      if (item.cost) {
        await prisma.aiRouteCostHistory.create({
          data: { routeId: route.id, costProfile: item.cost, pricingSyncStatus: 'OK' },
        });
        await refreshSuggestedPriceForModel(prisma, canonical.id);
      }
      const knownDiscovery = await prisma.aiUpstreamDiscovery.findUnique({
        where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
      });
      await prisma.aiUpstreamDiscovery.upsert({
        where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
        create: {
          provider: provider.kind,
          channelId: provider.id,
          upstreamModelId: item.upstreamModelId,
          suggestedModality: item.modality,
          availability: item.availability,
          ...(item.capabilities ? { capabilities: item.capabilities } : {}),
          ...(item.context ? { context: item.context } : {}),
          ...(item.resolution ? { resolution: item.resolution } : {}),
          ...(item.duration ? { duration: item.duration } : {}),
          ...(item.cost ? { discoveredCost: item.cost } : {}),
          metadata: item.metadata,
          status: 'MAPPED',
          suggestedModelId: canonical.id,
        },
        update: {
          availability: item.availability,
          ...(item.cost ? { discoveredCost: item.cost } : {}),
          metadata: item.metadata,
          status: 'MAPPED',
          suggestedModelId: canonical.id,
          lastSyncedAt: new Date(),
        },
      });
      if (!knownDiscovery) {
        newModels += 1;
        changes.push({
          kind: 'NEW_MODEL',
          providerId: provider.id,
          providerName: provider.name,
          upstreamModelId: item.upstreamModelId,
          canonicalModelId: canonical.id,
          before: null,
          after: item.cost,
        });
      }
      mapped += 1;
      continue;
    }
    const knownDiscovery = await prisma.aiUpstreamDiscovery.findUnique({
      where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
    });
    await prisma.aiUpstreamDiscovery.upsert({
      where: { channelId_upstreamModelId: { channelId: provider.id, upstreamModelId: item.upstreamModelId } },
      create: {
        provider: provider.kind,
        channelId: provider.id,
        upstreamModelId: item.upstreamModelId,
        suggestedModality: item.modality,
        availability: item.availability,
        ...(item.capabilities ? { capabilities: item.capabilities } : {}),
        ...(item.context ? { context: item.context } : {}),
        ...(item.resolution ? { resolution: item.resolution } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.cost ? { discoveredCost: item.cost } : {}),
        metadata: item.metadata,
        status: 'UNMAPPED',
      },
      update: {
        suggestedModality: item.modality,
        availability: item.availability,
        ...(item.capabilities ? { capabilities: item.capabilities } : {}),
        ...(item.context ? { context: item.context } : {}),
        ...(item.resolution ? { resolution: item.resolution } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.cost ? { discoveredCost: item.cost } : {}),
        metadata: item.metadata,
        lastSyncedAt: new Date(),
        // Keep an administrator's IGNORED decision; otherwise remain UNMAPPED.
      },
    });
    if (!knownDiscovery) {
      newModels += 1;
      changes.push({
        kind: 'NEW_MODEL',
        providerId: provider.id,
        providerName: provider.name,
        upstreamModelId: item.upstreamModelId,
        canonicalModelId: null,
        before: null,
        after: item.cost,
      });
    }
    unmapped += 1;
  }
  return {
    providerId: provider.id,
    provider: provider.kind,
    discovered: models.length,
    mapped,
    unmapped,
    newModels,
    costChanges,
    statusChanges,
    changes,
  };
}

export async function syncAllUpstreamModels(prisma: PrismaClient) {
  const providers = await prisma.aiProviderChannel.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  const results: Array<Awaited<ReturnType<typeof syncUpstreamModels>>> = [];
  const failures: Array<{ providerId: string; name: string; message: string }> = [];
  for (let index = 0; index < providers.length; index += 4) {
    const batch = providers.slice(index, index + 4);
    const settled = await Promise.allSettled(batch.map(provider => syncUpstreamModels(prisma, provider.id)));
    settled.forEach((result, resultIndex) => {
      const provider = batch[resultIndex]!;
      if (result.status === 'fulfilled') results.push(result.value);
      else failures.push({
        providerId: provider.id,
        name: provider.name,
        message: result.reason instanceof Error ? result.reason.message : 'Sync failed',
      });
    });
  }
  const total = (key: 'discovered' | 'mapped' | 'unmapped' | 'newModels' | 'costChanges' | 'statusChanges') => (
    results.reduce((sum, result) => sum + result[key], 0)
  );
  return {
    providers: providers.length,
    succeededProviders: results.length,
    failedProviders: failures.length,
    discovered: total('discovered'),
    mapped: total('mapped'),
    unmapped: total('unmapped'),
    newModels: total('newModels'),
    costChanges: total('costChanges'),
    statusChanges: total('statusChanges'),
    changes: results.flatMap(result => result.changes),
    failures,
  };
}

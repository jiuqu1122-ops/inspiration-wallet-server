import type { AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../providers/url.js';
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

function providerModalityHints(provider: AiProviderChannel) {
  const hints: AiModality[] = [];
  if (provider.capabilities.some(capability => capability === 'LLM' || capability === 'VISION')) hints.push('chat');
  if (provider.capabilities.some(capability => capability.startsWith('IMAGE'))) hints.push('image');
  if (provider.capabilities.some(capability => capability.startsWith('VIDEO'))) hints.push('video');
  return hints;
}

function suggestedModality(provider: AiProviderChannel, id: string): AiModality | null {
  const hints = providerModalityHints(provider);
  const token = catalogAliasKey(id);
  // This is advisory only. It never maps or opens a model.
  // Model discovery must not be constrained by the legacy channel enum: a
  // newly launched model may not have a matching enum value yet.
  if (/(?:image|imagen|img|banana|flux|dalle|recraft)/.test(token)) return 'image';
  if (/(?:video|sora|veo|kling|seedance|minimaxh3)/.test(token)) return 'video';
  if (hints.length === 1) return hints[0]!;
  return hints.includes('chat') ? 'chat' : null;
}

function preservesConfiguredRouteCapabilities(metadata: unknown) {
  const source = objectValue(metadata)?.capabilitiesOverrideSource;
  return source === 'MANUAL' || source === 'INHERIT';
}

function refreshedRouteMetadata(current: unknown, discovered: Prisma.InputJsonValue) {
  if (!preservesConfiguredRouteCapabilities(current)) return discovered;
  return {
    ...(objectValue(current) ?? {}),
    ...(objectValue(discovered) ?? {}),
    capabilitiesOverrideSource: objectValue(current)?.capabilitiesOverrideSource,
  } as Prisma.InputJsonValue;
}

function normalizeModel(provider: AiProviderChannel, item: unknown): NormalizedUpstreamModel | null {
  const upstreamModelId = modelId(item);
  if (!upstreamModelId) return null;
  const record = objectValue(item) ?? {};
  const availableValue = record.available ?? record.enabled ?? record.active;
  const availability = availableValue === false
    ? 'UNAVAILABLE'
    : availableValue === true ? 'AVAILABLE' : 'UNKNOWN';
  return {
    provider: provider.kind,
    upstreamModelId,
    modality: suggestedModality(provider, upstreamModelId),
    availability,
    capabilities: jsonValue(record.capabilities),
    context: jsonValue(record.context ?? record.context_window ?? record.contextWindow),
    resolution: jsonValue(record.resolution ?? record.resolutions),
    duration: jsonValue(record.duration ?? record.durations),
    cost: jsonValue(record.cost ?? record.pricing ?? record.price),
    metadata: jsonValue({ raw: record, adapter: provider.kind === 'BIGMODEL' ? 'gemini' : 'openai' }) ?? {},
  };
}

async function fetchProviderJson(provider: AiProviderChannel, path: string) {
  await assertPublicProviderUrl(provider.baseUrl);
  const secrets = decryptProviderSecrets(provider.encryptedSecrets);
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${secrets.apiKey}`,
    'user-agent': 'Inspiration-Wallet-Server/1',
  });
  headers.set('x-goog-api-key', secrets.apiKey);
  for (const [name, value] of Object.entries(secrets.headers)) headers.set(name, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(providerEndpoint(provider.baseUrl, path), {
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Upstream model sync failed with HTTP ${response.status}`);
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
    const candidates = Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models) ? root.models
        : Array.isArray(value) ? value : [];
    return candidates
      .map(item => normalizeModel(provider, item))
      .filter((item): item is NormalizedUpstreamModel => item !== null)
      .filter((item, index, all) => all.findIndex(other => other.upstreamModelId === item.upstreamModelId) === index)
      .slice(0, 1000);
  }
}

const openAiAdapter = new JsonModelAdapter('/v1/models');
const geminiAdapter = new JsonModelAdapter('/v1beta/models');

export function upstreamAdapterFor(provider: AiProviderChannel): UpstreamModelAdapter {
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
  const modalities = item.modality ? [item.modality] : providerModalityHints(provider);
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
    const existingRoute = await prisma.aiModelRoute.findFirst({
      where: { provider: provider.kind, channelId: provider.id, upstreamModelId: item.upstreamModelId },
    });
    if (existingRoute) {
      if (existingRoute.upstreamAvailable !== (item.availability !== 'UNAVAILABLE')
        || existingRoute.healthStatus !== (item.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'HEALTHY')) {
        statusChanges += 1;
        changes.push({
          kind: 'STATUS_CHANGED',
          providerId: provider.id,
          providerName: provider.name,
          upstreamModelId: item.upstreamModelId,
          canonicalModelId: existingRoute.canonicalModelId,
          before: existingRoute.healthStatus,
          after: item.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'HEALTHY',
        });
      }
      await prisma.aiModelRoute.update({
        where: { id: existingRoute.id },
        data: {
          upstreamAvailable: item.availability !== 'UNAVAILABLE',
          healthStatus: item.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'HEALTHY',
          lastSyncedAt: new Date(),
          ...(item.capabilities && !preservesConfiguredRouteCapabilities(existingRoute.metadata)
            ? { capabilitiesOverride: item.capabilities }
            : {}),
          metadata: refreshedRouteMetadata(existingRoute.metadata, item.metadata),
        },
      });
      if (await updateMappedRouteCost(prisma, existingRoute, item.cost)) {
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
      if (!existingRoute.canonicalModelId) {
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
            status: 'UNMAPPED',
            suggestedModelId: null,
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
          healthStatus: item.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'HEALTHY',
          upstreamAvailable: item.availability !== 'UNAVAILABLE',
          lastSyncedAt: new Date(),
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

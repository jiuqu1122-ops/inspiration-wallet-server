import { Prisma, type PrismaClient } from '@prisma/client';
import {
  defaultChatPricingConfig,
  type ChatModelCreditPrice,
} from './chat-pricing.js';
import {
  defaultAiPricingConfig,
  imagePricingModelToken,
  videoPricingModelToken,
  type ImageModelCreditPrice,
  type VideoModelCreditPrice,
} from './pricing.js';
import {
  EXPLICIT_LEGACY_ALIASES,
  canonicalDisplayName,
  catalogAliasKey,
  catalogDelegateAvailable,
  defaultModelCapabilities,
  explicitCanonicalModelKey,
  safeCanonicalModelKey,
  type AiModality,
} from './model-catalog.js';
import {
  chatPriceToCatalogProfile,
  imagePriceToCatalogProfile,
  videoPriceToCatalogProfile,
  type CatalogPricingProfile,
  toInputJson,
} from './pricing-center.js';
import { ensureDefaultUsageModelBindings } from './usage-model-binding.js';

type CatalogTransaction = Prisma.TransactionClient;

type SeedModel = {
  canonicalModelKey: string;
  displayName: string;
  modality: AiModality;
  billingType: string;
  capabilities: Prisma.InputJsonValue;
  pricing: CatalogPricingProfile;
  aliases: string[];
  sortOrder: number;
};

const bootstrapPromises = new WeakMap<object, Promise<boolean>>();

function canonicalKeyForLegacy(model: string, modality: AiModality) {
  if (modality === 'image') {
    const token = imagePricingModelToken(model);
    if (token === 'nanobananapro') return 'nano-banana-pro';
    if (token === 'nanobananaprofast') return 'nano-banana-pro-fast';
    if (token === 'nanobanana2') return 'nano-banana-2';
    if (token === 'nanobanana2fast') return 'nano-banana-2-fast';
    if (token === 'image2') return 'image2';
  }
  if (modality === 'video') {
    const token = videoPricingModelToken(model);
    if (token === 'seedance2') return 'seedance-2';
    if (token === 'seedance2fast') return 'seedance-2-fast';
    if (token === 'minimaxh3') return 'minimax-h3';
  }
  return explicitCanonicalModelKey(modality, model) ?? safeCanonicalModelKey(model, modality);
}

function seedModels(
  chat: ChatModelCreditPrice[],
  images: ImageModelCreditPrice[],
  videos: VideoModelCreditPrice[],
) {
  const seeds = new Map<string, SeedModel>();
  const add = (
    model: string,
    modality: AiModality,
    pricing: CatalogPricingProfile,
    sortOrder: number,
  ) => {
    const canonicalModelKey = canonicalKeyForLegacy(model, modality);
    const key = `${modality}:${canonicalModelKey}`;
    const existing = seeds.get(key);
    const aliases = Array.from(new Set([...(existing?.aliases ?? []), model, canonicalModelKey]));
    seeds.set(key, {
      canonicalModelKey,
      displayName: canonicalDisplayName(canonicalModelKey, model),
      modality,
      billingType: String(pricing.billingType),
      capabilities: defaultModelCapabilities(canonicalModelKey, modality),
      pricing,
      aliases,
      sortOrder: existing?.sortOrder ?? sortOrder,
    });
  };
  chat.forEach((price, index) => add(price.model, 'chat', chatPriceToCatalogProfile(price), 10 + index * 10));
  images.forEach((price, index) => add(price.model, 'image', imagePriceToCatalogProfile(price), 100 + index * 10));
  videos.forEach((price, index) => add(price.model, 'video', videoPriceToCatalogProfile(price), 200 + index * 10));
  return Array.from(seeds.values());
}

async function ensureAlias(
  prisma: CatalogTransaction,
  modelId: string,
  modality: AiModality,
  alias: string,
  source: string,
) {
  const aliasKey = catalogAliasKey(alias);
  if (!aliasKey) return;
  await prisma.aiModelAlias.upsert({
    where: { modality_aliasKey: { modality, aliasKey } },
    create: { canonicalModelId: modelId, modality, alias, aliasKey, source, confirmed: true },
    update: {},
  });
}

async function ensurePrice(
  prisma: CatalogTransaction,
  modelId: string,
  pricing: CatalogPricingProfile,
) {
  const workspace = await prisma.aiModelPricing.findUnique({
    where: { canonicalModelId: modelId },
    include: { currentVersion: true },
  });
  if (workspace?.currentVersion) return;
  const latest = await prisma.aiPriceVersion.aggregate({
    where: { canonicalModelId: modelId },
    _max: { version: true },
  });
  const version = await prisma.aiPriceVersion.create({
    data: {
      canonicalModelId: modelId,
      version: (latest._max.version ?? 0) + 1,
      pricing: toInputJson(pricing),
      source: 'INITIAL_BOOTSTRAP',
    },
  });
  await prisma.aiModelPricing.upsert({
    where: { canonicalModelId: modelId },
    create: { canonicalModelId: modelId, currentVersionId: version.id },
    update: { currentVersionId: version.id, pendingPrice: Prisma.JsonNull },
  });
}

async function seedAstraCost(prisma: CatalogTransaction, modelId: string) {
  const existing = await prisma.aiModelRoute.findFirst({
    where: { canonicalModelId: modelId, provider: 'INITIAL_COST_SEED', upstreamModelId: 'gpt-6-astra' },
  });
  if (existing) return;
  const costProfile = {
    currency: 'CNY',
    contextThresholdTokens: 272000,
    standard: {
      upstreamInputCnyPer1m: '2.272727273',
      upstreamOutputCnyPer1m: '11.36363636',
      upstreamCacheReadCnyPer1m: '0.2272727273',
      upstreamCacheWriteCnyPer1m: '2.840909091',
    },
    extended: {
      upstreamInputCnyPer1m: '4.545454545',
      upstreamOutputCnyPer1m: '17.04545455',
      upstreamCacheReadCnyPer1m: '0.4545454545',
      upstreamCacheWriteCnyPer1m: '5.681818182',
    },
  } satisfies Prisma.InputJsonValue;
  const route = await prisma.aiModelRoute.upsert({
    where: { id: 'cost-seed-gpt-6-astra' },
    create: {
      id: 'cost-seed-gpt-6-astra',
      canonicalModelId: modelId,
      provider: 'INITIAL_COST_SEED',
      upstreamModelId: 'gpt-6-astra',
      enabled: false,
      upstreamAvailable: false,
      priority: 9999,
      healthStatus: 'UNVERIFIED',
      pricingSyncStatus: 'SEEDED',
      costProfile,
      costUpdatedAt: new Date(),
      metadata: { note: 'Cost seed only; an administrator must map an active provider route.' },
    },
    update: {},
  });
  await prisma.aiRouteCostHistory.upsert({
    where: { id: 'cost-seed-gpt-6-astra-v1' },
    create: {
      id: 'cost-seed-gpt-6-astra-v1',
      routeId: route.id,
      costProfile,
      pricingSyncStatus: 'SEEDED',
    },
    update: {},
  });
}

async function bootstrapEmptyCatalog(prisma: CatalogTransaction) {
  const chatPricing = defaultChatPricingConfig();
  const aiPricing = defaultAiPricingConfig();
  const seeds = seedModels(chatPricing.models, aiPricing.imageModels, aiPricing.videoModels);
  for (const seed of seeds) {
    const model = await prisma.aiModel.upsert({
      where: { canonicalModelKey: seed.canonicalModelKey },
      create: {
        canonicalModelKey: seed.canonicalModelKey,
        displayName: seed.displayName,
        modality: seed.modality,
        enabled: true,
        visible: true,
        sortOrder: seed.sortOrder,
        billingType: seed.billingType,
        routingMode: 'LEGACY',
        capabilities: seed.capabilities,
        status: 'PUBLISHED',
      },
      update: {},
    });
    for (const alias of seed.aliases) await ensureAlias(prisma, model.id, seed.modality, alias, 'INITIAL_BOOTSTRAP');
    await ensurePrice(prisma, model.id, seed.pricing);
    if (seed.canonicalModelKey === 'gpt-6-astra') await seedAstraCost(prisma, model.id);
  }
}

async function ensureCompatibilityAliases(prisma: CatalogTransaction) {
  for (const modality of ['chat', 'image', 'video'] as const) {
    for (const [aliasKey, canonicalModelKey] of Object.entries(EXPLICIT_LEGACY_ALIASES[modality])) {
      const model = await prisma.aiModel.findUnique({ where: { canonicalModelKey } });
      if (model) await ensureAlias(prisma, model.id, modality, aliasKey, 'EXPLICIT_COMPATIBILITY_MAP');
    }
  }
}

async function ensureCatalog(prisma: CatalogTransaction) {
  const modelCount = await prisma.aiModel.count();
  if (modelCount === 0) await bootstrapEmptyCatalog(prisma);
  await ensureCompatibilityAliases(prisma);
  await ensureDefaultUsageModelBindings(prisma);
  return true;
}

async function ensureCatalogTransaction(prisma: PrismaClient) {
  try {
    return await prisma.$transaction(
      transaction => ensureCatalog(transaction),
      { maxWait: 5_000, timeout: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    // Another application instance may have bootstrapped the same unique rows.
    // Retry once after that transaction has won the race.
    return prisma.$transaction(
      transaction => ensureCatalog(transaction),
      { maxWait: 5_000, timeout: 30_000 },
    );
  }
}

export async function ensureAiCatalogSeeded(prisma: PrismaClient) {
  if (!catalogDelegateAvailable(prisma)) return false;
  const cached = bootstrapPromises.get(prisma);
  if (cached) return cached;
  const operation = ensureCatalogTransaction(prisma).catch((error) => {
    bootstrapPromises.delete(prisma);
    throw error;
  });
  bootstrapPromises.set(prisma, operation);
  return operation;
}

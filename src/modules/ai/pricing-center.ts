import { Prisma, type PrismaClient } from '@prisma/client';
import { creditDecimal, serializeCredit } from '../wallets/credit-amount.js';
import type {
  ChatModelCreditPrice,
  ChatTokenRates,
  ChatTokenUsage,
} from './chat-pricing.js';
import type { ImageModelCreditPrice, VideoModelCreditPrice } from './pricing.js';
import { catalogDelegateAvailable, type AiModality } from './model-catalog.js';
import { env } from '../../config/env.js';

const CREDIT_SCALE = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

export type CatalogPricingProfile = Prisma.InputJsonObject & { billingType: string };

export const toInputJson = (value: unknown) => (
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
);

export type PricingSnapshot = {
  schemaVersion: 1;
  canonicalModelId: string;
  canonicalModelKey: string;
  modality: AiModality;
  routeId: string | null;
  priceVersionId: string;
  priceVersion: number;
  billingType: string;
  pricing: CatalogPricingProfile;
  request: Prisma.InputJsonObject;
  capturedAt: string;
};

export type ChargeBreakdown = {
  schemaVersion: 1;
  model: string;
  modality: AiModality;
  route: string | null;
  priceVersion: number;
  billingType: string;
  quantity: string;
  baseCharge: string;
  surcharges: Array<{ type: string; quantity: string; credits: string }>;
  totalCredits: string;
  details: Prisma.InputJsonObject;
};

const plainObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const creditPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?$/;

const scalarText = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  return '';
};

export function creditMicros(value: unknown) {
  const text = scalarText(value);
  if (!creditPattern.test(text)) throw new Error(`Invalid credit amount: ${text || '<empty>'}`);
  const [whole, fraction = ''] = text.split('.', 2);
  return BigInt(whole!) * CREDIT_SCALE + BigInt(fraction.padEnd(6, '0'));
}

export function microsToCredit(value: bigint) {
  if (value < 0n) throw new Error('Credit amount cannot be negative');
  return `${value / CREDIT_SCALE}.${(value % CREDIT_SCALE).toString().padStart(6, '0')}`;
}

const multiplyCredits = (value: unknown, count: bigint) => creditMicros(value) * count;

export function roundSuggestedPoints(rawPoints: number) {
  if (!Number.isFinite(rawPoints) || rawPoints < 0) throw new Error('Suggested price is invalid');
  const step = rawPoints < 10 ? 1 : rawPoints < 50 ? 5 : rawPoints < 250 ? 10 : rawPoints < 1000 ? 25 : 50;
  // Provider costs are often repeating decimals (for example 25 / 11). Treat
  // tiny representation/rounding noise at a step boundary as that boundary.
  const tolerance = Math.max(1e-9, Math.abs(rawPoints) * 1e-9);
  return String(Math.ceil((rawPoints - tolerance) / step) * step);
}

export function chatPriceToCatalogProfile(price: ChatModelCreditPrice): CatalogPricingProfile {
  if (price.billingMode === 'request') {
    return { billingType: 'request', creditsPerRequest: price.creditsPerRequest };
  }
  return {
    billingType: 'token',
    contextThresholdTokens: price.contextThresholdTokens,
    standard: price.standard,
    extended: price.extended,
  };
}

export function imagePriceToCatalogProfile(price: ImageModelCreditPrice): CatalogPricingProfile {
  return {
    billingType: 'image_resolution',
    creditsPerImageByResolution: {
      ...(price.credits1k !== undefined ? { '1k': price.credits1k } : {}),
      '2k': price.credits2k,
      '4k': price.credits4k,
    },
  };
}

export function videoPriceToCatalogProfile(price: VideoModelCreditPrice): CatalogPricingProfile {
  const pricing = Object.fromEntries(
    Object.entries(price).filter(([key, value]) => key !== 'model' && value !== undefined),
  ) as Prisma.InputJsonObject;
  const billingType = price.creditsByResolution
    ? 'video_resolution_duration'
    : price.creditsByDuration ? 'video_duration'
      : price.creditsPerVideo ? 'video_flat'
        : 'video_second';
  return { billingType, ...pricing };
}

export function catalogProfileToChatPrice(
  model: string,
  profile: CatalogPricingProfile,
): ChatModelCreditPrice | null {
  const creditsPerRequest = scalarText(profile.creditsPerRequest);
  if (profile.billingType === 'request' && creditPattern.test(creditsPerRequest)) {
    return { model, billingMode: 'request', creditsPerRequest };
  }
  const parseRates = (value: unknown): ChatTokenRates | null => {
    const rates = plainObject(value);
    if (!rates) return null;
    const inputCreditsPerMillion = scalarText(rates.inputCreditsPerMillion);
    const outputCreditsPerMillion = scalarText(rates.outputCreditsPerMillion);
    const cachedInputCreditsPerMillion = scalarText(rates.cachedInputCreditsPerMillion);
    const cacheWriteCreditsPerMillion = scalarText(rates.cacheWriteCreditsPerMillion);
    if (![inputCreditsPerMillion, outputCreditsPerMillion, cachedInputCreditsPerMillion, cacheWriteCreditsPerMillion]
      .every(rate => creditPattern.test(rate))) return null;
    return {
      inputCreditsPerMillion,
      outputCreditsPerMillion,
      cachedInputCreditsPerMillion,
      cacheWriteCreditsPerMillion,
    };
  };
  const standard = parseRates(profile.standard);
  const extended = parseRates(profile.extended);
  const threshold = Number(profile.contextThresholdTokens);
  if (profile.billingType !== 'token'
    || !standard
    || !extended
    || !Number.isSafeInteger(threshold)
    || threshold < 1
    || threshold > 10_000_000) return null;
  return { model, billingMode: 'token', contextThresholdTokens: threshold, standard, extended };
}

export function catalogProfileToImagePrice(
  model: string,
  profile: CatalogPricingProfile,
): ImageModelCreditPrice | null {
  const prices = profile.billingType === 'image_resolution'
    ? plainObject(profile.creditsPerImageByResolution)
    : profile.billingType === 'image_count'
      ? { '1k': profile.creditsPerImage, '2k': profile.creditsPerImage, '4k': profile.creditsPerImage }
      : profile.billingType === 'image_flat'
        ? { '1k': profile.creditsPerRequest, '2k': profile.creditsPerRequest, '4k': profile.creditsPerRequest }
        : null;
  if (!prices) return null;
  const credits2k = scalarText(prices['2k']);
  const credits4k = scalarText(prices['4k']);
  if (!creditPattern.test(credits2k) || !creditPattern.test(credits4k)) return null;
  const credits1k = scalarText(prices['1k']);
  return {
    model,
    ...(creditPattern.test(credits1k) ? { credits1k } : {}),
    credits2k,
    credits4k,
  };
}

export function catalogProfileToVideoPrice(
  model: string,
  profile: CatalogPricingProfile,
): VideoModelCreditPrice | null {
  if (!['video_second', 'video_flat', 'video_duration', 'video_resolution_duration'].includes(profile.billingType)) return null;
  const creditsPerSecond = scalarText(profile.creditsPerSecond ?? profile.credits);
  const creditsPerVideo = scalarText(profile.creditsPerVideo);
  const normalizedMaps: Partial<Record<'creditsByDuration' | 'creditsByResolution' | 'creditsByCount' | 'creditsByInputMode' | 'referenceVideoCreditsByResolution', Record<string, string>>> = {};
  for (const key of ['creditsByDuration', 'creditsByResolution', 'creditsByCount', 'creditsByInputMode', 'referenceVideoCreditsByResolution'] as const) {
    if (profile[key] === undefined) continue;
    const value = plainObject(profile[key]);
    if (!value) return null;
    const entries = Object.entries(value).map(([name, amount]) => [name.trim().toLowerCase(), scalarText(amount)] as const);
    if (entries.length === 0 || entries.some(([name, amount]) => !name || !creditPattern.test(amount))) return null;
    normalizedMaps[key] = Object.fromEntries(entries);
  }
  const validSecond = creditPattern.test(creditsPerSecond);
  const validVideo = creditPattern.test(creditsPerVideo);
  if (profile.billingType === 'video_second' && !validSecond) return null;
  if (profile.billingType === 'video_flat' && !validVideo && !creditPattern.test(scalarText(profile.credits))) return null;
  if (profile.billingType === 'video_duration' && !normalizedMaps.creditsByDuration && !validSecond) return null;
  if (profile.billingType === 'video_resolution_duration' && !normalizedMaps.creditsByResolution) return null;
  const credits = validSecond
    ? creditsPerSecond
    : validVideo ? creditsPerVideo : scalarText(profile.credits) || '0';
  const output: VideoModelCreditPrice = { model, credits };
  for (const key of ['creditsPerSecond', 'creditsPerVideo', 'creditsPerExtraReferenceImage', 'creditsPerReferenceVideoSecond'] as const) {
    const value = scalarText(profile[key]);
    if (creditPattern.test(value)) output[key] = value;
  }
  for (const key of ['creditsByDuration', 'creditsByResolution', 'creditsByCount', 'referenceVideoCreditsByResolution'] as const) {
    if (normalizedMaps[key]) output[key] = normalizedMaps[key];
  }
  if (typeof profile.includedReferenceImages === 'number'
    && Number.isSafeInteger(profile.includedReferenceImages)
    && profile.includedReferenceImages >= 0) {
    output.includedReferenceImages = Number(profile.includedReferenceImages);
  }
  return output;
}

export function validatePricingProfile(modality: AiModality, profile: unknown): CatalogPricingProfile {
  const pricing = plainObject(profile);
  if (!pricing || typeof pricing.billingType !== 'string') throw new Error('Pricing profile is invalid');
  if (modality === 'chat') {
    if (!catalogProfileToChatPrice('validation', pricing as CatalogPricingProfile)) throw new Error('Chat pricing profile is invalid');
  } else if (modality === 'image') {
    if (!catalogProfileToImagePrice('validation', pricing as CatalogPricingProfile)) throw new Error('Image pricing profile is invalid');
  } else if (!catalogProfileToVideoPrice('validation', pricing as CatalogPricingProfile)) {
    throw new Error('Video pricing profile is invalid');
  }
  return pricing as CatalogPricingProfile;
}

export async function capturePricingSnapshot(
  prisma: PrismaClient,
  model: { id: string; canonicalModelKey: string; modality: string; billingType: string },
  routeId: string | null,
  request: Prisma.InputJsonObject,
): Promise<PricingSnapshot> {
  const pricing = await prisma.aiModelPricing.findUnique({
    where: { canonicalModelId: model.id },
    include: { currentVersion: true },
  });
  if (!pricing?.currentVersion) throw new Error(`Published pricing is missing for ${model.canonicalModelKey}`);
  const profile = validatePricingProfile(model.modality as AiModality, pricing.currentVersion.pricing);
  if (profile.billingType !== model.billingType) {
    throw new Error(`Published billing type does not match ${model.canonicalModelKey}`);
  }
  return {
    schemaVersion: 1,
    canonicalModelId: model.id,
    canonicalModelKey: model.canonicalModelKey,
    modality: model.modality as AiModality,
    routeId,
    priceVersionId: pricing.currentVersion.id,
    priceVersion: pricing.currentVersion.version,
    billingType: model.billingType,
    pricing: structuredClone(profile),
    request: structuredClone(request),
    capturedAt: new Date().toISOString(),
  };
}

function imageCharge(snapshot: PricingSnapshot, generatedCount?: number): ChargeBreakdown {
  const prices = plainObject(snapshot.pricing.creditsPerImageByResolution) ?? {};
  const resolution = (scalarText(snapshot.request.resolution) || '2k').toLowerCase();
  const requestedCount = Math.max(1, Math.floor(Number(snapshot.request.count) || 1));
  const count = generatedCount === undefined
    ? requestedCount
    : Math.max(0, Math.min(requestedCount, Math.floor(generatedCount)));
  const isFlat = snapshot.pricing.billingType === 'image_flat';
  const unit = isFlat
    ? snapshot.pricing.creditsPerRequest
    : snapshot.pricing.billingType === 'image_count'
      ? snapshot.pricing.creditsPerImage
      : prices[resolution] ?? prices['2k'];
  const total = isFlat ? creditMicros(unit) : multiplyCredits(unit, BigInt(count));
  return {
    schemaVersion: 1,
    model: snapshot.canonicalModelKey,
    modality: 'image',
    route: snapshot.routeId,
    priceVersion: snapshot.priceVersion,
    billingType: snapshot.billingType,
    quantity: isFlat ? '1' : String(count),
    baseCharge: microsToCredit(total),
    surcharges: [],
    totalCredits: microsToCredit(total),
    details: {
      resolution,
      requestedCount,
      generatedCount: count,
      ...(isFlat
        ? { creditsPerRequest: microsToCredit(creditMicros(unit)) }
        : { creditsPerImage: microsToCredit(creditMicros(unit)) }),
    },
  };
}

function videoCharge(snapshot: PricingSnapshot): ChargeBreakdown {
  const pricing = snapshot.pricing;
  const duration = Math.max(1, Math.ceil(Number(snapshot.request.duration) || 15));
  const count = Math.max(1, Math.ceil(Number(snapshot.request.count) || 1));
  const resolution = (scalarText(snapshot.request.resolution) || '720p').toLowerCase();
  const imageCount = Math.max(0, Math.floor(Number(snapshot.request.referenceImageCount) || 0));
  const videoCount = Math.max(0, Math.floor(Number(snapshot.request.referenceVideoCount) || 0));
  const byDuration = plainObject(pricing.creditsByDuration) ?? {};
  const byResolution = plainObject(pricing.creditsByResolution) ?? {};
  const byCount = plainObject(pricing.creditsByCount) ?? {};
  const byInputMode = plainObject(pricing.creditsByInputMode) ?? {};
  const referenceByResolution = plainObject(pricing.referenceVideoCreditsByResolution) ?? {};
  const referenceResolution = (scalarText(snapshot.request.referenceVideoResolution) || resolution).toLowerCase();
  const inputMode = (scalarText(snapshot.request.inputMode) || 'REF').toUpperCase();
  const countOverride = byCount[String(count)];
  const perSecond = pricing.creditsPerSecond ?? pricing.credits ?? '0';
  const durationBase = byDuration[String(duration)] === undefined
    ? multiplyCredits(perSecond, BigInt(duration))
    : creditMicros(byDuration[String(duration)]);
  const perVideo = creditMicros(pricing.creditsPerVideo ?? '0');
  const inputModeCharge = creditMicros(byInputMode[inputMode.toLowerCase()] ?? byInputMode[inputMode] ?? '0');
  const resolutionCharge = multiplyCredits(byResolution[resolution] ?? '0', BigInt(duration));
  const outputBase = countOverride === undefined
    ? (durationBase + perVideo + inputModeCharge + resolutionCharge) * BigInt(count)
    : creditMicros(countOverride);
  const includedImages = Math.max(0, Math.floor(Number(pricing.includedReferenceImages) || 0));
  const extraImages = Math.max(0, imageCount - includedImages);
  const imageSurcharge = multiplyCredits(pricing.creditsPerExtraReferenceImage ?? '0', BigInt(extraImages * count));
  const referenceVideoRate = creditMicros(pricing.creditsPerReferenceVideoSecond ?? '0')
    + creditMicros(referenceByResolution[referenceResolution] ?? '0');
  const referenceVideoSeconds = Math.max(
    0,
    Math.ceil(Number(snapshot.request.referenceVideoSeconds) || videoCount * duration),
  );
  const videoSurcharge = referenceVideoRate * BigInt(referenceVideoSeconds * count);
  const total = outputBase + imageSurcharge + videoSurcharge;
  const surcharges: ChargeBreakdown['surcharges'] = [];
  if (imageSurcharge > 0n) surcharges.push({ type: 'extra_reference_images', quantity: String(extraImages * count), credits: microsToCredit(imageSurcharge) });
  if (videoSurcharge > 0n) surcharges.push({ type: 'reference_video_seconds', quantity: String(referenceVideoSeconds * count), credits: microsToCredit(videoSurcharge) });
  return {
    schemaVersion: 1,
    model: snapshot.canonicalModelKey,
    modality: 'video',
    route: snapshot.routeId,
    priceVersion: snapshot.priceVersion,
    billingType: snapshot.billingType,
    quantity: String(count),
    baseCharge: microsToCredit(outputBase),
    surcharges,
    totalCredits: microsToCredit(total),
    details: { duration, resolution, count, inputMode, referenceImageCount: imageCount, referenceVideoCount: videoCount, referenceVideoSeconds, referenceVideoResolution: referenceResolution },
  };
}

function chatCharge(snapshot: PricingSnapshot, usage?: ChatTokenUsage | null): ChargeBreakdown {
  const pricing = snapshot.pricing;
  const usageContext = scalarText(snapshot.request.usageContext);
  if (usageContext === 'canvas_text_agent') {
    const total = creditMicros(snapshot.request.fallbackCredits ?? '0');
    return {
      schemaVersion: 1,
      model: snapshot.canonicalModelKey,
      modality: 'chat',
      route: snapshot.routeId,
      priceVersion: snapshot.priceVersion,
      billingType: 'request_fixed',
      quantity: '1',
      baseCharge: microsToCredit(total),
      surcharges: [],
      totalCredits: microsToCredit(total),
      details: { context: usageContext, usage: null },
    };
  }
  if (pricing.billingType === 'request') {
    const total = creditMicros(pricing.creditsPerRequest);
    return {
      schemaVersion: 1,
      model: snapshot.canonicalModelKey,
      modality: 'chat',
      route: snapshot.routeId,
      priceVersion: snapshot.priceVersion,
      billingType: 'request',
      quantity: '1',
      baseCharge: microsToCredit(total),
      surcharges: [],
      totalCredits: microsToCredit(total),
      details: { contextTier: 'request', usage: null },
    };
  }
  if (!usage) {
    const total = creditMicros(snapshot.request.fallbackCredits ?? '0');
    return {
      schemaVersion: 1,
      model: snapshot.canonicalModelKey,
      modality: 'chat',
      route: snapshot.routeId,
      priceVersion: snapshot.priceVersion,
      billingType: 'fallback',
      quantity: '1',
      baseCharge: microsToCredit(total),
      surcharges: [],
      totalCredits: microsToCredit(total),
      details: { fallbackReason: 'usage_missing', usage: null },
    };
  }
  const threshold = BigInt(Number(pricing.contextThresholdTokens));
  const tier = usage.inputTokens > threshold ? 'extended' : 'standard';
  const rates = plainObject(pricing[tier]);
  if (!rates) throw new Error('Chat pricing tier is missing');
  const cachedInput = usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;
  const normalInput = usage.inputTokens - cachedInput;
  const numerator = normalInput * creditMicros(rates.inputCreditsPerMillion)
    + cachedInput * creditMicros(rates.cachedInputCreditsPerMillion)
    + usage.cacheWriteTokens * creditMicros(rates.cacheWriteCreditsPerMillion)
    + usage.outputTokens * creditMicros(rates.outputCreditsPerMillion);
  // Keep the historical behavior: calculate all token components together and
  // truncate only beyond the wallet's 1e-6 credit precision.
  const total = numerator / TOKENS_PER_MILLION;
  return {
    schemaVersion: 1,
    model: snapshot.canonicalModelKey,
    modality: 'chat',
    route: snapshot.routeId,
    priceVersion: snapshot.priceVersion,
    billingType: 'token',
    quantity: (usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens).toString(),
    baseCharge: microsToCredit(total),
    surcharges: [],
    totalCredits: microsToCredit(total),
    details: {
      contextTier: tier,
      contextThresholdTokens: threshold.toString(),
      usage: {
        inputTokens: usage.inputTokens.toString(),
        normalInputTokens: normalInput.toString(),
        cachedInputTokens: cachedInput.toString(),
        cacheWriteTokens: usage.cacheWriteTokens.toString(),
        outputTokens: usage.outputTokens.toString(),
      },
      rates: toInputJson(rates),
    },
  };
}

export function calculateSnapshotCharge(
  snapshot: PricingSnapshot,
  options: { usage?: ChatTokenUsage | null; generatedCount?: number } = {},
) {
  if (snapshot.modality === 'chat') return chatCharge(snapshot, options.usage);
  if (snapshot.modality === 'image') return imageCharge(snapshot, options.generatedCount);
  return videoCharge(snapshot);
}

export function estimateSnapshotCredits(snapshot: PricingSnapshot) {
  if (snapshot.modality === 'chat' && snapshot.pricing.billingType === 'token') {
    return serializeCredit(creditDecimal(scalarText(snapshot.request.fallbackCredits) || '0'));
  }
  return calculateSnapshotCharge(snapshot).totalCredits;
}

export async function setPendingPrice(
  prisma: PrismaClient,
  canonicalModelKey: string,
  pricing: unknown,
) {
  const model = await prisma.aiModel.findUnique({ where: { canonicalModelKey } });
  if (!model) throw new Error('Canonical model was not found');
  const validated = validatePricingProfile(model.modality as AiModality, pricing);
  if (validated.billingType !== model.billingType) throw new Error('Pricing billing type does not match the canonical model');
  return prisma.aiModelPricing.upsert({
    where: { canonicalModelId: model.id },
    create: { canonicalModelId: model.id, pendingPrice: toInputJson(validated) },
    update: { pendingPrice: toInputJson(validated) },
    include: { currentVersion: true },
  });
}

export async function publishPendingPrice(
  prisma: PrismaClient,
  canonicalModelKey: string,
  publishedBy?: string,
) {
  return prisma.$transaction(
    transaction => publishPendingPriceTransaction(transaction, canonicalModelKey, publishedBy),
    { maxWait: 5_000, timeout: 30_000 },
  );
}

async function publishPendingPriceTransaction(
  transaction: Prisma.TransactionClient,
  canonicalModelKey: string,
  publishedBy?: string,
) {
  const model = await transaction.aiModel.findUnique({
    where: { canonicalModelKey },
    include: { pricing: { include: { currentVersion: true } } },
  });
  if (!model?.pricing?.pendingPrice) throw new Error('Pending price is missing');
  const pricing = validatePricingProfile(model.modality as AiModality, model.pricing.pendingPrice);
  if (pricing.billingType !== model.billingType) throw new Error('Pricing billing type does not match the canonical model');
  const latest = await transaction.aiPriceVersion.aggregate({
    where: { canonicalModelId: model.id },
    _max: { version: true },
  });
  const version = await transaction.aiPriceVersion.create({
    data: {
      canonicalModelId: model.id,
      version: (latest._max.version ?? 0) + 1,
      pricing: toInputJson(pricing),
      source: 'ADMIN_PUBLISH',
      ...(publishedBy ? { publishedBy } : {}),
    },
  });
  await transaction.aiModelPricing.update({
    where: { canonicalModelId: model.id },
    data: { currentVersionId: version.id, pendingPrice: Prisma.JsonNull },
  });
  return { model: model.canonicalModelKey, version: version.version, pricing: version.pricing };
}

export async function publishPendingPriceAndSyncLegacy(
  prisma: PrismaClient,
  canonicalModelKey: string,
  publishedBy?: string,
  onPublished?: (
    transaction: Prisma.TransactionClient,
    result: Awaited<ReturnType<typeof publishPendingPriceTransaction>>,
  ) => Promise<void>,
) {
  return prisma.$transaction(
    async (transaction) => {
      const result = await publishPendingPriceTransaction(transaction, canonicalModelKey, publishedBy);
      await syncLegacyPricingTablesFromCatalog(transaction as unknown as PrismaClient);
      if (onPublished) await onPublished(transaction, result);
      return result;
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
}

export async function legacyPricingFromCatalog(prisma: PrismaClient) {
  if (!catalogDelegateAvailable(prisma)) return null;
  const models = await prisma.aiModel.findMany({
    where: { status: 'PUBLISHED' },
    include: { pricing: { include: { currentVersion: true } } },
    orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
  });
  const imageModels: ImageModelCreditPrice[] = [];
  const videoModels: VideoModelCreditPrice[] = [];
  const chatModels: ChatModelCreditPrice[] = [];
  for (const model of models) {
    const raw = model.pricing?.currentVersion?.pricing;
    if (!raw) continue;
    const profile = raw as CatalogPricingProfile;
    if (model.modality === 'image') {
      const legacy = catalogProfileToImagePrice(model.canonicalModelKey, profile);
      if (legacy) imageModels.push(legacy);
    } else if (model.modality === 'video') {
      const legacy = catalogProfileToVideoPrice(model.canonicalModelKey, profile);
      if (legacy) videoModels.push(legacy);
    } else if (model.modality === 'chat') {
      const legacy = catalogProfileToChatPrice(model.canonicalModelKey, profile);
      if (legacy) chatModels.push(legacy);
    }
  }
  const updatedAt = models.reduce<Date | null>((latest, model) => {
    const candidate = model.pricing?.currentVersion?.publishedAt;
    return candidate && (!latest || candidate > latest) ? candidate : latest;
  }, null);
  return { imageModels, videoModels, chatModels, updatedAt: updatedAt?.toISOString() ?? null };
}

export async function syncLegacyPricingTablesFromCatalog(prisma: PrismaClient) {
  const legacy = await legacyPricingFromCatalog(prisma);
  if (!legacy) return false;
  const existing = await prisma.aiPricingConfig.findUnique({ where: { id: 'default' } });
  await prisma.aiPricingConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      agentRequestCredits: BigInt(env.AGENT_REQUEST_CREDITS),
      inspirationAnalysisCredits: 0n,
      canvasTextAgentCredits: 1n,
      imageDefaultCredits: BigInt(env.IMAGE_REQUEST_CREDITS),
      videoDefaultCredits: BigInt(env.VIDEO_REQUEST_CREDITS),
      imageModelPrices: legacy.imageModels,
      videoModelPrices: legacy.videoModels,
    },
    update: {
      // Global non-model prices remain owned by the legacy configuration.
      imageModelPrices: legacy.imageModels,
      videoModelPrices: legacy.videoModels,
      ...(existing ? {} : {
        agentRequestCredits: BigInt(env.AGENT_REQUEST_CREDITS),
        inspirationAnalysisCredits: 0n,
        canvasTextAgentCredits: 1n,
        imageDefaultCredits: BigInt(env.IMAGE_REQUEST_CREDITS),
        videoDefaultCredits: BigInt(env.VIDEO_REQUEST_CREDITS),
      }),
    },
  });
  await prisma.chatPricingConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', modelPrices: legacy.chatModels },
    update: { modelPrices: legacy.chatModels },
  });
  return true;
}

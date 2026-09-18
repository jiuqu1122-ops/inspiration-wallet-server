import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  ChatModelCreditPrice,
  ChatTokenRates,
  ChatTokenUsage,
} from './chat-pricing.js';
import type { ImageModelCreditPrice, VideoModelCreditPrice } from './pricing.js';
import {
  ModelCatalogError,
  catalogDelegateAvailable,
  isGptImage2CatalogIdentity,
  type AiModality,
} from './model-catalog.js';
import { env } from '../../config/env.js';
import { isFixedCanvasLlmUsageContext } from './usage-context.js';
import type { MembershipQuotaReservationSnapshot } from '../membership/quota-billing.js';

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
  membershipPlanId?: string;
  membershipPlanVersionId?: string;
  membershipId?: string;
  membershipQuota?: MembershipQuotaReservationSnapshot;
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

const membershipPriceKeys: Record<string, readonly string[]> = {
  canvas_text_agent: ['canvasTextAgent', 'canvas_text_agent'],
  workflow: ['workflow', 'workflowNode'],
  inspiration_analysis: ['inspirationAnalysis', 'inspiration_analysis'],
  // Ordinary Chat is catalog-priced (token or per-request). Keep legacy
  // Agent fields from changing its fallback reservation amount.
  chat: [],
};

type MembershipDiscountCategory = 'gptImage1K' | 'chat' | 'video' | 'other';

const membershipDiscountKeys: Record<MembershipDiscountCategory, readonly string[]> = {
  gptImage1K: ['gptImage1K', 'gpt_image_1k', 'gptImageOneK'],
  chat: ['chat'],
  video: ['video'],
  other: ['other'],
};

/**
 * Membership folds are represented as "折": 10 means the catalog price,
 * 5 means half price, and 0 means free.  Keep the value as fixed-point
 * credits so discounts never go through floating point arithmetic.
 */
function membershipDiscountFold(prices: Record<string, unknown> | null, category: MembershipDiscountCategory) {
  const discounts = plainObject(prices?.discounts);
  if (!discounts) return null;
  const value = membershipDiscountKeys[category]
    .map(key => scalarText(discounts[key]))
    .find(item => item.length > 0);
  if (value === undefined || !/^(?:0|[1-9](?:\.\d{1,6})?|10(?:\.0{1,6})?)$/.test(value)) return null;
  return creditMicros(value);
}

function applyMembershipFold(value: unknown, foldMicros: bigint) {
  const amount = creditMicros(value);
  return microsToCredit(amount * foldMicros / (10n * CREDIT_SCALE));
}

function scaleMembershipCredits(value: unknown, foldMicros: bigint, parentKey = '', creditContext = false): unknown {
  const nestedCreditContext = creditContext || /(?:credit|price)/i.test(parentKey);
  if (Array.isArray(value)) return value.map(item => scaleMembershipCredits(item, foldMicros, parentKey, nestedCreditContext));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      scaleMembershipCredits(item, foldMicros, key, nestedCreditContext),
    ]));
  }
  if (nestedCreditContext) {
    const text = scalarText(value);
    if (creditPattern.test(text)) return applyMembershipFold(text, foldMicros);
  }
  return value;
}

function membershipCategory(
  context: string | undefined,
  modality: AiModality,
  modelKey: string,
  request: Record<string, unknown>,
): MembershipDiscountCategory {
  if (context === 'canvas_text_agent' || context === 'workflow' || context === 'inspiration_analysis') return 'other';
  if (modality === 'chat' && (!context || context === 'chat')) return 'chat';
  if (modality === 'video') return 'video';
  const resolution = scalarText(request.resolution).toLowerCase();
  const modelToken = modelKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const isGptImageFamily = isGptImage2CatalogIdentity(modelKey)
    || modelToken.includes('gptimage')
    || modelToken.includes('image2');
  if (modality === 'image' && resolution === '1k' && isGptImageFamily) return 'gptImage1K';
  return 'other';
}

/** Resolve a plan-level fixed price for non-catalog agent tasks. */
export async function resolveMembershipContextCredits(
  prisma: PrismaClient,
  userId: string,
  context: string,
  fallback: unknown,
) {
  // Keep lightweight/legacy Prisma test doubles and pre-membership deployments safe.
  if (!prisma.userMembership) return microsToCredit(creditMicros(fallback));
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', startsAt: { lte: new Date() }, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
    select: { plan: { select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { prices: true } } } } },
  });
  const prices = plainObject(membership?.plan.versions[0]?.prices);
  const value = membershipPriceKeys[context]?.map((key) => scalarText(prices?.[key])).find((item) => creditPattern.test(item));
  const base = value === undefined ? creditMicros(fallback) : creditMicros(value);
  const fold = membershipDiscountFold(prices, membershipCategory(context, 'chat', '', {}));
  const resolvedMicros = fold === null ? base : base * fold / (10n * CREDIT_SCALE);
  // Public wallet balances and every reserve/settlement caller use decimal
  // credit units. Do not leak the internal 1e-6 fixed-point integer here:
  // returning 1_000_000n for one credit makes the caller reserve one million
  // credits instead of 1.000000.
  return microsToCredit(resolvedMicros);
}

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

const normalizedCapabilityResolutions = (capabilities: unknown) => {
  const source = plainObject(capabilities);
  if (!Array.isArray(source?.supportedResolutions)) return [];
  return Array.from(new Set(source.supportedResolutions
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)));
};

export function validatePricingCapabilities(
  modality: AiModality,
  profile: CatalogPricingProfile,
  capabilities: unknown,
) {
  const resolutions = normalizedCapabilityResolutions(capabilities);
  if (resolutions.length === 0) return profile;
  const priceMap = modality === 'image' && profile.billingType === 'image_resolution'
    ? plainObject(profile.creditsPerImageByResolution)
    : modality === 'video' && profile.billingType === 'video_resolution_duration'
      ? plainObject(profile.creditsByResolution)
      : null;
  if (!priceMap) return profile;
  const normalizedPrices = new Map(Object.entries(priceMap).map(([key, value]) => [key.trim().toLowerCase(), value]));
  const missing = resolutions.filter(resolution => {
    const value = scalarText(normalizedPrices.get(resolution));
    return !creditPattern.test(value);
  });
  if (missing.length > 0) {
    throw new Error(`Published pricing is missing for supported resolution: ${missing.join(', ')}`);
  }
  return profile;
}

export async function capturePricingSnapshot(
  prisma: PrismaClient,
  model: { id: string; canonicalModelKey: string; modality: string; billingType: string; capabilities?: unknown },
  routeId: string | null,
  request: Prisma.InputJsonObject,
  userId?: string,
): Promise<PricingSnapshot> {
  const pricing = await prisma.aiModelPricing.findUnique({
    where: { canonicalModelId: model.id },
    include: { currentVersion: true },
  });
  if (!pricing?.currentVersion) {
    throw new ModelCatalogError(
      'PRICING_NOT_AVAILABLE',
      `Published pricing is missing for ${model.canonicalModelKey}`,
      503,
    );
  }
  let profile: CatalogPricingProfile;
  try {
    profile = validatePricingCapabilities(
      model.modality as AiModality,
      validatePricingProfile(model.modality as AiModality, pricing.currentVersion.pricing),
      model.capabilities,
    );
  } catch (error) {
    throw new ModelCatalogError(
      'PRICING_NOT_AVAILABLE',
      error instanceof Error ? error.message : `Published pricing is invalid for ${model.canonicalModelKey}`,
      503,
    );
  }
  if (profile.billingType !== model.billingType) {
    throw new ModelCatalogError(
      'PRICING_NOT_AVAILABLE',
      `Published billing type does not match ${model.canonicalModelKey}`,
      503,
    );
  }
  let membershipPlanId: string | undefined;
  let membershipPlanVersionId: string | undefined;
  let membershipId: string | undefined;
  if (userId) {
    const membership = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE', startsAt: { lte: new Date() }, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
      include: { plan: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } },
    });
    const version = membership?.plan.versions[0];
    if (membership && version) {
      membershipId = membership.id;
      membershipPlanId = membership.planId;
      membershipPlanVersionId = version.id;
    }
    const rawPrices = plainObject(version?.prices);
    if (rawPrices) {
      const models = plainObject(rawPrices.models);
      const direct = models?.[model.canonicalModelKey] ?? models?.[model.id] ?? rawPrices[model.canonicalModelKey];
      const candidate = plainObject(direct) ?? rawPrices;
      let override: Record<string, unknown> | null = null;
      if (candidate.billingType || candidate.creditsPerRequest || candidate.creditsPerImage || candidate.creditsPerImageByResolution) {
        override = candidate;
      } else if (model.modality === 'image' && ['image1K', 'image2K', 'image4K', '1k', '2k', '4k'].some(key => candidate[key] !== undefined)) {
        const base = plainObject(profile.creditsPerImageByResolution) ?? {};
        override = {
          ...profile,
          creditsPerImageByResolution: {
            ...base,
            ...(candidate.image1K !== undefined || candidate['1k'] !== undefined ? { '1k': candidate.image1K ?? candidate['1k'] } : {}),
            ...(candidate.image2K !== undefined || candidate['2k'] !== undefined ? { '2k': candidate.image2K ?? candidate['2k'] } : {}),
            ...(candidate.image4K !== undefined || candidate['4k'] !== undefined ? { '4k': candidate.image4K ?? candidate['4k'] } : {}),
          },
        };
      } else if (model.modality === 'video' && (candidate.video !== undefined || candidate.videoPerSecond !== undefined || candidate.videoPerVideo !== undefined)) {
        const perVideo = scalarText(candidate.videoPerVideo);
        const perSecond = scalarText(candidate.videoPerSecond ?? candidate.video);
        override = profile.billingType === 'video_flat'
          ? { ...profile, creditsPerVideo: perVideo || perSecond, credits: perVideo || perSecond }
          : { ...profile, creditsPerSecond: perSecond || perVideo, credits: perSecond || perVideo };
      } else if (model.modality === 'chat' && profile.billingType === 'request' && candidate.agentRequest !== undefined) {
        override = { ...profile, billingType: 'request', creditsPerRequest: candidate.agentRequest };
      }
      if (override) {
        try {
          const validated = validatePricingProfile(model.modality as AiModality, override);
          if (validated.billingType === model.billingType) {
            profile = validated;
            membershipPlanId = membership?.planId;
            membershipPlanVersionId = version?.id;
          }
        } catch {
          // A malformed membership override must never make the base catalog unusable.
        }
      }
      const fold = membershipDiscountFold(
        rawPrices,
        membershipCategory(
          scalarText(request.usageContext),
          model.modality as AiModality,
          model.canonicalModelKey,
          request,
        ),
      );
      if (fold !== null) {
        try {
          const discounted = scaleMembershipCredits(profile, fold) as CatalogPricingProfile;
          profile = validatePricingProfile(model.modality as AiModality, discounted);
          membershipPlanId = membership?.planId;
          membershipPlanVersionId = version?.id;
        } catch {
          // A malformed membership discount must never make the base catalog unusable.
        }
      }
    }
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
    ...(membershipPlanId ? { membershipPlanId } : {}),
    ...(membershipPlanVersionId ? { membershipPlanVersionId } : {}),
    ...(membershipId ? { membershipId } : {}),
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

function videoCharge(snapshot: PricingSnapshot, generatedCount?: number): ChargeBreakdown {
  const pricing = snapshot.pricing;
  const duration = Math.max(1, Math.ceil(Number(snapshot.request.duration) || 15));
  const requestedCount = Math.max(1, Math.ceil(Number(snapshot.request.count) || 1));
  const count = generatedCount === undefined
    ? requestedCount
    : Math.max(0, Math.min(requestedCount, Math.floor(generatedCount)));
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
  const countOverride = count > 0 ? byCount[String(count)] : undefined;
  const perSecond = pricing.creditsPerSecond ?? pricing.credits ?? '0';
  const durationBase = byDuration[String(duration)] === undefined
    ? multiplyCredits(perSecond, BigInt(duration))
    : creditMicros(byDuration[String(duration)]);
  const perVideo = creditMicros(pricing.creditsPerVideo
    ?? (pricing.billingType === 'video_flat' ? pricing.credits : undefined)
    ?? '0');
  const inputModeCharge = creditMicros(byInputMode[inputMode.toLowerCase()] ?? byInputMode[inputMode] ?? '0');
  const resolutionCharge = multiplyCredits(byResolution[resolution] ?? '0', BigInt(duration));
  const outputBase = countOverride === undefined
    ? (pricing.billingType === 'video_flat'
      ? perVideo * BigInt(count)
      : (durationBase + perVideo + inputModeCharge + resolutionCharge) * BigInt(count))
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
    details: { duration, resolution, requestedCount, generatedCount: count, count, inputMode, referenceImageCount: imageCount, referenceVideoCount: videoCount, referenceVideoSeconds, referenceVideoResolution: referenceResolution },
  };
}

function chatCharge(snapshot: PricingSnapshot, usage?: ChatTokenUsage | null): ChargeBreakdown {
  const pricing = snapshot.pricing;
  const usageContext = scalarText(snapshot.request.usageContext);
  const serializedUsage = usage ? (() => {
    const cachedInputTokens = usage.cachedInputTokens > usage.inputTokens
      ? usage.inputTokens
      : usage.cachedInputTokens;
    return {
      inputTokens: usage.inputTokens.toString(),
      normalInputTokens: (usage.inputTokens - cachedInputTokens).toString(),
      cachedInputTokens: cachedInputTokens.toString(),
      cacheWriteTokens: usage.cacheWriteTokens.toString(),
      outputTokens: usage.outputTokens.toString(),
    };
  })() : null;
  if (isFixedCanvasLlmUsageContext(usageContext)) {
    const total = creditMicros(snapshot.request.fixedUsageCredits ?? snapshot.request.fallbackCredits ?? '0');
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
      details: { context: usageContext, usage: serializedUsage },
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
      details: { contextTier: 'request', usage: serializedUsage },
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
      usage: serializedUsage,
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
  return videoCharge(snapshot, options.generatedCount);
}

export function estimateSnapshotCredits(snapshot: PricingSnapshot) {
  if (snapshot.modality === 'chat'
    && isFixedCanvasLlmUsageContext(scalarText(snapshot.request.usageContext))) {
    // Canvas/workflow LLM nodes are sold at a fixed per-run price regardless
    // of whether the bound upstream model itself is token- or request-billed.
    // Reserve that fixed amount before contacting the provider so changing the
    // binding cannot change when (or whether) the wallet balance is checked.
    return calculateSnapshotCharge(snapshot).totalCredits;
  }
  if (snapshot.modality === 'chat' && snapshot.pricing.billingType === 'token') {
    // Token chats are post-billed after the provider returns token usage. The
    // fallback value is only used when usage metadata is missing; reserving it
    // up front makes a low-balance user fail even when the actual token charge
    // would fit in the wallet (and used to make membership discounts appear
    // to cause false INSUFFICIENT_CREDITS errors).
    const hasBillableRate = ['standard', 'extended'].some((tier) => {
      const rates = plainObject(snapshot.pricing[tier]);
      return rates ? Object.values(rates).some(value => {
        try { return creditMicros(value) > 0n; } catch { return false; }
      }) : false;
    });
    // Keep zero-priced Chat plans usable with an empty wallet while still
    // preventing non-free requests from reaching an upstream with no balance.
    return hasBillableRate ? '0.000001' : '0.000000';
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
  onPublished?: (
    transaction: Prisma.TransactionClient,
    result: Awaited<ReturnType<typeof publishPendingPriceTransaction>>,
  ) => Promise<void>,
) {
  return prisma.$transaction(
    async (transaction) => {
      const result = await publishPendingPriceTransaction(transaction, canonicalModelKey, publishedBy);
      if (onPublished) await onPublished(transaction, result);
      return result;
    },
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
  const pricing = validatePricingCapabilities(
    model.modality as AiModality,
    validatePricingProfile(model.modality as AiModality, model.pricing.pendingPrice),
    model.capabilities,
  );
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

export async function buildClientPricingProjection(prisma: PrismaClient) {
  const fallback = {
    agentRequestCredits: String(env.AGENT_REQUEST_CREDITS),
    inspirationAnalysisCredits: '1.000000',
    canvasTextAgentCredits: '1.000000',
    imageDefaultCredits: String(env.IMAGE_REQUEST_CREDITS),
    videoDefaultCredits: String(env.VIDEO_REQUEST_CREDITS),
    imageModels: [] as ImageModelCreditPrice[],
    videoModels: [] as VideoModelCreditPrice[],
    updatedAt: null as string | null,
  };
  if (!catalogDelegateAvailable(prisma)) return fallback;
  const [models, bindings] = await Promise.all([
    prisma.aiModel.findMany({
      where: { status: 'PUBLISHED' },
      include: { pricing: { include: { currentVersion: true } } },
      orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
    }),
    prisma.aiUsageModelBinding.findMany({
      where: { key: { in: ['IMAGE_ANALYSIS', 'CANVAS_TEXT'] } },
      select: { key: true, fixedCredits: true, updatedAt: true },
    }),
  ]);
  const imageModels: ImageModelCreditPrice[] = [];
  const videoModels: VideoModelCreditPrice[] = [];
  for (const model of models) {
    const raw = model.pricing?.currentVersion?.pricing;
    if (!raw) continue;
    const profile = raw as CatalogPricingProfile;
    if (model.modality === 'image') {
      const legacy = catalogProfileToImagePrice(model.canonicalModelKey, profile);
      if (legacy) imageModels.push(legacy);
    } else if (model.modality === 'video') {
      const legacy = catalogProfileToVideoPrice(model.canonicalModelKey, profile);
      if (legacy) {
        const supported = new Set(normalizedCapabilityResolutions(model.capabilities));
        const filterMap = (value: Record<string, string> | undefined) => {
          if (!value) return undefined;
          const entries = Object.entries(value)
            .filter(([key]) => supported.has(key.trim().toLowerCase()))
            .map(([key, amount]) => [key.trim().toLowerCase(), amount] as const);
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        };
        videoModels.push({
          ...legacy,
          creditsByResolution: filterMap(legacy.creditsByResolution),
          referenceVideoCreditsByResolution: filterMap(legacy.referenceVideoCreditsByResolution),
        });
      }
    }
  }
  const updatedAt = [...models.map(model => model.pricing?.currentVersion?.publishedAt ?? null), ...bindings.map(binding => binding.updatedAt)]
    .reduce<Date | null>((latest, candidate) => {
    return candidate && (!latest || candidate > latest) ? candidate : latest;
  }, null);
  const byKey = new Map(bindings.map(binding => [binding.key, binding]));
  return {
    ...fallback,
    inspirationAnalysisCredits: byKey.get('IMAGE_ANALYSIS')?.fixedCredits?.toFixed(6)
      ?? fallback.inspirationAnalysisCredits,
    canvasTextAgentCredits: byKey.get('CANVAS_TEXT')?.fixedCredits?.toFixed(6)
      ?? fallback.canvasTextAgentCredits,
    imageModels,
    videoModels,
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

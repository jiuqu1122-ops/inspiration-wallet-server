import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';

export type ImageModelCreditPrice = {
  model: string;
  credits1k?: string | undefined;
  credits2k: string;
  credits4k: string;
};

export type VideoModelCreditPrice = {
  model: string;
  /** Legacy per-second price. Kept for existing pricing records. */
  credits: string;
  creditsPerSecond?: string | undefined;
  creditsPerVideo?: string | undefined;
  /** Per-video override keyed by duration in seconds. */
  creditsByDuration?: Record<string, string> | undefined;
  /** Per-second surcharge keyed by output resolution. */
  creditsByResolution?: Record<string, string> | undefined;
  /** Exact request total keyed by requested output count. */
  creditsByCount?: Record<string, string> | undefined;
  /** Number of reference images included in the output price. */
  includedReferenceImages?: number | undefined;
  /** Per-image price after includedReferenceImages has been exceeded. */
  creditsPerExtraReferenceImage?: string | undefined;
  /** Base per-second price for each reference video. */
  creditsPerReferenceVideoSecond?: string | undefined;
  /** Per-second reference-video surcharge keyed by output resolution. */
  referenceVideoCreditsByResolution?: Record<string, string> | undefined;
};

export type VideoReferenceCreditInput = {
  imageCount?: number | undefined;
  videoCount?: number | undefined;
};

export type AiPricingConfigValue = {
  agentRequestCredits: string;
  inspirationAnalysisCredits: string;
  imageDefaultCredits: string;
  videoDefaultCredits: string;
  imageModels: ImageModelCreditPrice[];
  videoModels: VideoModelCreditPrice[];
  updatedAt: string | null;
};

export type AiPricingConfigInput = Omit<AiPricingConfigValue, 'updatedAt'>;

const DEFAULT_AGENT_REQUEST_CREDITS = BigInt(env.AGENT_REQUEST_CREDITS);
const DEFAULT_IMAGE_REQUEST_CREDITS = BigInt(env.IMAGE_REQUEST_CREDITS);
const DEFAULT_VIDEO_REQUEST_CREDITS = BigInt(env.VIDEO_REQUEST_CREDITS);
const DEFAULT_INSPIRATION_ANALYSIS_CREDITS = 0n;

const KNOWN_IMAGE_MODELS = [
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gpt-image-2',
  'Xais Nano Pro_2K',
  'Xais Nano Pro_4K',
  'Xais Nano2_2K',
  'Xais Nano2_4K',
  'Xais Img2_2K',
  'Xais Img2_4K',
  'Xais Img2_2K(高画质)',
  'Xais Img2_4K(高画质)',
] as const;

const KNOWN_VIDEO_MODELS = [
  'seedance2',
  'seedance2fast',
  'kling-video',
  'kling-omni-video',
  'MiniMax-H3',
] as const;

const CANONICAL_IMAGE_PRICING_MODELS = [
  'nano-banana-pro',
  'nano-banana-2',
  'nano-banana-pro-fast',
  'nano-banana-2-fast',
  'image2',
] as const;

export const aiPricingModelToken = (model: string) => model
  .trim()
  .toLowerCase()
  .replace(/高画质/g, 'highquality')
  .replace(/preview/g, '')
  .replace(/[^a-z0-9]+/g, '');

export const videoPricingModelToken = (model: string) => {
  const token = aiPricingModelToken(model);
  if (token === 'sourcemix20' || token === 'seedance20') return 'seedance2';
  if (token === 'sourcemix20fast' || token === 'seedance20fast') return 'seedance2fast';
  return token;
};

export const imagePricingModelToken = (model: string) => {
  const token = aiPricingModelToken(model);
  if (token.includes('nanobananaprofast')) return 'nanobananaprofast';
  if (token.includes('nanobanana2fast')) return 'nanobanana2fast';
  if (token.includes('nanobananapro') || token.includes('nanopro') || token.includes('gemini3proimage')) return 'nanobananapro';
  if (token.includes('nanobanana2') || token.includes('nano2') || token.includes('gemini31flashimage')) return 'nanobanana2';
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) return 'image2';
  return token;
};

const canonicalImagePricingModel = (model: string) => {
  const token = imagePricingModelToken(model);
  if (token === 'nanobananaprofast') return 'nano-banana-pro-fast';
  if (token === 'nanobanana2fast') return 'nano-banana-2-fast';
  if (token === 'nanobananapro') return 'nano-banana-pro';
  if (token === 'nanobanana2') return 'nano-banana-2';
  if (token === 'image2') return 'image2';
  return model.trim();
};

const RETIRED_IMAGE_MODEL_TOKENS = new Set([
  'xaisnanolite1k',
  'xaisimg21k',
  'xaisimage21k',
]);

const isRetiredImageModel = (model: string) => RETIRED_IMAGE_MODEL_TOKENS.has(aiPricingModelToken(model));

const supportsImageOneK = (model: string) => {
  const token = imagePricingModelToken(model);
  if (token.startsWith('xais')) return false;
  if (token === 'nanobananaprofast' || token === 'nanobanana2fast') return false;
  if (token === 'nanobananapro' || token === 'image2') return true;
  return token !== 'nanobanana2'
    && !token.includes('nanolite')
    && !token.includes('gemini3flashimage');
};

export type PricedImageResolution = '1k' | '2k' | '4k';

export const pricedImageResolution = (
  model: string,
  resolution?: string,
): PricedImageResolution => {
  const requested = resolution?.trim().toLowerCase();
  if (requested === '1k' || requested === '2k' || requested === '4k') return requested;
  const token = aiPricingModelToken(model);
  if (token.includes('4k')) return '4k';
  if (token.includes('2k')) return '2k';
  if (token.includes('1k')) return '1k';
  return '2k';
};

export function defaultImageUnitCredits(model: string, resolution?: string) {
  const token = imagePricingModelToken(model);
  const rawToken = aiPricingModelToken(model);
  const selectedResolution = pricedImageResolution(model, resolution);
  const isGptImage2 = token === 'image2';
  const isHighQuality = isGptImage2 && (
    model.includes('高画质')
    || rawToken.endsWith('h')
    || rawToken.includes('highquality')
  );

  if (isHighQuality) return selectedResolution === '4k' ? 35n : 30n;
  if (isGptImage2) {
    if (selectedResolution === '1k') return 10n;
    return selectedResolution === '4k' ? 18n : 15n;
  }

  const isNanoBananaPro = token === 'nanobananapro' || token === 'nanobananaprofast';
  if (isNanoBananaPro) return selectedResolution === '4k' ? 20n : 18n;

  const isNanoBanana2 = token === 'nanobanana2' || token === 'nanobanana2fast';
  if (isNanoBanana2) return selectedResolution === '4k' ? 18n : 15n;

  return DEFAULT_IMAGE_REQUEST_CREDITS;
}

const defaultImageModelPrices = (): ImageModelCreditPrice[] => (
  CANONICAL_IMAGE_PRICING_MODELS.map((model) => ({
    model,
    ...(supportsImageOneK(model) ? { credits1k: defaultImageUnitCredits(model, '1k').toString() } : {}),
    credits2k: defaultImageUnitCredits(model, '2k').toString(),
    credits4k: defaultImageUnitCredits(model, '4k').toString(),
  }))
);

const defaultVideoModelPrices = (): VideoModelCreditPrice[] => (
  KNOWN_VIDEO_MODELS.map((model) => ({
    model,
    credits: DEFAULT_VIDEO_REQUEST_CREDITS.toString(),
    ...(model === 'MiniMax-H3'
      ? {
        includedReferenceImages: 5,
        creditsPerExtraReferenceImage: '9',
        creditsPerReferenceVideoSecond: '15',
        referenceVideoCreditsByResolution: {
          '1080p': '10',
          '2k': '10',
        },
      }
      : {}),
  }))
);

export function defaultAiPricingConfig(): AiPricingConfigValue {
  return {
    agentRequestCredits: DEFAULT_AGENT_REQUEST_CREDITS.toString(),
    inspirationAnalysisCredits: DEFAULT_INSPIRATION_ANALYSIS_CREDITS.toString(),
    imageDefaultCredits: DEFAULT_IMAGE_REQUEST_CREDITS.toString(),
    videoDefaultCredits: DEFAULT_VIDEO_REQUEST_CREDITS.toString(),
    imageModels: defaultImageModelPrices(),
    videoModels: defaultVideoModelPrices(),
    updatedAt: null,
  };
}

const validCreditString = (value: unknown): value is string => (
  typeof value === 'string' && /^(?:0|[1-9]\d{0,6})$/.test(value)
);

const normalizeStoredImageModels = (value: Prisma.JsonValue): ImageModelCreditPrice[] => {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, ImageModelCreditPrice>();
  value.forEach((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model
      || isRetiredImageModel(model)
      || !validCreditString(record.credits2k)
      || !validCreditString(record.credits4k)) return [];
    const canonicalModel = canonicalImagePricingModel(model);
    const credits1k = supportsImageOneK(canonicalModel)
      ? validCreditString(record.credits1k) ? record.credits1k : record.credits2k
      : undefined;
    normalized.set(imagePricingModelToken(canonicalModel), {
      model: canonicalModel,
      ...(credits1k ? { credits1k } : {}),
      credits2k: record.credits2k,
      credits4k: record.credits4k,
    });
  });
  return Array.from(normalized.values());
};

const normalizeStoredVideoModels = (value: Prisma.JsonValue): VideoModelCreditPrice[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model || !validCreditString(record.credits)) return [];
    const normalizeMap = (candidate: unknown): Record<string, string> | undefined => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const entries = Object.entries(candidate as Record<string, unknown>)
        .filter(([key, credits]) => key.trim() && validCreditString(credits))
        .map(([key, credits]) => [key.trim().toLowerCase(), credits] as const);
      return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
    };
    const creditsByDuration = normalizeMap(record.creditsByDuration);
    const creditsByResolution = normalizeMap(record.creditsByResolution);
    const creditsByCount = normalizeMap(record.creditsByCount);
    const referenceVideoCreditsByResolution = normalizeMap(record.referenceVideoCreditsByResolution);
    const includedReferenceImages = typeof record.includedReferenceImages === 'number'
      && Number.isSafeInteger(record.includedReferenceImages)
      && record.includedReferenceImages >= 0
      && record.includedReferenceImages <= 100
      ? record.includedReferenceImages
      : undefined;
    return [{
      model,
      credits: record.credits,
      ...(validCreditString(record.creditsPerSecond) ? { creditsPerSecond: record.creditsPerSecond } : {}),
      ...(validCreditString(record.creditsPerVideo) ? { creditsPerVideo: record.creditsPerVideo } : {}),
      ...(creditsByDuration ? { creditsByDuration } : {}),
      ...(creditsByResolution ? { creditsByResolution } : {}),
      ...(creditsByCount ? { creditsByCount } : {}),
      ...(includedReferenceImages !== undefined ? { includedReferenceImages } : {}),
      ...(validCreditString(record.creditsPerExtraReferenceImage)
        ? { creditsPerExtraReferenceImage: record.creditsPerExtraReferenceImage }
        : {}),
      ...(validCreditString(record.creditsPerReferenceVideoSecond)
        ? { creditsPerReferenceVideoSecond: record.creditsPerReferenceVideoSecond }
        : {}),
      ...(referenceVideoCreditsByResolution ? { referenceVideoCreditsByResolution } : {}),
    }];
  });
};

const mergeKnownImageModels = (
  stored: ImageModelCreditPrice[],
  defaults: ImageModelCreditPrice[],
) => {
  const knownTokens = new Set(stored.map(item => imagePricingModelToken(item.model)));
  const storedByToken = new Map(stored.map(item => [imagePricingModelToken(item.model), item]));
  const missingDefaults = defaults
    .filter(item => !knownTokens.has(imagePricingModelToken(item.model)))
    .map((item) => {
      const token = imagePricingModelToken(item.model);
      const base = token === 'nanobananaprofast'
        ? storedByToken.get('nanobananapro')
        : token === 'nanobanana2fast'
          ? storedByToken.get('nanobanana2')
          : undefined;
      return base
        ? { model: item.model, credits2k: base.credits2k, credits4k: base.credits4k }
        : item;
    });
  return [
    ...stored,
    ...missingDefaults,
  ];
};

const mergeKnownVideoModels = (
  stored: VideoModelCreditPrice[],
  defaults: VideoModelCreditPrice[],
) => {
  const defaultsByToken = new Map(defaults.map(item => [videoPricingModelToken(item.model), item]));
  const mergedStored = stored.map((item) => ({
    ...defaultsByToken.get(videoPricingModelToken(item.model)),
    ...item,
  }));
  const knownTokens = new Set(mergedStored.map(item => videoPricingModelToken(item.model)));
  return [
    ...mergedStored,
    ...defaults.filter(item => !knownTokens.has(videoPricingModelToken(item.model))),
  ];
};

export async function getAiPricingConfig(prisma: PrismaClient): Promise<AiPricingConfigValue> {
  const defaults = defaultAiPricingConfig();
  const stored = await prisma.aiPricingConfig.findUnique({ where: { id: 'default' } });
  if (!stored) return defaults;
  return {
    agentRequestCredits: stored.agentRequestCredits.toString(),
    inspirationAnalysisCredits: stored.inspirationAnalysisCredits.toString(),
    imageDefaultCredits: stored.imageDefaultCredits.toString(),
    videoDefaultCredits: stored.videoDefaultCredits.toString(),
    imageModels: mergeKnownImageModels(
      normalizeStoredImageModels(stored.imageModelPrices),
      defaults.imageModels,
    ),
    videoModels: mergeKnownVideoModels(
      normalizeStoredVideoModels(stored.videoModelPrices),
      defaults.videoModels,
    ),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

export async function updateAiPricingConfig(
  prisma: PrismaClient,
  input: AiPricingConfigInput,
): Promise<AiPricingConfigValue> {
  const imageModelsByToken = new Map<string, ImageModelCreditPrice>();
  input.imageModels.forEach((item) => {
    const model = item.model.trim();
    if (!model || isRetiredImageModel(model)) return;
    const canonicalModel = canonicalImagePricingModel(model);
    imageModelsByToken.set(imagePricingModelToken(canonicalModel), {
      model: canonicalModel,
      ...(supportsImageOneK(model) && item.credits1k !== undefined
        ? { credits1k: item.credits1k }
        : {}),
      credits2k: item.credits2k,
      credits4k: item.credits4k,
    });
  });
  const imageModels = Array.from(imageModelsByToken.values());
  await prisma.aiPricingConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      agentRequestCredits: BigInt(input.agentRequestCredits),
      inspirationAnalysisCredits: BigInt(input.inspirationAnalysisCredits),
      imageDefaultCredits: BigInt(input.imageDefaultCredits),
      videoDefaultCredits: BigInt(input.videoDefaultCredits),
      imageModelPrices: imageModels,
      videoModelPrices: input.videoModels,
    },
    update: {
      agentRequestCredits: BigInt(input.agentRequestCredits),
      inspirationAnalysisCredits: BigInt(input.inspirationAnalysisCredits),
      imageDefaultCredits: BigInt(input.imageDefaultCredits),
      videoDefaultCredits: BigInt(input.videoDefaultCredits),
      imageModelPrices: imageModels,
      videoModelPrices: input.videoModels,
    },
  });
  return getAiPricingConfig(prisma);
}

export async function configuredAgentRequestCredits(prisma: PrismaClient) {
  return BigInt((await getAiPricingConfig(prisma)).agentRequestCredits);
}

export async function configuredInspirationAnalysisCredits(prisma: PrismaClient) {
  return BigInt((await getAiPricingConfig(prisma)).inspirationAnalysisCredits);
}

export async function configuredImageUnitCredits(
  prisma: PrismaClient,
  model: string,
  resolution?: string,
  capabilities?: readonly string[],
) {
  const pricing = await getAiPricingConfig(prisma);
  const modelToken = imagePricingModelToken(model);
  const normalizedCapabilities = new Set((capabilities || []).map((item) => item.trim().toUpperCase()));
  const pricingModel = normalizedCapabilities.has('IMAGE_NANO_BANANA_PRO_FAST')
    && modelToken === 'nanobananapro'
    ? 'nano-banana-pro-fast'
    : normalizedCapabilities.has('IMAGE_NANO_BANANA_2_FAST')
      && modelToken === 'nanobanana2'
      ? 'nano-banana-2-fast'
      : model;
  const exact = pricing.imageModels.find(
    (item) => imagePricingModelToken(item.model) === imagePricingModelToken(pricingModel),
  );
  if (!exact) {
    const fallback = defaultImageUnitCredits(model, resolution);
    return fallback === DEFAULT_IMAGE_REQUEST_CREDITS
      ? BigInt(pricing.imageDefaultCredits)
      : fallback;
  }
  const selectedResolution = pricedImageResolution(model, resolution);
  return BigInt(
    selectedResolution === '1k'
      ? exact.credits1k ?? exact.credits2k
      : selectedResolution === '4k' ? exact.credits4k : exact.credits2k,
  );
}

export async function configuredVideoUnitCredits(prisma: PrismaClient, model: string) {
  const pricing = await getAiPricingConfig(prisma);
  const exact = pricing.videoModels.find(
    (item) => videoPricingModelToken(item.model) === videoPricingModelToken(model),
  );
  return BigInt(exact?.creditsPerSecond ?? exact?.credits ?? pricing.videoDefaultCredits);
}

export function calculateVideoRequestCredits(
  price: VideoModelCreditPrice | undefined,
  fallbackPerSecond: string,
  duration = 15,
  resolution = '720p',
  count = 1,
  references: VideoReferenceCreditInput = {},
) {
  const safeDuration = Math.max(1, Math.ceil(Number(duration) || 15));
  const safeCount = Math.max(1, Math.ceil(Number(count) || 1));
  const durationKey = String(safeDuration);
  const resolutionKey = String(resolution || '720p').trim().toLowerCase() || '720p';
  const countKey = String(safeCount);
  const countOverride = price?.creditsByCount?.[countKey];

  const perSecond = BigInt(price?.creditsPerSecond ?? price?.credits ?? fallbackPerSecond);
  const durationCredits = price?.creditsByDuration?.[durationKey] !== undefined
    ? BigInt(price.creditsByDuration[durationKey])
    : perSecond * BigInt(safeDuration);
  const perVideo = BigInt(price?.creditsPerVideo ?? '0');
  const resolutionSurchargePerSecond = BigInt(price?.creditsByResolution?.[resolutionKey] ?? '0');
  const outputCredits = countOverride !== undefined
    ? BigInt(countOverride)
    : (
      durationCredits
      + perVideo
      + resolutionSurchargePerSecond * BigInt(safeDuration)
    ) * BigInt(safeCount);

  const imageCount = Math.max(0, Math.floor(Number(references.imageCount) || 0));
  const videoCount = Math.max(0, Math.floor(Number(references.videoCount) || 0));
  const includedReferenceImages = Math.max(0, Math.floor(Number(price?.includedReferenceImages) || 0));
  const extraReferenceImageCount = Math.max(0, imageCount - includedReferenceImages);
  const extraReferenceImageCredits = BigInt(price?.creditsPerExtraReferenceImage ?? '0')
    * BigInt(extraReferenceImageCount);
  const referenceVideoCreditsPerSecond = BigInt(price?.creditsPerReferenceVideoSecond ?? '0')
    + BigInt(price?.referenceVideoCreditsByResolution?.[resolutionKey] ?? '0');
  const referenceVideoCredits = referenceVideoCreditsPerSecond
    * BigInt(safeDuration)
    * BigInt(videoCount);

  // The provider receives the same references once for every requested output.
  return outputCredits
    + (extraReferenceImageCredits + referenceVideoCredits) * BigInt(safeCount);
}

export async function configuredVideoRequestCredits(
  prisma: PrismaClient,
  model: string,
  duration?: number,
  resolution?: string,
  count = 1,
  references: VideoReferenceCreditInput = {},
) {
  const pricing = await getAiPricingConfig(prisma);
  const price = pricing.videoModels.find(
    (item) => videoPricingModelToken(item.model) === videoPricingModelToken(model),
  );
  return calculateVideoRequestCredits(
    price,
    pricing.videoDefaultCredits,
    duration,
    resolution,
    count,
    references,
  );
}

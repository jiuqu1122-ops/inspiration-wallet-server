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
  credits: string;
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
  'nano-banana-pro',
  'nano-banana-2',
  'image2',
] as const;

const KNOWN_VIDEO_MODELS = [
  'seedance2',
  'seedance2fast',
  'sora-2',
  'veo-3.1',
  'veo-3.1-fast',
] as const;

export const aiPricingModelToken = (model: string) => model
  .trim()
  .toLowerCase()
  .replace(/高画质/g, 'highquality')
  .replace(/preview/g, '')
  .replace(/[^a-z0-9]+/g, '');

/** Public pricing families intentionally hide the upstream provider/model ID. */
export const imagePricingModelToken = (model: string) => {
  const token = aiPricingModelToken(model);
  if (token.includes('nanobananapro')
    || token.includes('xaisnanopro')
    || token.includes('gemini3proimage')
    || token.includes('gemini31proimage')) return 'nanobananapro';
  if (token.includes('nanobanana2')
    || token.includes('xaisnano2')
    || token.includes('gemini31flashimage')
    || token.includes('gemini3flashimage')) return 'nanobanana2';
  if (token.includes('gptimage2') || token.includes('image2') || token.includes('img2')) return 'image2';
  return token;
};

export const videoPricingModelToken = (model: string) => {
  const token = aiPricingModelToken(model);
  if (token === 'sourcemix20' || token === 'seedance20') return 'seedance2';
  if (token === 'sourcemix20fast' || token === 'seedance20fast') return 'seedance2fast';
  return token;
};

export const canonicalImagePricingModel = (model: string) => {
  const token = imagePricingModelToken(model);
  if (token === 'nanobananapro') return 'nano-banana-pro';
  if (token === 'nanobanana2') return 'nano-banana-2';
  if (token === 'image2') return 'image2';
  return model.trim();
};

export const canonicalVideoPricingModel = (model: string) => {
  const token = videoPricingModelToken(model);
  if (token === 'seedance2') return 'seedance2';
  if (token === 'seedance2fast') return 'seedance2fast';
  return model.trim();
};

const RETIRED_IMAGE_MODEL_TOKENS = new Set([
  'xaisnanolite1k',
  'xaisimg21k',
  'xaisimage21k',
]);

const isRetiredImageModel = (model: string) => RETIRED_IMAGE_MODEL_TOKENS.has(aiPricingModelToken(model));

const supportsImageOneK = (model: string, capabilities?: readonly string[]) => {
  if ((capabilities || []).some(value => String(value).toUpperCase() === 'IMAGE_NANO_BANANA_PRO_1K')) return true;
  const rawToken = aiPricingModelToken(model);
  const token = imagePricingModelToken(model);
  if (rawToken.startsWith('xais') && rawToken.includes('1k')) return false;
  return token !== 'nanobanana2' && token !== 'nanobananapro';
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
  const selectedResolution = pricedImageResolution(model, resolution);
  const isGptImage2 = token === 'image2';
  if (isGptImage2) {
    if (selectedResolution === '1k') return 10n;
    return selectedResolution === '4k' ? 18n : 15n;
  }

  const isNanoBananaPro = token === 'nanobananapro';
  if (isNanoBananaPro) return selectedResolution === '4k' ? 20n : 18n;

  const isNanoBanana2 = token === 'nanobanana2';
  if (isNanoBanana2) return selectedResolution === '4k' ? 18n : 15n;

  return DEFAULT_IMAGE_REQUEST_CREDITS;
}

const defaultImageModelPrices = (): ImageModelCreditPrice[] => (
  KNOWN_IMAGE_MODELS.map((model) => ({
    model,
    ...(supportsImageOneK(
      model,
      model === 'nano-banana-pro' ? ['IMAGE_NANO_BANANA_PRO_1K'] : undefined,
    ) ? { credits1k: defaultImageUnitCredits(model, '1k').toString() } : {}),
    credits2k: defaultImageUnitCredits(model, '2k').toString(),
    credits4k: defaultImageUnitCredits(model, '4k').toString(),
  }))
);

const defaultVideoModelPrices = (): VideoModelCreditPrice[] => (
  KNOWN_VIDEO_MODELS.map((model) => ({
    model,
    credits: DEFAULT_VIDEO_REQUEST_CREDITS.toString(),
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
  const candidates = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model
      || isRetiredImageModel(model)
      || !validCreditString(record.credits2k)
      || !validCreditString(record.credits4k)) return [];
    const credits1k = validCreditString(record.credits1k) ? record.credits1k : undefined;
    return [{
      model: canonicalImagePricingModel(model),
      ...(credits1k !== undefined ? { credits1k } : {}),
      credits2k: record.credits2k,
      credits4k: record.credits4k,
    }];
  });
  const byModel = new Map<string, ImageModelCreditPrice>();
  for (const item of candidates) {
    const key = imagePricingModelToken(item.model);
    const existing = byModel.get(key);
    if (!existing) {
      byModel.set(key, item);
      continue;
    }
    byModel.set(key, { ...existing, credits1k: existing.credits1k ?? item.credits1k });
  }
  return Array.from(byModel.values());
};

const normalizeStoredVideoModels = (value: Prisma.JsonValue): VideoModelCreditPrice[] => {
  if (!Array.isArray(value)) return [];
  const candidates = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model || !validCreditString(record.credits)) return [];
    return [{ model: canonicalVideoPricingModel(model), credits: record.credits }];
  });
  const byModel = new Map<string, VideoModelCreditPrice>();
  for (const item of candidates) {
    const key = videoPricingModelToken(item.model);
    if (!byModel.has(key)) byModel.set(key, item);
  }
  return Array.from(byModel.values());
};

export async function getAiPricingConfig(prisma: PrismaClient): Promise<AiPricingConfigValue> {
  const defaults = defaultAiPricingConfig();
  const stored = await prisma.aiPricingConfig.findUnique({ where: { id: 'default' } });
  if (!stored) return defaults;
  const storedImageModels = normalizeStoredImageModels(stored.imageModelPrices);
  const storedImageTokens = new Set(storedImageModels.map((item) => imagePricingModelToken(item.model)));
  const imageModels = [
    ...storedImageModels,
    ...KNOWN_IMAGE_MODELS
      .filter((model) => !storedImageTokens.has(imagePricingModelToken(model)))
      .map((model) => ({
        model,
        ...(supportsImageOneK(
          model,
          model === 'nano-banana-pro' ? ['IMAGE_NANO_BANANA_PRO_1K'] : undefined,
        ) ? { credits1k: defaultImageUnitCredits(model, '1k').toString() } : {}),
        credits2k: defaultImageUnitCredits(model, '2k').toString(),
        credits4k: defaultImageUnitCredits(model, '4k').toString(),
      })),
  ];
  const storedVideoModels = normalizeStoredVideoModels(stored.videoModelPrices);
  const storedVideoTokens = new Set(storedVideoModels.map((item) => videoPricingModelToken(item.model)));
  const videoModels = [
    ...storedVideoModels,
    ...KNOWN_VIDEO_MODELS
      .filter((model) => !storedVideoTokens.has(videoPricingModelToken(model)))
      .map((model) => ({ model, credits: stored.videoDefaultCredits.toString() })),
  ];
  return {
    agentRequestCredits: stored.agentRequestCredits.toString(),
    inspirationAnalysisCredits: stored.inspirationAnalysisCredits.toString(),
    imageDefaultCredits: stored.imageDefaultCredits.toString(),
    videoDefaultCredits: stored.videoDefaultCredits.toString(),
    imageModels,
    videoModels,
    updatedAt: stored.updatedAt.toISOString(),
  };
}

export async function updateAiPricingConfig(
  prisma: PrismaClient,
  input: AiPricingConfigInput,
): Promise<AiPricingConfigValue> {
  const imageModels = input.imageModels.flatMap((item) => {
    const model = item.model.trim();
    if (!model || isRetiredImageModel(model)) return [];
    return [{
      model: canonicalImagePricingModel(model),
      ...(item.credits1k !== undefined
        ? { credits1k: item.credits1k }
        : {}),
      credits2k: item.credits2k,
      credits4k: item.credits4k,
    }];
  });
  const videoModels = input.videoModels.map((item) => ({
    ...item,
    model: canonicalVideoPricingModel(item.model),
  }));
  await prisma.aiPricingConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      agentRequestCredits: BigInt(input.agentRequestCredits),
      inspirationAnalysisCredits: BigInt(input.inspirationAnalysisCredits),
      imageDefaultCredits: BigInt(input.imageDefaultCredits),
      videoDefaultCredits: BigInt(input.videoDefaultCredits),
      imageModelPrices: imageModels,
      videoModelPrices: videoModels,
    },
    update: {
      agentRequestCredits: BigInt(input.agentRequestCredits),
      inspirationAnalysisCredits: BigInt(input.inspirationAnalysisCredits),
      imageDefaultCredits: BigInt(input.imageDefaultCredits),
      videoDefaultCredits: BigInt(input.videoDefaultCredits),
      imageModelPrices: imageModels,
      videoModelPrices: videoModels,
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
  const exact = pricing.imageModels.find(
    (item) => imagePricingModelToken(item.model) === imagePricingModelToken(model),
  );
  if (!exact) {
    const fallback = defaultImageUnitCredits(model, resolution);
    return fallback === DEFAULT_IMAGE_REQUEST_CREDITS
      ? BigInt(pricing.imageDefaultCredits)
      : fallback;
  }
  const requestedResolution = pricedImageResolution(model, resolution);
  const selectedResolution = requestedResolution === '1k' && !supportsImageOneK(model, capabilities)
    ? '2k'
    : requestedResolution;
  return BigInt(
    selectedResolution === '1k'
      ? exact.credits1k ?? exact.credits2k
      : selectedResolution === '4k' ? exact.credits4k : exact.credits2k,
  );
}

export async function configuredVideoCreditsPerSecond(prisma: PrismaClient, model: string) {
  const pricing = await getAiPricingConfig(prisma);
  const exact = pricing.videoModels.find(
    (item) => videoPricingModelToken(item.model) === videoPricingModelToken(model),
  );
  return BigInt(exact?.credits ?? pricing.videoDefaultCredits);
}

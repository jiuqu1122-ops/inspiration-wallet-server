import type { Prisma, PrismaClient } from '@prisma/client';

export const CHAT_CONTEXT_THRESHOLD_TOKENS = 272_000;
const TOKENS_PER_MILLION = 1_000_000n;

export type ChatTokenRates = {
  inputCreditsPerMillion: string;
  outputCreditsPerMillion: string;
  cachedInputCreditsPerMillion: string;
  cacheWriteCreditsPerMillion: string;
};

export type ChatTokenModelPrice = {
  model: string;
  billingMode: 'token';
  contextThresholdTokens: number;
  standard: ChatTokenRates;
  extended: ChatTokenRates;
};

export type ChatRequestModelPrice = {
  model: string;
  billingMode: 'request';
  creditsPerRequest: string;
};

export type ChatModelCreditPrice = ChatTokenModelPrice | ChatRequestModelPrice;

export type ChatPricingConfigValue = {
  models: ChatModelCreditPrice[];
  updatedAt: string | null;
};

export type ChatPricingConfigInput = Omit<ChatPricingConfigValue, 'updatedAt'>;

export type ChatTokenUsage = {
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  cacheWriteTokens: bigint;
};

export type ChatChargeBreakdown = {
  version: 1;
  model: string;
  billingMode: 'token' | 'request' | 'fallback';
  contextTier: 'standard' | 'extended' | 'request' | 'fallback';
  contextThresholdTokens: number | null;
  usage: {
    inputTokens: string;
    normalInputTokens: string;
    cachedInputTokens: string;
    cacheWriteTokens: string;
    outputTokens: string;
  } | null;
  rates: ChatTokenRates | null;
  chargedCredits: string;
  fallbackReason?: 'model_not_configured' | 'usage_missing';
};

const DEFAULT_CHAT_MODELS: ChatModelCreditPrice[] = [
  {
    model: 'gpt-5.6-terra',
    billingMode: 'token',
    contextThresholdTokens: CHAT_CONTEXT_THRESHOLD_TOKENS,
    standard: {
      inputCreditsPerMillion: '80',
      outputCreditsPerMillion: '480',
      cachedInputCreditsPerMillion: '8',
      cacheWriteCreditsPerMillion: '100',
    },
    extended: {
      inputCreditsPerMillion: '160',
      outputCreditsPerMillion: '720',
      cachedInputCreditsPerMillion: '16',
      cacheWriteCreditsPerMillion: '200',
    },
  },
  {
    model: 'gpt-5.6-sol',
    billingMode: 'token',
    contextThresholdTokens: CHAT_CONTEXT_THRESHOLD_TOKENS,
    standard: {
      inputCreditsPerMillion: '200',
      outputCreditsPerMillion: '1200',
      cachedInputCreditsPerMillion: '20',
      cacheWriteCreditsPerMillion: '250',
    },
    extended: {
      inputCreditsPerMillion: '400',
      outputCreditsPerMillion: '1800',
      cachedInputCreditsPerMillion: '40',
      cacheWriteCreditsPerMillion: '500',
    },
  },
  {
    model: 'gpt-5.6-luna',
    billingMode: 'request',
    creditsPerRequest: '2',
  },
];

const validCreditString = (value: unknown): value is string => (
  typeof value === 'string' && /^(?:0|[1-9]\d{0,6})$/.test(value)
);

const validThreshold = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 1
  && value <= 10_000_000
);

const normalizeRates = (value: unknown): ChatTokenRates | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validCreditString(record.inputCreditsPerMillion)
    || !validCreditString(record.outputCreditsPerMillion)
    || !validCreditString(record.cachedInputCreditsPerMillion)
    || !validCreditString(record.cacheWriteCreditsPerMillion)) return null;
  return {
    inputCreditsPerMillion: record.inputCreditsPerMillion,
    outputCreditsPerMillion: record.outputCreditsPerMillion,
    cachedInputCreditsPerMillion: record.cachedInputCreditsPerMillion,
    cacheWriteCreditsPerMillion: record.cacheWriteCreditsPerMillion,
  };
};

export const chatPricingModelToken = (model: string) => model
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const normalizeStoredModels = (value: Prisma.JsonValue): ChatModelCreditPrice[] => {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, ChatModelCreditPrice>();
  value.forEach((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    const token = chatPricingModelToken(model);
    if (!model || !token) return;
    if (record.billingMode === 'request') {
      if (!validCreditString(record.creditsPerRequest)) return;
      normalized.set(token, { model, billingMode: 'request', creditsPerRequest: record.creditsPerRequest });
      return;
    }
    if (record.billingMode !== 'token' || !validThreshold(record.contextThresholdTokens)) return;
    const standard = normalizeRates(record.standard);
    const extended = normalizeRates(record.extended);
    if (!standard || !extended) return;
    normalized.set(token, {
      model,
      billingMode: 'token',
      contextThresholdTokens: record.contextThresholdTokens,
      standard,
      extended,
    });
  });
  return Array.from(normalized.values());
};

const mergeDefaultModels = (stored: ChatModelCreditPrice[]) => {
  const known = new Set(stored.map(item => chatPricingModelToken(item.model)));
  return [
    ...stored,
    ...DEFAULT_CHAT_MODELS.filter(item => !known.has(chatPricingModelToken(item.model))),
  ];
};

export function defaultChatPricingConfig(): ChatPricingConfigValue {
  return {
    models: structuredClone(DEFAULT_CHAT_MODELS),
    updatedAt: null,
  };
}

export async function getChatPricingConfig(prisma: PrismaClient): Promise<ChatPricingConfigValue> {
  const stored = await prisma.chatPricingConfig.findUnique({ where: { id: 'default' } });
  if (!stored) return defaultChatPricingConfig();
  return {
    models: mergeDefaultModels(normalizeStoredModels(stored.modelPrices)),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

export async function updateChatPricingConfig(
  prisma: PrismaClient,
  input: ChatPricingConfigInput,
): Promise<ChatPricingConfigValue> {
  const models = normalizeStoredModels(input.models);
  await prisma.chatPricingConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', modelPrices: models },
    update: { modelPrices: models },
  });
  return getChatPricingConfig(prisma);
}

const objectValue = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const tokenCount = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return null;
};

const firstTokenCount = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = tokenCount(value);
    if (parsed !== null) return parsed;
  }
  return 0n;
};

function responseUsage(value: unknown): Record<string, unknown> | null {
  const root = objectValue(value);
  if (!root) return null;
  const direct = objectValue(root.usage);
  if (direct) return direct;
  for (const key of ['data', 'result', 'response']) {
    const nested = objectValue(root[key]);
    const usage = objectValue(nested?.usage);
    if (usage) return usage;
  }
  return null;
}

export function extractChatTokenUsage(value: unknown): ChatTokenUsage | null {
  const usage = responseUsage(value);
  if (!usage) return null;
  const inputDetails = objectValue(usage.input_tokens_details)
    ?? objectValue(usage.prompt_tokens_details);
  const inputTokens = firstTokenCount(usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstTokenCount(usage.output_tokens, usage.completion_tokens);
  const cachedInputTokens = firstTokenCount(
    inputDetails?.cached_tokens,
    inputDetails?.cached_input_tokens,
    usage.cached_input_tokens,
    usage.cache_read_input_tokens,
  );
  const cacheWriteTokens = firstTokenCount(
    inputDetails?.cache_write_tokens,
    inputDetails?.cache_creation_tokens,
    usage.cache_write_tokens,
    usage.cache_creation_input_tokens,
  );
  if (inputTokens === 0n && outputTokens === 0n
    && cachedInputTokens === 0n && cacheWriteTokens === 0n) return null;
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens };
}

export function extractChatResponseModel(value: unknown, fallback = '') {
  const root = objectValue(value);
  const direct = typeof root?.model === 'string' ? root.model.trim() : '';
  if (direct) return direct;
  for (const key of ['data', 'result', 'response']) {
    const nested = objectValue(root?.[key]);
    const model = typeof nested?.model === 'string' ? nested.model.trim() : '';
    if (model) return model;
  }
  return fallback.trim();
}

function findModelPrice(config: ChatPricingConfigValue, model: string) {
  const token = chatPricingModelToken(model);
  return config.models.find(item => chatPricingModelToken(item.model) === token);
}

const formatPerMillionCredits = (numerator: bigint) => {
  if (numerator <= 0n) return '0.000000';
  const whole = numerator / TOKENS_PER_MILLION;
  const fraction = (numerator % TOKENS_PER_MILLION).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
};

const fixedCreditString = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.', 2);
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`;
};

export function calculateChatTokenCharge(
  model: string,
  price: ChatTokenModelPrice,
  usage: ChatTokenUsage,
): ChatChargeBreakdown {
  const extended = usage.inputTokens > BigInt(price.contextThresholdTokens);
  const rates = extended ? price.extended : price.standard;
  const cachedInputTokens = usage.cachedInputTokens > usage.inputTokens
    ? usage.inputTokens
    : usage.cachedInputTokens;
  const normalInputTokens = usage.inputTokens - cachedInputTokens;
  const numerator = normalInputTokens * BigInt(rates.inputCreditsPerMillion)
    + cachedInputTokens * BigInt(rates.cachedInputCreditsPerMillion)
    + usage.outputTokens * BigInt(rates.outputCreditsPerMillion)
    + usage.cacheWriteTokens * BigInt(rates.cacheWriteCreditsPerMillion);
  return {
    version: 1,
    model,
    billingMode: 'token',
    contextTier: extended ? 'extended' : 'standard',
    contextThresholdTokens: price.contextThresholdTokens,
    usage: {
      inputTokens: usage.inputTokens.toString(),
      normalInputTokens: normalInputTokens.toString(),
      cachedInputTokens: cachedInputTokens.toString(),
      cacheWriteTokens: usage.cacheWriteTokens.toString(),
      outputTokens: usage.outputTokens.toString(),
    },
    rates,
    chargedCredits: formatPerMillionCredits(numerator),
  };
}

export async function configuredChatCharge(
  prisma: PrismaClient,
  value: unknown,
  requestedModel: string | undefined,
  fallbackCredits: bigint,
): Promise<ChatChargeBreakdown> {
  const model = extractChatResponseModel(value, requestedModel || 'unmind-agent') || 'unmind-agent';
  const config = await getChatPricingConfig(prisma);
  const price = findModelPrice(config, model);
  if (price?.billingMode === 'request') {
    return {
      version: 1,
      model,
      billingMode: 'request',
      contextTier: 'request',
      contextThresholdTokens: null,
      usage: null,
      rates: null,
      chargedCredits: fixedCreditString(price.creditsPerRequest),
    };
  }
  const usage = extractChatTokenUsage(value);
  if (price?.billingMode === 'token' && usage) return calculateChatTokenCharge(model, price, usage);
  return {
    version: 1,
    model,
    billingMode: 'fallback',
    contextTier: 'fallback',
    contextThresholdTokens: null,
    usage: usage ? {
      inputTokens: usage.inputTokens.toString(),
      normalInputTokens: (usage.inputTokens - (
        usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens
      )).toString(),
      cachedInputTokens: (
        usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens
      ).toString(),
      cacheWriteTokens: usage.cacheWriteTokens.toString(),
      outputTokens: usage.outputTokens.toString(),
    } : null,
    rates: null,
    chargedCredits: fixedCreditString(fallbackCredits.toString()),
    fallbackReason: price ? 'usage_missing' : 'model_not_configured',
  };
}

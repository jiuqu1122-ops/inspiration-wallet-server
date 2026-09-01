import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_CONTEXT_THRESHOLD_TOKENS,
  calculateChatTokenCharge,
  configuredChatCharge,
  defaultChatPricingConfig,
  extractChatTokenUsage,
  getChatPricingConfig,
  type ChatTokenModelPrice,
} from '../src/modules/ai/chat-pricing.js';

const defaultModel = (model: string) => {
  const price = defaultChatPricingConfig().models.find(item => item.model === model);
  if (!price || price.billingMode !== 'token') throw new Error(`Missing token price for ${model}`);
  return price as ChatTokenModelPrice;
};

const prismaWithoutStoredPricing = () => ({
  chatPricingConfig: {
    findUnique: vi.fn(async () => null),
  },
}) as unknown as PrismaClient;

describe('Chat token pricing', () => {
  it('ships the requested Terra, Sol, and Luna prices as defaults', () => {
    const pricing = defaultChatPricingConfig();
    expect(pricing.models).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        billingMode: 'token',
        contextThresholdTokens: 272_000,
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
      }),
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        billingMode: 'token',
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
      }),
      { model: 'gpt-5.6-luna', billingMode: 'request', creditsPerRequest: '2' },
    ]);
  });

  it('uses normal input = input - cached input and rounds the combined charge up once', () => {
    const charge = calculateChatTokenCharge('gpt-5.6-terra', defaultModel('gpt-5.6-terra'), {
      inputTokens: 1_000_000n,
      cachedInputTokens: 200_000n,
      outputTokens: 100_000n,
      cacheWriteTokens: 50_000n,
    });
    expect(charge.contextTier).toBe('extended');
    expect(charge.usage).toEqual({
      inputTokens: '1000000',
      normalInputTokens: '800000',
      cachedInputTokens: '200000',
      cacheWriteTokens: '50000',
      outputTokens: '100000',
    });
    expect(charge.chargedCredits).toBe('213.200000');
  });

  it('switches price tiers only after the 272K boundary', () => {
    const price = defaultModel('gpt-5.6-sol');
    const standard = calculateChatTokenCharge('gpt-5.6-sol', price, {
      inputTokens: BigInt(CHAT_CONTEXT_THRESHOLD_TOKENS),
      cachedInputTokens: 0n,
      outputTokens: 0n,
      cacheWriteTokens: 0n,
    });
    const extended = calculateChatTokenCharge('gpt-5.6-sol', price, {
      inputTokens: BigInt(CHAT_CONTEXT_THRESHOLD_TOKENS + 1),
      cachedInputTokens: 0n,
      outputTokens: 0n,
      cacheWriteTokens: 0n,
    });
    expect(standard.contextTier).toBe('standard');
    expect(standard.chargedCredits).toBe('54.400000');
    expect(extended.contextTier).toBe('extended');
    expect(extended.chargedCredits).toBe('108.800400');
  });

  it('keeps an exact six-decimal charge instead of rounding to a whole credit', () => {
    const price: ChatTokenModelPrice = {
      model: 'precision-test',
      billingMode: 'token',
      contextThresholdTokens: 2_000_000,
      standard: {
        inputCreditsPerMillion: '1',
        outputCreditsPerMillion: '0',
        cachedInputCreditsPerMillion: '0',
        cacheWriteCreditsPerMillion: '0',
      },
      extended: {
        inputCreditsPerMillion: '1',
        outputCreditsPerMillion: '0',
        cachedInputCreditsPerMillion: '0',
        cacheWriteCreditsPerMillion: '0',
      },
    };
    expect(calculateChatTokenCharge('precision-test', price, {
      inputTokens: 1_284_735n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      cacheWriteTokens: 0n,
    }).chargedCredits).toBe('1.284735');
  });

  it('reads OpenAI and Anthropic-compatible cache usage fields', () => {
    expect(extractChatTokenUsage({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 120, cache_creation_tokens: 30 },
      },
    })).toEqual({
      inputTokens: 500n,
      outputTokens: 80n,
      cachedInputTokens: 120n,
      cacheWriteTokens: 30n,
    });
    expect(extractChatTokenUsage({
      usage: {
        input_tokens: 600,
        output_tokens: 90,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      },
    })).toEqual({
      inputTokens: 600n,
      outputTokens: 90n,
      cachedInputTokens: 200n,
      cacheWriteTokens: 40n,
    });
  });

  it('charges Luna per request and falls back safely when token usage is absent', async () => {
    const prisma = prismaWithoutStoredPricing();
    const luna = await configuredChatCharge(
      prisma,
      { model: 'gpt-5.6-luna', choices: [] },
      'gpt-5.6-luna',
      10n,
    );
    const missingUsage = await configuredChatCharge(
      prisma,
      { model: 'gpt-5.6-sol', choices: [] },
      'gpt-5.6-sol',
      10n,
    );
    expect(luna).toMatchObject({ billingMode: 'request', chargedCredits: '2.000000' });
    expect(missingUsage).toMatchObject({
      billingMode: 'fallback',
      chargedCredits: '10.000000',
      fallbackReason: 'usage_missing',
    });
  });

  it('backfills default model rows when stored configuration is partial', async () => {
    const prisma = {
      chatPricingConfig: {
        findUnique: vi.fn(async () => ({
          id: 'default',
          modelPrices: [{ model: 'gpt-5.6-luna', billingMode: 'request', creditsPerRequest: '3' }],
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date('2026-09-01T01:00:00.000Z'),
        })),
      },
    } as unknown as PrismaClient;
    const pricing = await getChatPricingConfig(prisma);
    expect(pricing.models).toHaveLength(3);
    expect(pricing.models.find(item => item.model === 'gpt-5.6-luna')).toMatchObject({
      creditsPerRequest: '3',
    });
    expect(pricing.updatedAt).toBe('2026-09-01T01:00:00.000Z');
  });
});

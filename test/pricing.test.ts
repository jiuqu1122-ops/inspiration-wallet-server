import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  configuredImageUnitCredits,
  configuredVideoUnitCredits,
  defaultAiPricingConfig,
  defaultImageUnitCredits,
  getAiPricingConfig,
  aiPricingModelToken,
} from '../src/modules/ai/pricing.js';

const prismaWithPricing = (pricing: {
  agentRequestCredits: bigint;
  inspirationAnalysisCredits: bigint;
  imageDefaultCredits: bigint;
  videoDefaultCredits: bigint;
  imageModelPrices: unknown;
  videoModelPrices: unknown;
}) => ({
  aiPricingConfig: {
    findUnique: vi.fn(async () => ({
      id: 'default',
      ...pricing,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      updatedAt: new Date('2026-07-27T01:00:00.000Z'),
    })),
  },
}) as unknown as PrismaClient;

describe('AI credit pricing', () => {
  it('preserves the legacy image prices as its initial defaults', () => {
    expect(defaultImageUnitCredits('gpt-image-2', '1k')).toBe(10n);
    expect(defaultImageUnitCredits('gpt-image-2', '4k')).toBe(18n);
    expect(defaultImageUnitCredits('Xais Img2_2K(高画质)', '4k')).toBe(35n);
    expect(defaultAiPricingConfig().inspirationAnalysisCredits).toBe('0');
  });

  it('keeps standard and high-quality model ids distinct', () => {
    expect(aiPricingModelToken('Xais Img2_2K')).not.toBe(
      aiPricingModelToken('Xais Img2_2K(高画质)'),
    );
    const modelTokens = defaultAiPricingConfig().imageModels
      .map((item) => aiPricingModelToken(item.model));
    expect(new Set(modelTokens).size).toBe(modelTokens.length);
  });

  it('uses exact configured model prices and configured unknown-model defaults', async () => {
    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 300n,
      imageModelPrices: [{
        model: 'gpt-image-2',
        credits1k: '3',
        credits2k: '5',
        credits4k: '7',
      }],
      videoModelPrices: [{ model: 'seedance2', credits: '44' }],
    });

    expect(await configuredImageUnitCredits(prisma, 'GPT Image 2', '4K')).toBe(7n);
    expect(await configuredImageUnitCredits(prisma, 'custom-image-model', '2K')).toBe(66n);
    expect(await configuredVideoUnitCredits(prisma, 'Seedance 2')).toBe(44n);
    expect((await getAiPricingConfig(prisma)).agentRequestCredits).toBe('8');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  configuredImageUnitCredits,
  configuredVideoUnitCredits,
  configuredVideoRequestCredits,
  calculateVideoRequestCredits,
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
  it('exposes canonical image family prices as its initial defaults', () => {
    expect(defaultImageUnitCredits('gpt-image-2', '1k')).toBe(10n);
    expect(defaultImageUnitCredits('gpt-image-2', '4k')).toBe(18n);
    expect(defaultImageUnitCredits('Xais Img2_2K(高画质)', '4k')).toBe(35n);
    expect(defaultAiPricingConfig().imageModels.map(item => item.model)).toEqual([
      'nano-banana-pro',
      'nano-banana-2',
      'nano-banana-pro-fast',
      'nano-banana-2-fast',
      'image2',
    ]);
    expect(defaultAiPricingConfig().inspirationAnalysisCredits).toBe('0');
  });

  it('normalizes provider model aliases to one pricing family', () => {
    expect(aiPricingModelToken('Xais Img2_2K')).not.toBe(
      aiPricingModelToken('Xais Img2_2K(高画质)'),
    );
    const modelTokens = defaultAiPricingConfig().imageModels
      .map((item) => aiPricingModelToken(item.model));
    expect(new Set(modelTokens).size).toBe(modelTokens.length);
  });

  it('keeps retired XAIS models out while exposing 1K pricing for non-XAIS Banana Pro', () => {
    const models = defaultAiPricingConfig().imageModels;
    expect(models.some((item) => aiPricingModelToken(item.model) === 'xaisnanolite1k')).toBe(false);
    expect(models.some((item) => aiPricingModelToken(item.model) === 'xaisimg21k')).toBe(false);
    expect(models.find((item) => item.model === 'nano-banana-2')).toEqual(expect.objectContaining({
      model: 'nano-banana-2',
      credits2k: '15',
      credits4k: '18',
    }));
    expect(models.find((item) => item.model === 'nano-banana-2')?.credits1k).toBeUndefined();
    expect(models.find((item) => item.model === 'nano-banana-pro')?.credits1k).toBeDefined();
    expect(models.find((item) => item.model === 'nano-banana-pro-fast')?.credits1k).toBeUndefined();
    expect(models.find((item) => item.model === 'nano-banana-2-fast')?.credits1k).toBeUndefined();
    expect(models.find((item) => item.model === 'image2')?.credits1k).toBeDefined();
  });

  it('uses separate 2K and 4K prices for fast Banana channel capabilities', async () => {
    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 300n,
      imageModelPrices: [{
        model: 'nano-banana-pro',
        credits1k: '6',
        credits2k: '8',
        credits4k: '10',
      }, {
        model: 'nano-banana-2',
        credits2k: '11',
        credits4k: '13',
      }, {
        model: 'nano-banana-pro-fast',
        credits2k: '28',
        credits4k: '30',
      }, {
        model: 'nano-banana-2-fast',
        credits2k: '24',
        credits4k: '27',
      }],
      videoModelPrices: [],
    });

    expect(await configuredImageUnitCredits(
      prisma,
      'gemini-3-pro-image',
      '2K',
      ['IMAGE_NANO_BANANA_PRO_FAST'],
    )).toBe(28n);
    expect(await configuredImageUnitCredits(
      prisma,
      'gemini-3-pro-image',
      '4K',
      ['IMAGE_NANO_BANANA_PRO_FAST'],
    )).toBe(30n);
    expect(await configuredImageUnitCredits(
      prisma,
      'gemini-3.1-flash-image',
      '2K',
      ['IMAGE_NANO_BANANA_2_FAST'],
    )).toBe(24n);
    expect(await configuredImageUnitCredits(prisma, 'gemini-3-pro-image', '2K')).toBe(8n);
  });

  it('uses exact configured model prices and configured unknown-model defaults', async () => {
    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 300n,
      imageModelPrices: [
        {
          model: 'gpt-image-2',
          credits1k: '3',
          credits2k: '5',
          credits4k: '7',
        },
        {
          model: 'gemini-3-pro-image',
          credits1k: '6',
          credits2k: '8',
          credits4k: '10',
        },
      ],
      videoModelPrices: [{ model: 'seedance2', credits: '44' }],
    });

    expect(await configuredImageUnitCredits(prisma, 'GPT Image 2', '4K')).toBe(7n);
    expect(await configuredImageUnitCredits(prisma, 'gemini-3-pro-image-preview', '1K')).toBe(6n);
    expect(await configuredImageUnitCredits(prisma, 'custom-image-model', '2K')).toBe(66n);
    expect(await configuredVideoUnitCredits(prisma, 'Seedance 2')).toBe(44n);
    expect(await configuredVideoUnitCredits(prisma, 'SourceMix2.0')).toBe(44n);
    const resolved = await getAiPricingConfig(prisma);
    expect(resolved.agentRequestCredits).toBe('8');
    expect(resolved.videoModels.map(item => item.model)).toEqual(expect.arrayContaining([
      'seedance2',
      'seedance2fast',
      'kling-video',
      'kling-omni-video',
    ]));
  });

  it('backfills Banana Pro 1K pricing from legacy 2K records', async () => {
    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 300n,
      imageModelPrices: [{
        model: 'gemini-3-pro-image',
        credits2k: '18',
        credits4k: '20',
      }],
      videoModelPrices: [],
    });

    const resolved = await getAiPricingConfig(prisma);
    expect(resolved.imageModels[0]).toEqual({
      model: 'nano-banana-pro',
      credits1k: '18',
      credits2k: '18',
      credits4k: '20',
    });
    expect(resolved.imageModels.find(item => item.model === 'nano-banana-pro-fast')).toEqual({
      model: 'nano-banana-pro-fast',
      credits2k: '18',
      credits4k: '20',
    });
  });

  it('calculates video credits from duration, resolution, per-video, and count rules', async () => {
    const price = {
      model: 'kling-video',
      credits: '2',
      creditsPerSecond: '3',
      creditsPerVideo: '5',
      creditsByDuration: { '10': '40' },
      creditsByResolution: { '1080p': '8' },
      creditsByCount: { '3': '200' },
    };
    expect(calculateVideoRequestCredits(price, '1', 10, '1080p', 2)).toBe(250n);
    expect(calculateVideoRequestCredits(price, '1', 10, '720p', 3)).toBe(200n);

    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 1n,
      imageModelPrices: [],
      videoModelPrices: [price],
    });
    expect(await configuredVideoRequestCredits(prisma, 'Kling Video', 10, '1080p', 2)).toBe(250n);
  });

  it('adds MiniMax H3 reference-image and reference-video material credits', async () => {
    const price = {
      model: 'MiniMax-H3',
      credits: '15',
      creditsByResolution: { '2k': '10' },
      includedReferenceImages: 5,
      creditsPerExtraReferenceImage: '9',
      creditsPerReferenceVideoSecond: '15',
      referenceVideoCreditsByResolution: { '2k': '10' },
    };

    expect(calculateVideoRequestCredits(
      price,
      '1',
      4,
      '768P',
      1,
      { imageCount: 5, videoCount: 0 },
    )).toBe(60n);
    expect(calculateVideoRequestCredits(
      price,
      '1',
      4,
      '768P',
      1,
      { imageCount: 7, videoCount: 1 },
    )).toBe(138n);
    expect(calculateVideoRequestCredits(
      price,
      '1',
      4,
      '2K',
      2,
      { imageCount: 6, videoCount: 1 },
    )).toBe(418n);

    const prisma = prismaWithPricing({
      agentRequestCredits: 8n,
      inspirationAnalysisCredits: 2n,
      imageDefaultCredits: 66n,
      videoDefaultCredits: 1n,
      imageModelPrices: [],
      videoModelPrices: [{ model: 'MiniMax-H3', credits: '15', creditsByResolution: { '2k': '10' } }],
    });
    expect(await configuredVideoRequestCredits(
      prisma,
      'MiniMax H3',
      4,
      '2K',
      1,
      { imageCount: 6, videoCount: 1 },
    )).toBe(209n);
  });
});

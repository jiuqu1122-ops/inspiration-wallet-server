import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  createMembershipPlan,
  getMembershipForUser,
  getReferralBindingEligibility,
  membershipQuotaPeriodRange,
  normalizeInviteCode,
  parseMembershipQuotaDefinitions,
  rewardReferralOnRecharge,
  validateReferralCode,
} from '../src/modules/membership/service.js';

describe('membership and referral helpers', () => {
  it('normalizes invite codes without ambiguous separators', () => {
    expect(normalizeInviteCode(' ab-cd 12 ')).toBe('ABCD12');
  });

  it('rejects malformed and unknown invite codes', async () => {
    const prisma = {
      referralProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;
    await expect(validateReferralCode(prisma, 'abc')).resolves.toMatchObject({ valid: false, reason: 'invalid_format' });
    await expect(validateReferralCode(prisma, 'ABCDEFG')).resolves.toMatchObject({ valid: false, reason: 'not_found' });
  });

  it('only returns active, non-expired membership', async () => {
    const prisma = {
      userMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;
    await expect(getMembershipForUser(prisma, 'user-1')).resolves.toBeNull();
  });

  it('returns an empty quota list when the active plan has no quota configuration', async () => {
    const prisma = {
      userMembership: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'membership-1',
          status: 'ACTIVE',
          startsAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          source: 'ADMIN',
          note: null,
          plan: {
            id: 'plan-1',
            code: 'pro',
            name: 'Pro',
            description: null,
            versions: [{ freeQuota: null }],
          },
        }),
      },
    } as never;

    await expect(getMembershipForUser(
      prisma,
      'user-1',
      new Date('2026-09-16T02:00:00.000Z'),
    )).resolves.toMatchObject({
      plan: { id: 'plan-1', code: 'pro', name: 'Pro' },
      quotas: [],
    });
  });

  it('summarizes settled image and token usage by canonical model and CST period', async () => {
    const findManyModels = vi.fn().mockResolvedValue([
      { id: 'model-image', displayName: 'Seedream 5 Pro' },
      { id: 'model-chat', displayName: 'GPT-5.6 Sol' },
    ]);
    const findManySettlements = vi.fn().mockResolvedValue([
      {
        canonicalModelId: 'model-image',
        breakdown: { quantity: '9', details: { generatedCount: 7 } },
        createdAt: new Date('2026-09-16T01:00:00.000Z'),
      },
      {
        canonicalModelId: 'model-image',
        breakdown: { details: { generatedCount: 5 } },
        createdAt: new Date('2026-09-15T15:59:59.000Z'),
      },
      {
        canonicalModelId: 'model-chat',
        breakdown: {
          details: {
            usage: {
              inputTokens: '300000',
              cachedInputTokens: '90000',
              cacheWriteTokens: '53000',
              outputTokens: '120000',
            },
          },
        },
        createdAt: new Date('2026-09-10T01:00:00.000Z'),
      },
    ]);
    const prisma = {
      userMembership: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'membership-1',
          status: 'ACTIVE',
          startsAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          source: 'ADMIN',
          note: null,
          plan: {
            id: 'plan-1',
            code: 'pro',
            name: 'Pro',
            description: null,
            versions: [{
              freeQuota: {
                quotas: [
                  { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'DAILY', limit: 20 },
                  { type: 'LLM_TOKENS', canonicalModelId: 'model-chat', period: 'MONTHLY', limit: 1_000_000 },
                ],
              },
            }],
          },
        }),
      },
      aiModel: { findMany: findManyModels },
      aiBillingSettlement: { findMany: findManySettlements },
    } as never;

    const membership = await getMembershipForUser(
      prisma,
      'user-1',
      new Date('2026-09-16T02:00:00.000Z'),
    );

    expect(findManySettlements).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ request: { userId: 'user-1' } }),
    }));
    expect(membership?.quotas).toEqual([{
      type: 'IMAGE_COUNT',
      canonicalModelId: 'model-image',
      modelName: 'Seedream 5 Pro',
      period: 'DAILY',
      limit: 20,
      used: 7,
      remaining: 13,
      resetAt: '2026-09-16T16:00:00.000Z',
    }, {
      type: 'LLM_TOKENS',
      canonicalModelId: 'model-chat',
      modelName: 'GPT-5.6 Sol',
      period: 'MONTHLY',
      limit: 1_000_000,
      used: 473_000,
      remaining: 527_000,
      resetAt: '2026-09-30T16:00:00.000Z',
    }]);
    expect(membership?.plan).toEqual({ id: 'plan-1', code: 'pro', name: 'Pro', description: null });
    expect(membership).not.toHaveProperty('provider');
    expect(membership).not.toHaveProperty('routeId');
  });

  it('validates quota definitions and calculates CST boundaries on the server', () => {
    expect(parseMembershipQuotaDefinitions({
      quotas: [
        { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'MONTHLY', limit: '300' },
        { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'MONTHLY', limit: 300 },
        { type: 'LLM_TOKENS', canonicalModelId: '', period: 'DAILY', limit: 10 },
      ],
    })).toEqual([
      { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'MONTHLY', limit: 300 },
    ]);
    expect(membershipQuotaPeriodRange(
      'DAILY',
      new Date('2026-09-16T02:00:00.000Z'),
    )).toEqual({
      start: new Date('2026-09-15T16:00:00.000Z'),
      end: new Date('2026-09-16T16:00:00.000Z'),
    });
  });

  it('stores free quotas only against matching canonical model modalities', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const transaction = {
      aiModel: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'model-image', modality: 'image' },
          { id: 'model-chat', modality: 'chat' },
        ]),
      },
      membershipPlan: { create },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    } as never;
    const freeQuota = {
      quotas: [
        { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'DAILY', limit: 20 },
        { type: 'LLM_TOKENS', canonicalModelId: 'model-chat', period: 'MONTHLY', limit: 1_000_000 },
      ],
    } as Prisma.InputJsonValue;

    await expect(createMembershipPlan(prisma, {
      code: 'pro',
      name: 'Pro',
      prices: {},
      freeQuota,
    })).resolves.toEqual({ id: 'plan-1' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ freeQuota }) },
      }),
    }));
  });

  it('rejects a token quota bound to an image canonical model', async () => {
    const transaction = {
      aiModel: {
        findMany: vi.fn().mockResolvedValue([{ id: 'model-image', modality: 'image' }]),
      },
      membershipPlan: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    } as never;

    await expect(createMembershipPlan(prisma, {
      code: 'pro',
      name: 'Pro',
      prices: {},
      freeQuota: {
        quotas: [{
          type: 'LLM_TOKENS',
          canonicalModelId: 'model-image',
          period: 'MONTHLY',
          limit: 1_000_000,
        }],
      },
    })).rejects.toMatchObject({ code: 'quota_model_mismatch', statusCode: 400 });
    expect(transaction.membershipPlan.create).not.toHaveBeenCalled();
  });

  it('blocks binding after credits have been granted', async () => {
    const prisma = {
      wallet: { findUnique: vi.fn().mockResolvedValue({ lifetimeGranted: new Prisma.Decimal('1') }) },
      aiRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;
    await expect(getReferralBindingEligibility(prisma, 'user-1')).resolves.toEqual({
      allowed: false,
      reason: 'credits_received',
    });
  });

  it('blocks binding after a successful image request', async () => {
    const prisma = {
      wallet: { findUnique: vi.fn().mockResolvedValue({ lifetimeGranted: new Prisma.Decimal(0) }) },
      aiRequest: { findFirst: vi.fn().mockResolvedValue({ id: 'request-1' }) },
    } as never;
    await expect(getReferralBindingEligibility(prisma, 'user-1')).resolves.toEqual({
      allowed: false,
      reason: 'image_generated',
    });
  });

  it('allows binding for a new account with no credits or image requests', async () => {
    const prisma = {
      wallet: { findUnique: vi.fn().mockResolvedValue({ lifetimeGranted: new Prisma.Decimal(0) }) },
      aiRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;
    await expect(getReferralBindingEligibility(prisma, 'user-1')).resolves.toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('rewards the inviter when an invitee redeems a qualifying recharge', async () => {
    const wallets = new Map<string, { availableCredits: Prisma.Decimal }>();
    const transaction = {
      referralRewardEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'reward-1',
          inviterCredits: new Prisma.Decimal('25'),
          inviteeCredits: new Prisma.Decimal('5'),
        }),
      },
      referralRelation: {
        findUnique: vi.fn().mockResolvedValue({ id: 'relation-1', inviterId: 'inviter', inviteeId: 'invitee' }),
      },
      referralRewardRule: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'rule-1',
          active: true,
          minRecharge: new Prisma.Decimal('100'),
          inviterCredits: new Prisma.Decimal('25'),
          inviteeCredits: new Prisma.Decimal('5'),
        }),
      },
      wallet: {
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const current = wallets.get(where.userId);
          if (current) {
            current.availableCredits = current.availableCredits.plus(update.availableCredits.increment);
            return current;
          }
          const next = { availableCredits: new Prisma.Decimal(create.availableCredits) };
          wallets.set(where.userId, next);
          return next;
        }),
      },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    const result = await rewardReferralOnRecharge(transaction, {
      inviteeId: 'invitee',
      rechargeCredits: '100',
      eventKey: 'recharge:test-1',
    });
    expect(result).toEqual({ id: 'reward-1', inviterCredits: '25.000000', inviteeCredits: '5.000000' });
    expect(transaction.walletLedger.create).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PricingSnapshot } from '../src/modules/ai/pricing-center.js';
import {
  applyMembershipQuotaCharge,
  membershipQuotaSettlementUnits,
  releaseMembershipQuota,
  reserveMembershipQuota,
  settleMembershipQuota,
  withMembershipQuota,
  type MembershipQuotaReservationSnapshot,
} from '../src/modules/membership/quota-billing.js';
import { membershipQuotaPeriodRange } from '../src/modules/membership/service.js';

const imageSnapshot = (canonicalModelId = 'model-image'): PricingSnapshot => ({
  schemaVersion: 1,
  canonicalModelId,
  canonicalModelKey: 'seedream-5-pro',
  modality: 'image',
  routeId: 'route-image',
  priceVersionId: 'price-image',
  priceVersion: 1,
  billingType: 'image_count',
  pricing: { billingType: 'image_count', creditsPerImage: '1.000000' },
  request: { count: 13, resolution: '2k' },
  capturedAt: '2026-09-16T02:00:00.000Z',
  membershipId: 'membership-1',
  membershipPlanId: 'plan-1',
  membershipPlanVersionId: 'version-1',
});

const quotaMembership = (freeQuota: unknown) => ({
  id: 'membership-1',
  userId: 'user-1',
  planId: 'plan-1',
  status: 'ACTIVE',
  startsAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  plan: {
    id: 'plan-1',
    versions: [{ id: 'version-1', freeQuota }],
  },
});

const imageBreakdown = (count: number, totalCredits = String(count)) => ({
  schemaVersion: 1 as const,
  model: 'seedream-5-pro',
  modality: 'image' as const,
  route: 'route-image',
  priceVersion: 1,
  billingType: 'image_count',
  quantity: String(count),
  baseCharge: totalCredits,
  surcharges: [],
  totalCredits,
  details: { generatedCount: count },
});

describe('membership quota billing', () => {
  it('reserves the smallest remaining image allowance across daily and monthly periods', async () => {
    const now = new Date('2026-09-16T02:00:00.000Z');
    const daily = membershipQuotaPeriodRange('DAILY', now);
    const monthly = membershipQuotaPeriodRange('MONTHLY', now);
    const membership = quotaMembership({
      quotas: [
        { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'DAILY', limit: 20 },
        { type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'MONTHLY', limit: 100 },
      ],
    });
    const activeReservation: MembershipQuotaReservationSnapshot = {
      membershipId: 'membership-1',
      membershipPlanId: 'plan-1',
      membershipPlanVersionId: 'version-1',
      type: 'IMAGE_COUNT',
      canonicalModelId: 'model-image',
      periods: [
        {
          period: 'DAILY',
          startAt: daily.start.toISOString(),
          usageStartAt: daily.start.toISOString(),
          resetAt: daily.end.toISOString(),
          limit: '20',
        },
        {
          period: 'MONTHLY',
          startAt: monthly.start.toISOString(),
          usageStartAt: monthly.start.toISOString(),
          resetAt: monthly.end.toISOString(),
          limit: '100',
        },
      ],
      reservedUnits: '2',
    };
    const lock = vi.fn().mockResolvedValue([]);
    const transaction = {
      $queryRaw: lock,
      userMembership: { findFirst: vi.fn().mockResolvedValue(membership) },
      aiBillingSettlement: {
        findMany: vi.fn().mockResolvedValue([
          { createdAt: new Date('2026-09-16T01:00:00.000Z'), breakdown: imageBreakdown(7) },
          { createdAt: new Date('2026-09-10T01:00:00.000Z'), breakdown: imageBreakdown(50) },
        ]),
      },
      aiRequest: {
        findMany: vi.fn().mockResolvedValue([
          { pricingSnapshot: withMembershipQuota(imageSnapshot(), activeReservation) },
        ]),
      },
    } as never;

    const quota = await reserveMembershipQuota(transaction, {
      userId: 'user-1',
      snapshot: imageSnapshot(),
      requestedUnits: 13n,
      now,
    });

    expect(lock).toHaveBeenCalledOnce();
    expect(quota).toMatchObject({
      membershipId: 'membership-1',
      canonicalModelId: 'model-image',
      type: 'IMAGE_COUNT',
      reservedUnits: '11',
    });
    expect(quota?.periods.map(period => period.period)).toEqual(['DAILY', 'MONTHLY']);
  });

  it('makes only the image units above quota billable after membership pricing is applied', () => {
    const quota: MembershipQuotaReservationSnapshot = {
      membershipId: 'membership-1',
      membershipPlanId: 'plan-1',
      membershipPlanVersionId: 'version-1',
      type: 'IMAGE_COUNT',
      canonicalModelId: 'model-image',
      periods: [{
        period: 'DAILY',
        startAt: '2026-09-15T16:00:00.000Z',
        usageStartAt: '2026-09-15T16:00:00.000Z',
        resetAt: '2026-09-16T16:00:00.000Z',
        limit: '20',
      }],
      reservedUnits: '11',
    };
    // 6.5 credits represents the already-discounted member price. Quota then
    // covers 11/13 images, leaving exactly 1 credit billable.
    const charged = applyMembershipQuotaCharge(imageBreakdown(13, '6.500000'), quota, 13n, 11n);

    expect(charged.totalCredits).toBe('1.000000');
    expect(charged.details.membershipQuota).toMatchObject({
      canonicalModelId: 'model-image',
      freeUnits: '11',
      billableUnits: '2',
      grossCredits: '6.500000',
      discountCredits: '5.500000',
    });
  });

  it('settles LLM quota from completed usage without double-counting cached input tokens', async () => {
    const quota: MembershipQuotaReservationSnapshot = {
      membershipId: 'membership-1',
      membershipPlanId: 'plan-1',
      membershipPlanVersionId: 'version-1',
      type: 'LLM_TOKENS',
      canonicalModelId: 'model-chat',
      periods: [{
        period: 'MONTHLY',
        startAt: '2026-08-31T16:00:00.000Z',
        usageStartAt: '2026-08-31T16:00:00.000Z',
        resetAt: '2026-09-30T16:00:00.000Z',
        limit: '1000',
      }],
      reservedUnits: '0',
    };
    const breakdown = {
      schemaVersion: 1 as const,
      model: 'gpt-5.6-sol',
      modality: 'chat' as const,
      route: 'route-chat',
      priceVersion: 1,
      billingType: 'token',
      quantity: '700',
      baseCharge: '7.000000',
      surcharges: [],
      totalCredits: '7.000000',
      details: {
        usage: {
          inputTokens: '500',
          cachedInputTokens: '400',
          cacheWriteTokens: '100',
          outputTokens: '100',
        },
      },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      aiBillingSettlement: {
        findMany: vi.fn().mockResolvedValue([{
          createdAt: new Date('2026-09-10T00:00:00.000Z'),
          breakdown: {
            details: { usage: { inputTokens: '300', cacheWriteTokens: '50', outputTokens: '50' } },
          },
        }]),
      },
      aiRequest: { findMany: vi.fn().mockResolvedValue([]) },
    } as never;

    const actualUnits = membershipQuotaSettlementUnits('LLM_TOKENS', breakdown);
    const freeUnits = await settleMembershipQuota(
      transaction,
      'user-1',
      withMembershipQuota({ ...imageSnapshot('model-chat'), modality: 'chat' }, quota),
      actualUnits,
    );
    const charged = applyMembershipQuotaCharge(breakdown, quota, actualUnits, freeUnits);

    expect(actualUnits).toBe(700n);
    expect(freeUnits).toBe(600n);
    expect(charged.totalCredits).toBe('1.000000');
    expect(charged.details.membershipQuota).toMatchObject({
      canonicalModelId: 'model-chat',
      freeUnits: '600',
      billableUnits: '100',
    });
  });

  it('does not reserve quota for a different canonical model or an exhausted allowance', async () => {
    const now = new Date('2026-09-16T02:00:00.000Z');
    const membership = quotaMembership({
      quotas: [{ type: 'IMAGE_COUNT', canonicalModelId: 'model-image', period: 'DAILY', limit: 7 }],
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      userMembership: { findFirst: vi.fn().mockResolvedValue(membership) },
      aiBillingSettlement: {
        findMany: vi.fn().mockResolvedValue([{
          createdAt: new Date('2026-09-16T01:00:00.000Z'),
          breakdown: imageBreakdown(7),
        }]),
      },
      aiRequest: { findMany: vi.fn().mockResolvedValue([]) },
    } as never;

    await expect(reserveMembershipQuota(transaction, {
      userId: 'user-1',
      snapshot: imageSnapshot('another-model'),
      requestedUnits: 1n,
      now,
    })).resolves.toBeNull();
    await expect(reserveMembershipQuota(transaction, {
      userId: 'user-1',
      snapshot: imageSnapshot(),
      requestedUnits: 1n,
      now,
    })).resolves.toBeNull();
  });

  it('locks the membership while releasing a failed reservation', async () => {
    const lock = vi.fn().mockResolvedValue([]);
    const transaction = { $queryRaw: lock } as never;
    const quota: MembershipQuotaReservationSnapshot = {
      membershipId: 'membership-1',
      membershipPlanId: 'plan-1',
      membershipPlanVersionId: 'version-1',
      type: 'IMAGE_COUNT',
      canonicalModelId: 'model-image',
      periods: [{
        period: 'DAILY',
        startAt: '2026-09-15T16:00:00.000Z',
        usageStartAt: '2026-09-15T16:00:00.000Z',
        resetAt: '2026-09-16T16:00:00.000Z',
        limit: '20',
      }],
      reservedUnits: '2',
    };

    await releaseMembershipQuota(transaction, withMembershipQuota(imageSnapshot(), quota));

    expect(lock).toHaveBeenCalledOnce();
  });
});

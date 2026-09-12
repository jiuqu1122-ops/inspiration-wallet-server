import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  getMembershipForUser,
  getReferralBindingEligibility,
  normalizeInviteCode,
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

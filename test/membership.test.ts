import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  getMembershipForUser,
  getReferralBindingEligibility,
  normalizeInviteCode,
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
});

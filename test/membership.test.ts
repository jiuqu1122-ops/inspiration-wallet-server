import { describe, expect, it, vi } from 'vitest';
import { getMembershipForUser, normalizeInviteCode, validateReferralCode } from '../src/modules/membership/service.js';

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
});

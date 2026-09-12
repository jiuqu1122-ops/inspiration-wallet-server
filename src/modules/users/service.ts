import type { PrismaClient } from '@prisma/client';
import { serializeWalletBalance } from '../wallets/serialization.js';
import { getMembershipForUser, ensureReferralProfile } from '../membership/service.js';

export async function getAccountSnapshot(
  prisma: PrismaClient,
  userId: string,
  licenseId?: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      wallet: {
        select: {
          availableCredits: true,
          reservedCredits: true,
          lifetimeGranted: true,
          lifetimeConsumed: true,
        },
      },
      licenses: {
        where: licenseId ? { id: licenseId } : { id: '__no_legacy_license__' },
        take: 1,
        select: {
          id: true,
          status: true,
          edition: true,
          features: true,
          expiresAt: true,
        },
      },
    },
  });

  const license = user?.licenses[0];
  if (!user) {
    return null;
  }

  const effectiveLicenseStatus = license
    ? license.expiresAt !== null && license.expiresAt < new Date() ? 'EXPIRED' : license.status
    : null;

  const membership = await getMembershipForUser(prisma, user.id);
  const referral = await ensureReferralProfile(prisma, user.id);
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    license: license ? {
      id: license.id,
      status: effectiveLicenseStatus,
      edition: license.edition,
      features: license.features,
      expiresAt: license.expiresAt,
    } : null,
    membership,
    referral: { inviteCode: referral.inviteCode },
    wallet: user.wallet ? serializeWalletBalance(user.wallet) : null,
  };
}

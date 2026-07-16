import type { PrismaClient } from '@prisma/client';

export async function getAccountSnapshot(
  prisma: PrismaClient,
  userId: string,
  licenseId: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
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
        where: { id: licenseId },
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
  if (!user || !license) {
    return null;
  }

  const effectiveLicenseStatus =
    license.expiresAt !== null && license.expiresAt < new Date() ? 'EXPIRED' : license.status;

  return {
    user: {
      id: user.id,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    license: {
      id: license.id,
      status: effectiveLicenseStatus,
      edition: license.edition,
      features: license.features,
      expiresAt: license.expiresAt,
    },
    wallet: user.wallet
      ? {
          availableCredits: user.wallet.availableCredits.toString(),
          reservedCredits: user.wallet.reservedCredits.toString(),
          lifetimeGranted: user.wallet.lifetimeGranted.toString(),
          lifetimeConsumed: user.wallet.lifetimeConsumed.toString(),
        }
      : null,
  };
}

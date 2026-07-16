import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { resolveLicenseIdentity } from '../auth/service.js';
import { verifySignedLicenseForProvision } from '../auth/license-verifier.js';
import { serializeWalletBalance } from '../wallets/serialization.js';

export class AdminServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AdminServiceError';
  }
}

function serializeLicense(license: {
  id: string;
  customer: string | null;
  status: string;
  edition: string | null;
  features: string[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...license,
    expiresAt: license.expiresAt?.toISOString() ?? null,
    createdAt: license.createdAt.toISOString(),
    updatedAt: license.updatedAt.toISOString(),
  };
}

export async function getAdminOverview(prisma: PrismaClient) {
  const now = new Date();
  const [users, activeUsers, activeLicenses, walletTotals] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.license.count({
      where: { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    prisma.wallet.aggregate({
      _sum: {
        availableCredits: true,
        reservedCredits: true,
        lifetimeGranted: true,
        lifetimeConsumed: true,
      },
    }),
  ]);

  return {
    status: 'ok',
    adminApi: 'enabled',
    users: { total: users, active: activeUsers },
    licenses: { active: activeLicenses },
    credits: {
      available: (walletTotals._sum.availableCredits ?? 0n).toString(),
      reserved: (walletTotals._sum.reservedCredits ?? 0n).toString(),
      lifetimeGranted: (walletTotals._sum.lifetimeGranted ?? 0n).toString(),
      lifetimeConsumed: (walletTotals._sum.lifetimeConsumed ?? 0n).toString(),
    },
  };
}

export async function listAdminUsers(
  prisma: PrismaClient,
  input: { query?: string | undefined; cursor?: string | undefined; limit: number },
) {
  const query = input.query?.trim();
  const users = await prisma.user.findMany({
    ...(query
      ? { where: {
          OR: [
            { id: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
            { displayName: { contains: query, mode: 'insensitive' } },
            { licenses: { some: { customer: { contains: query, mode: 'insensitive' } } } },
          ],
        } }
      : {}),
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerifiedAt: true,
      entitlementExpiresAt: true,
      entitlementEdition: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      wallet: true,
      licenses: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          customer: true,
          status: true,
          edition: true,
          features: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  const hasMore = users.length > input.limit;
  const page = hasMore ? users.slice(0, input.limit) : users;

  return {
    items: page.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      entitlementExpiresAt: user.entitlementExpiresAt?.toISOString() ?? null,
      entitlementEdition: user.entitlementEdition,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      wallet: user.wallet ? serializeWalletBalance(user.wallet) : null,
      license: user.licenses[0] ? serializeLicense(user.licenses[0]) : null,
    })),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}

export async function getAdminUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerifiedAt: true,
      entitlementExpiresAt: true,
      entitlementEdition: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      wallet: true,
      licenses: {
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          customer: true,
          status: true,
          edition: true,
          features: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      ledger: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
        },
      },
    },
  });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    entitlementExpiresAt: user.entitlementExpiresAt?.toISOString() ?? null,
    entitlementEdition: user.entitlementEdition,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    wallet: user.wallet ? serializeWalletBalance(user.wallet) : null,
    licenses: user.licenses.map(serializeLicense),
    ledger: user.ledger.map((entry) => ({
      ...entry,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

async function replayOperation(prisma: PrismaClient, idempotencyKey: string) {
  const operation = await prisma.adminOperation.findUnique({ where: { idempotencyKey } });
  return operation?.result ?? null;
}

export async function provisionAdminLicense(
  app: FastifyInstance,
  input: { license: string; idempotencyKey: string },
) {
  const replayed = await replayOperation(app.prisma, input.idempotencyKey);
  if (replayed) return { replayed: true, result: replayed };

  const verified = verifySignedLicenseForProvision(input.license);
  let identity: { userId: string; licenseId: string };
  try {
    identity = await resolveLicenseIdentity(app, verified, false);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const existing = await app.prisma.license.findUnique({ where: { codeHash: verified.codeHash } });
    if (!existing) throw error;
    identity = { userId: existing.userId, licenseId: existing.id };
  }

  const user = await getAdminUser(app.prisma, identity.userId);
  if (!user) throw new Error('Provisioned user could not be loaded');
  const result = { user, licenseId: identity.licenseId };

  try {
    await app.prisma.adminOperation.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        type: 'PROVISION_LICENSE',
        userId: identity.userId,
        description: `Provision ${verified.customer}`,
        result,
      },
    });
    return { replayed: false, result };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrent = await replayOperation(app.prisma, input.idempotencyKey);
      if (concurrent) return { replayed: true, result: concurrent };
    }
    throw error;
  }
}

export async function grantAdminCredits(
  prisma: PrismaClient,
  input: { userId: string; amount: bigint; description: string; idempotencyKey: string },
) {
  const replayed = await replayOperation(prisma, input.idempotencyKey);
  if (replayed) return { replayed: true, result: replayed };

  try {
    const result = await prisma.$transaction(
      async (transaction) => {
        const existing = await transaction.adminOperation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return existing.result;

        const wallet = await transaction.wallet.findUnique({ where: { userId: input.userId } });
        if (!wallet) {
          throw new AdminServiceError('user_not_found', 'User wallet was not found', 404);
        }
        const updated = await transaction.wallet.update({
          where: { userId: input.userId },
          data: {
            availableCredits: { increment: input.amount },
            lifetimeGranted: { increment: input.amount },
          },
        });
        const ledger = await transaction.walletLedger.create({
          data: {
            userId: input.userId,
            type: 'GRANT',
            amount: input.amount,
            balanceAfter: updated.availableCredits,
            description: input.description,
          },
        });
        const operationResult = {
          userId: input.userId,
          grantedCredits: input.amount.toString(),
          wallet: serializeWalletBalance(updated),
          ledger: {
            id: ledger.id,
            type: ledger.type,
            amount: ledger.amount.toString(),
            balanceAfter: ledger.balanceAfter.toString(),
            description: ledger.description,
            createdAt: ledger.createdAt.toISOString(),
          },
        };
        await transaction.adminOperation.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            type: 'GRANT_CREDITS',
            userId: input.userId,
            amount: input.amount,
            description: input.description,
            result: operationResult,
          },
        });
        return operationResult;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { replayed: false, result };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrent = await replayOperation(prisma, input.idempotencyKey);
      if (concurrent) return { replayed: true, result: concurrent };
    }
    throw error;
  }
}

function authorizationExpiration(value: string) {
  const expiresAt = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 10) !== value) {
    throw new AdminServiceError('invalid_expiration', 'Authorization expiration is invalid', 400);
  }
  return expiresAt;
}

export async function updateAdminAuthorization(
  prisma: PrismaClient,
  input: {
    userId: string;
    displayName?: string | undefined;
    expiresAt?: string | undefined;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | undefined;
    idempotencyKey: string;
  },
) {
  const replayed = await replayOperation(prisma, input.idempotencyKey);
  if (replayed) {
    const user = await getAdminUser(prisma, input.userId);
    return { replayed: true, result: { user } };
  }

  await prisma.$transaction(
    async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: input.userId } });
      if (!user) throw new AdminServiceError('user_not_found', 'User was not found', 404);
      const expiresAt = input.expiresAt
        ? authorizationExpiration(input.expiresAt)
        : user.entitlementExpiresAt;
      const licenseStatus = input.status && input.status !== 'ACTIVE'
        ? 'REVOKED'
        : expiresAt && expiresAt < new Date()
          ? 'EXPIRED'
          : 'ACTIVE';

      await transaction.user.update({
        where: { id: user.id },
        data: {
          ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
          ...(expiresAt ? { entitlementExpiresAt: expiresAt } : {}),
          entitlementEdition: 'ENTERPRISE',
          entitlementFeatures: ['*'],
          ...(input.status ? { status: input.status } : {}),
        },
      });
      await transaction.license.updateMany({
        where: {
          userId: user.id,
          OR: [{ id: { startsWith: 'emaildev_' } }, { id: { startsWith: 'trial_' } }],
        },
        data: {
          ...(input.displayName ? { customer: input.displayName.trim() } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          edition: 'ENTERPRISE',
          features: ['*'],
          status: licenseStatus,
        },
      });
      await transaction.adminOperation.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: 'UPDATE_AUTHORIZATION',
          userId: user.id,
          description: 'Update account authorization',
          result: { userId: user.id },
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  const user = await getAdminUser(prisma, input.userId);
  if (!user) throw new Error('Updated user could not be loaded');
  return { replayed: false, result: { user } };
}

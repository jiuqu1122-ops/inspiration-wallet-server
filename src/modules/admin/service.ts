import { Prisma, type AiCapability, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { resolveLicenseIdentity } from '../auth/service.js';
import { verifySignedLicenseForProvision } from '../auth/license-verifier.js';
import { serializeWalletBalance } from '../wallets/serialization.js';
import { creditDecimal, serializeCredit } from '../wallets/credit-amount.js';

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

const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAILY_IMAGE_CAPABILITIES: AiCapability[] = [
  'IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_NANO_BANANA_2',
  'IMAGE_NANO_BANANA_PRO_FAST',
  'IMAGE_NANO_BANANA_2_FAST',
  'IMAGE_NANO_BANANA_PRO_1K',
  'IMAGE_NANO_BANANA_DUAL_2K',
  'IMAGE_GPT',
  'IMAGE_GPT_1K',
  'IMAGE_GROK',
];
const DAILY_TOKEN_CAPABILITIES: AiCapability[] = ['LLM', 'VISION'];

type DailyImageModelUsage = {
  key: string;
  displayName: string;
  imageRequests: number;
  imageCount: bigint;
};

type DailyUserUsage = {
  userId: string;
  email: string | null;
  displayName: string | null;
  status: string;
  imageRequests: number;
  imageCount: bigint;
  imageModels: Map<string, DailyImageModelUsage>;
  tokenRequests: number;
  tokenRequestsWithUsage: number;
  tokenRequestsWithoutUsage: number;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  cacheWriteTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
};

const jsonObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const usageCount = (value: unknown) => {
  const text = typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
};

const chinaStandardDayRange = (now: Date) => {
  const shifted = new Date(now.getTime() + CHINA_STANDARD_TIME_OFFSET_MS);
  const shiftedStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const start = new Date(shiftedStart - CHINA_STANDARD_TIME_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  return { start, end, date: shifted.toISOString().slice(0, 10) };
};

const tokenUsageFromBreakdown = (value: unknown) => {
  const breakdown = jsonObject(value);
  const details = jsonObject(breakdown?.details);
  const usage = jsonObject(details?.usage) ?? jsonObject(breakdown?.usage);
  if (!usage) return null;
  const inputTokens = usageCount(usage.inputTokens);
  const cachedInputTokens = usageCount(usage.cachedInputTokens);
  const cacheWriteTokens = usageCount(usage.cacheWriteTokens);
  const outputTokens = usageCount(usage.outputTokens);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + cacheWriteTokens + outputTokens,
  };
};

export async function getAdminTodayUsage(prisma: PrismaClient, now = new Date()) {
  const range = chinaStandardDayRange(now);
  const requests = await prisma.aiRequest.findMany({
    where: {
      status: 'SUCCEEDED',
      createdAt: { gte: range.start, lt: range.end },
      capability: { in: [...DAILY_IMAGE_CAPABILITIES, ...DAILY_TOKEN_CAPABILITIES] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      capability: true,
      logicalModel: true,
      chargeBreakdown: true,
      canonicalModel: { select: { canonicalModelKey: true, displayName: true } },
      user: { select: { id: true, email: true, displayName: true, status: true } },
    },
  });
  const imageCapabilities = new Set<string>(DAILY_IMAGE_CAPABILITIES);
  const tokenCapabilities = new Set<string>(DAILY_TOKEN_CAPABILITIES);
  const byUser = new Map<string, DailyUserUsage>();

  for (const request of requests) {
    const current = byUser.get(request.user.id) ?? {
      userId: request.user.id,
      email: request.user.email,
      displayName: request.user.displayName,
      status: request.user.status,
      imageRequests: 0,
      imageCount: 0n,
      imageModels: new Map<string, DailyImageModelUsage>(),
      tokenRequests: 0,
      tokenRequestsWithUsage: 0,
      tokenRequestsWithoutUsage: 0,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      cacheWriteTokens: 0n,
      outputTokens: 0n,
      totalTokens: 0n,
    };
    if (imageCapabilities.has(request.capability)) {
      const quantity = usageCount(jsonObject(request.chargeBreakdown)?.quantity);
      const modelKey = request.canonicalModel?.canonicalModelKey?.trim()
        || request.logicalModel.trim()
        || 'unknown';
      const modelUsage = current.imageModels.get(modelKey) ?? {
        key: modelKey,
        displayName: request.canonicalModel?.displayName?.trim() || request.logicalModel.trim() || '未知模型',
        imageRequests: 0,
        imageCount: 0n,
      };
      current.imageRequests += 1;
      current.imageCount += quantity > 0n ? quantity : 1n;
      modelUsage.imageRequests += 1;
      modelUsage.imageCount += quantity > 0n ? quantity : 1n;
      current.imageModels.set(modelKey, modelUsage);
    }
    if (tokenCapabilities.has(request.capability)) {
      const usage = tokenUsageFromBreakdown(request.chargeBreakdown);
      current.tokenRequests += 1;
      if (usage) {
        current.tokenRequestsWithUsage += 1;
        current.inputTokens += usage.inputTokens;
        current.cachedInputTokens += usage.cachedInputTokens;
        current.cacheWriteTokens += usage.cacheWriteTokens;
        current.outputTokens += usage.outputTokens;
        current.totalTokens += usage.totalTokens;
      } else {
        current.tokenRequestsWithoutUsage += 1;
      }
    }
    byUser.set(request.user.id, current);
  }

  const rows = [...byUser.values()].sort((left, right) => {
    if (left.imageCount !== right.imageCount) return left.imageCount > right.imageCount ? -1 : 1;
    if (left.totalTokens !== right.totalTokens) return left.totalTokens > right.totalTokens ? -1 : 1;
    return (left.displayName || left.email || left.userId)
      .localeCompare(right.displayName || right.email || right.userId, 'zh-CN');
  });
  const totals = rows.reduce((result, row) => ({
    imageRequests: result.imageRequests + row.imageRequests,
    imageCount: result.imageCount + row.imageCount,
    tokenRequests: result.tokenRequests + row.tokenRequests,
    tokenRequestsWithUsage: result.tokenRequestsWithUsage + row.tokenRequestsWithUsage,
    tokenRequestsWithoutUsage: result.tokenRequestsWithoutUsage + row.tokenRequestsWithoutUsage,
    inputTokens: result.inputTokens + row.inputTokens,
    cachedInputTokens: result.cachedInputTokens + row.cachedInputTokens,
    cacheWriteTokens: result.cacheWriteTokens + row.cacheWriteTokens,
    outputTokens: result.outputTokens + row.outputTokens,
    totalTokens: result.totalTokens + row.totalTokens,
  }), {
    imageRequests: 0,
    imageCount: 0n,
    tokenRequests: 0,
    tokenRequestsWithUsage: 0,
    tokenRequestsWithoutUsage: 0,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    cacheWriteTokens: 0n,
    outputTokens: 0n,
    totalTokens: 0n,
  });
  const serializeCounts = <T extends {
    imageCount: bigint;
    imageModels?: Map<string, DailyImageModelUsage>;
    inputTokens: bigint;
    cachedInputTokens: bigint;
    cacheWriteTokens: bigint;
    outputTokens: bigint;
    totalTokens: bigint;
  }>(value: T) => {
    const { imageModels, ...counts } = value;
    return {
      ...counts,
      imageCount: value.imageCount.toString(),
      inputTokens: value.inputTokens.toString(),
      cachedInputTokens: value.cachedInputTokens.toString(),
      cacheWriteTokens: value.cacheWriteTokens.toString(),
      outputTokens: value.outputTokens.toString(),
      totalTokens: value.totalTokens.toString(),
      ...(imageModels ? {
        imageModels: [...imageModels.values()]
          .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
          .map((model) => ({ ...model, imageCount: model.imageCount.toString() })),
      } : {}),
    };
  };

  const imageModels = new Map<string, DailyImageModelUsage>();
  for (const row of rows) {
    for (const model of row.imageModels.values()) {
      const current = imageModels.get(model.key) ?? {
        key: model.key,
        displayName: model.displayName,
        imageRequests: 0,
        imageCount: 0n,
      };
      current.imageRequests += model.imageRequests;
      current.imageCount += model.imageCount;
      imageModels.set(model.key, current);
    }
  }

  return {
    date: range.date,
    timeZone: 'Asia/Shanghai',
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    generatedAt: now.toISOString(),
    totals: {
      activeUsers: rows.length,
      ...serializeCounts(totals),
      imageModels: [...imageModels.values()]
        .sort((left, right) => {
          if (left.imageCount !== right.imageCount) return left.imageCount > right.imageCount ? -1 : 1;
          return left.displayName.localeCompare(right.displayName, 'zh-CN');
        })
        .map((model) => ({ ...model, imageCount: model.imageCount.toString() })),
    },
    items: rows.map(serializeCounts),
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
      available: serializeCredit(walletTotals._sum.availableCredits ?? 0),
      reserved: serializeCredit(walletTotals._sum.reservedCredits ?? 0),
      lifetimeGranted: serializeCredit(walletTotals._sum.lifetimeGranted ?? 0),
      lifetimeConsumed: serializeCredit(walletTotals._sum.lifetimeConsumed ?? 0),
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
      referralProfile: { select: { inviteCode: true } },
      memberships: {
        where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
        take: 1,
        select: { id: true, status: true, startsAt: true, expiresAt: true, plan: { select: { id: true, code: true, name: true } } },
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
      membership: user.memberships[0] ? {
        ...user.memberships[0],
        startsAt: user.memberships[0].startsAt.toISOString(),
        expiresAt: user.memberships[0].expiresAt.toISOString(),
      } : null,
      referral: user.referralProfile,
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
      referralProfile: { select: { inviteCode: true } },
      memberships: {
        where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
        take: 1,
        select: { id: true, status: true, startsAt: true, expiresAt: true, plan: { select: { id: true, code: true, name: true } } },
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
    membership: user.memberships[0] ? {
      ...user.memberships[0],
      startsAt: user.memberships[0].startsAt.toISOString(),
      expiresAt: user.memberships[0].expiresAt.toISOString(),
    } : null,
    referral: user.referralProfile,
    ledger: user.ledger.map((entry) => ({
      ...entry,
      amount: serializeCredit(entry.amount),
      balanceAfter: serializeCredit(entry.balanceAfter),
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
  const amount = creditDecimal(input.amount);
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
            availableCredits: { increment: amount },
            lifetimeGranted: { increment: amount },
          },
        });
        const ledger = await transaction.walletLedger.create({
          data: {
            userId: input.userId,
            type: 'GRANT',
            amount,
            balanceAfter: updated.availableCredits,
            description: input.description,
          },
        });
        const operationResult = {
          userId: input.userId,
          grantedCredits: serializeCredit(amount),
          wallet: serializeWalletBalance(updated),
          ledger: {
            id: ledger.id,
            type: ledger.type,
            amount: serializeCredit(ledger.amount),
            balanceAfter: serializeCredit(ledger.balanceAfter),
            description: ledger.description,
            createdAt: ledger.createdAt.toISOString(),
          },
        };
        await transaction.adminOperation.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            type: 'GRANT_CREDITS',
            userId: input.userId,
            amount,
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

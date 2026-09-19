import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export class RechargeSessionError extends Error {
  constructor(
    public readonly code: 'invalid_recharge_session' | 'expired_recharge_session',
    public readonly statusCode = 401,
  ) {
    super(code === 'expired_recharge_session' ? '充值会话已过期，请返回应用重试' : '充值会话无效或已使用');
    this.name = 'RechargeSessionError';
  }
}

export function hashRechargeSessionToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildRechargeSessionUrl(pageUrl: string, token: string) {
  const url = new URL(pageUrl);
  url.searchParams.set('session', token);
  return url.toString();
}

export async function createRechargeSession(
  prisma: PrismaClient,
  input: {
    userId: string;
    pageUrl: string;
    ttlMinutes: number;
    now?: Date;
    token?: string;
  },
) {
  const now = input.now ?? new Date();
  const token = input.token ?? randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);

  await prisma.$transaction(async (transaction) => {
    // Only the newest bootstrap link remains valid for an account. This also
    // prevents a previously abandoned iframe URL from being replayed later.
    await transaction.rechargeSession.updateMany({
      where: { userId: input.userId, consumedAt: null },
      data: { consumedAt: now },
    });
    await transaction.rechargeSession.create({
      data: {
        userId: input.userId,
        tokenHash: hashRechargeSessionToken(token),
        expiresAt,
      },
    });
  });

  return {
    url: buildRechargeSessionUrl(input.pageUrl, token),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function consumeRechargeSession(
  prisma: PrismaClient,
  input: { token: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const tokenHash = hashRechargeSessionToken(input.token);

  return prisma.$transaction(async (transaction) => {
    const session = await transaction.rechargeSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        consumedAt: true,
        user: {
          select: {
            email: true,
            displayName: true,
            wallet: { select: { availableCredits: true } },
          },
        },
      },
    });
    if (!session || session.consumedAt) {
      throw new RechargeSessionError('invalid_recharge_session');
    }
    if (session.expiresAt <= now) {
      throw new RechargeSessionError('expired_recharge_session');
    }

    const claimed = await transaction.rechargeSession.updateMany({
      where: {
        id: session.id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) {
      throw new RechargeSessionError('invalid_recharge_session');
    }

    return {
      expiresAt: session.expiresAt.toISOString(),
      account: {
        email: session.user.email,
        displayName: session.user.displayName,
        availableCredits: session.user.wallet?.availableCredits.toString() ?? '0',
      },
    };
  });
}

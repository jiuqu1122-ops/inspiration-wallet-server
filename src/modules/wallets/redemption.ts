import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { serializeWalletBalance } from './serialization.js';
import { creditDecimal, serializeCredit } from './credit-amount.js';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export class RedemptionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'RedemptionError';
  }
}

export function normalizeRedemptionCode(value: string) {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '');
}

export function hashRedemptionCode(value: string) {
  return createHash('sha256')
    .update('unmind-credit-redemption-v1\0')
    .update(normalizeRedemptionCode(value))
    .digest('hex');
}

function randomCodePart(length: number) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function createRedemptionCodeValue() {
  return `UNMIND-${randomCodePart(5)}-${randomCodePart(5)}-${randomCodePart(5)}`;
}

export async function createRedemptionCodes(
  prisma: PrismaClient,
  input: {
    credits: bigint;
    quantity: number;
    maxRedemptions: number;
    expiresAt?: Date | null;
    note?: string | null;
  },
) {
  const credits = creditDecimal(input.credits);
  const generated: Array<{ code: string; codeHint: string; id: string }> = [];
  for (let index = 0; index < input.quantity; index += 1) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createRedemptionCodeValue();
      const compact = normalizeRedemptionCode(code);
      try {
        const record = await prisma.creditRedemptionCode.create({
          data: {
            codeHash: hashRedemptionCode(code),
            codeHint: `••••-${compact.slice(-5)}`,
            credits,
            maxRedemptions: input.maxRedemptions,
            expiresAt: input.expiresAt ?? null,
            note: input.note ?? null,
          },
          select: { id: true, codeHint: true },
        });
        generated.push({ code, ...record });
        break;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === 'P2002'
          && attempt < 4
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  return generated;
}

export async function listRedemptionCodes(prisma: PrismaClient, limit = 100) {
  const codes = await prisma.creditRedemptionCode.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      codeHint: true,
      credits: true,
      maxRedemptions: true,
      redeemedCount: true,
      status: true,
      expiresAt: true,
      note: true,
      createdAt: true,
    },
  });
  return codes.map((code) => ({
    ...code,
    credits: serializeCredit(code.credits),
  }));
}

export async function redeemCredits(
  prisma: PrismaClient,
  input: { userId: string; code: string },
) {
  const normalized = normalizeRedemptionCode(input.code);
  if (!/^UNMIND[A-Z2-9]{15}$/.test(normalized)) {
    throw new RedemptionError('invalid_code', '兑换码格式不正确', 400);
  }

  return prisma.$transaction(
    async (transaction) => {
      const now = new Date();
      const code = await transaction.creditRedemptionCode.findUnique({
        where: { codeHash: hashRedemptionCode(normalized) },
      });
      if (!code) throw new RedemptionError('invalid_code', '兑换码不存在', 404);
      if (code.status !== 'ACTIVE') {
        throw new RedemptionError('code_disabled', '兑换码已停用', 409);
      }
      if (code.expiresAt && code.expiresAt <= now) {
        throw new RedemptionError('code_expired', '兑换码已过期', 409);
      }

      const previous = await transaction.creditRedemption.findUnique({
        where: { codeId_userId: { codeId: code.id, userId: input.userId } },
      });
      if (previous) {
        throw new RedemptionError('already_redeemed', '当前账号已经兑换过该兑换码', 409);
      }

      const claimed = await transaction.creditRedemptionCode.updateMany({
        where: {
          id: code.id,
          status: 'ACTIVE',
          redeemedCount: { lt: code.maxRedemptions },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { redeemedCount: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        throw new RedemptionError('code_exhausted', '兑换码已被使用完', 409);
      }

      await transaction.creditRedemption.create({
        data: { codeId: code.id, userId: input.userId, credits: code.credits },
      });
      const wallet = await transaction.wallet.update({
        where: { userId: input.userId },
        data: {
          availableCredits: { increment: code.credits },
          lifetimeGranted: { increment: code.credits },
        },
      });
      await transaction.walletLedger.create({
        data: {
          userId: input.userId,
          type: 'GRANT',
          amount: code.credits,
          balanceAfter: wallet.availableCredits,
          description: `兑换码充值 ${code.codeHint}`,
        },
      });

      return {
        redeemedCredits: serializeCredit(code.credits),
        wallet: serializeWalletBalance(wallet),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

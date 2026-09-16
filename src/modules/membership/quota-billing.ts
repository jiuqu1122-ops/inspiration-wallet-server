import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  membershipQuotaPeriodRange,
  parseMembershipQuotaDefinitions,
  type MembershipQuotaPeriod,
  type MembershipQuotaType,
} from './service.js';
import {
  creditMicros,
  microsToCredit,
  type ChargeBreakdown,
  type PricingSnapshot,
} from '../ai/pricing-center.js';

type QuotaTransaction = Prisma.TransactionClient;

export type MembershipQuotaPeriodSnapshot = {
  period: MembershipQuotaPeriod;
  startAt: string;
  usageStartAt: string;
  resetAt: string;
  limit: string;
};

export type MembershipQuotaReservationSnapshot = {
  membershipId: string;
  membershipPlanId: string;
  membershipPlanVersionId: string;
  type: MembershipQuotaType;
  canonicalModelId: string;
  periods: MembershipQuotaPeriodSnapshot[];
  reservedUnits: string;
};

const jsonObject = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const nonNegativeUnits = (value: unknown) => {
  const text = typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (!/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
};

const isoDate = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export function membershipQuotaFromPricingSnapshot(
  value: unknown,
): MembershipQuotaReservationSnapshot | null {
  const snapshot = jsonObject(value);
  const quota = jsonObject(snapshot?.membershipQuota);
  if (!quota) return null;
  const membershipId = typeof quota.membershipId === 'string' ? quota.membershipId : '';
  const membershipPlanId = typeof quota.membershipPlanId === 'string' ? quota.membershipPlanId : '';
  const membershipPlanVersionId = typeof quota.membershipPlanVersionId === 'string'
    ? quota.membershipPlanVersionId
    : '';
  const canonicalModelId = typeof quota.canonicalModelId === 'string' ? quota.canonicalModelId : '';
  const type = quota.type;
  const candidates = Array.isArray(quota.periods) ? quota.periods : [];
  const periods = candidates.flatMap((candidate): MembershipQuotaPeriodSnapshot[] => {
    const period = jsonObject(candidate);
    const periodType = period?.period;
    const startAt = isoDate(period?.startAt);
    const usageStartAt = isoDate(period?.usageStartAt);
    const resetAt = isoDate(period?.resetAt);
    const limit = nonNegativeUnits(period?.limit);
    if ((periodType !== 'DAILY' && periodType !== 'MONTHLY')
      || !startAt
      || !usageStartAt
      || !resetAt
      || limit <= 0n) return [];
    return [{
      period: periodType,
      startAt: startAt.toISOString(),
      usageStartAt: usageStartAt.toISOString(),
      resetAt: resetAt.toISOString(),
      limit: limit.toString(),
    }];
  });
  if (!membershipId
    || !membershipPlanId
    || !membershipPlanVersionId
    || !canonicalModelId
    || (type !== 'IMAGE_COUNT' && type !== 'LLM_TOKENS')
    || periods.length === 0) return null;
  return {
    membershipId,
    membershipPlanId,
    membershipPlanVersionId,
    type,
    canonicalModelId,
    periods,
    reservedUnits: nonNegativeUnits(quota.reservedUnits).toString(),
  };
}

export const withMembershipQuota = (
  snapshot: PricingSnapshot,
  membershipQuota: MembershipQuotaReservationSnapshot | null,
): PricingSnapshot => membershipQuota
  ? { ...snapshot, membershipQuota }
  : snapshot;

export function membershipQuotaSettlementUnits(
  type: MembershipQuotaType,
  breakdown: unknown,
) {
  const value = jsonObject(breakdown);
  const details = jsonObject(value?.details);
  if (type === 'IMAGE_COUNT') {
    return nonNegativeUnits(details?.generatedCount ?? value?.quantity);
  }
  const usage = jsonObject(details?.usage) ?? jsonObject(value?.usage);
  if (!usage) return 0n;
  return nonNegativeUnits(usage.inputTokens)
    + nonNegativeUnits(usage.outputTokens)
    + nonNegativeUnits(usage.cacheWriteTokens);
}

async function lockMembership(transaction: QuotaTransaction, membershipId: string) {
  if (typeof transaction.$queryRaw !== 'function') return;
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "UserMembership"
    WHERE "id" = ${membershipId}
    FOR UPDATE
  `);
}

const matchingReservationUnits = (
  pricingSnapshot: unknown,
  expected: Pick<MembershipQuotaReservationSnapshot, 'membershipId' | 'canonicalModelId' | 'type'>,
  periodStart: string,
) => {
  const quota = membershipQuotaFromPricingSnapshot(pricingSnapshot);
  if (!quota
    || quota.membershipId !== expected.membershipId
    || quota.canonicalModelId !== expected.canonicalModelId
    || quota.type !== expected.type
    || !quota.periods.some(period => period.startAt === periodStart)) return 0n;
  return nonNegativeUnits(quota.reservedUnits);
};

async function availableQuotaUnits(
  transaction: QuotaTransaction,
  userId: string,
  quota: Omit<MembershipQuotaReservationSnapshot, 'reservedUnits'>,
) {
  const earliestStart = quota.periods.reduce((earliest, period) => {
    const current = new Date(period.usageStartAt);
    return current < earliest ? current : earliest;
  }, new Date(quota.periods[0]!.usageStartAt));
  const latestEnd = quota.periods.reduce((latest, period) => {
    const current = new Date(period.resetAt);
    return current > latest ? current : latest;
  }, new Date(quota.periods[0]!.resetAt));
  const [settlements, activeRequests] = await Promise.all([
    transaction.aiBillingSettlement.findMany({
      where: {
        canonicalModelId: quota.canonicalModelId,
        createdAt: { gte: earliestStart, lt: latestEnd },
        request: { userId },
      },
      select: { breakdown: true, createdAt: true },
    }),
    transaction.aiRequest.findMany({
      where: {
        userId,
        canonicalModelId: quota.canonicalModelId,
        status: { in: ['RESERVED', 'PROCESSING'] },
      },
      select: { pricingSnapshot: true },
    }),
  ]);

  return quota.periods.reduce<bigint | null>((minimum, period) => {
    const usageStart = new Date(period.usageStartAt);
    const resetAt = new Date(period.resetAt);
    const used = settlements.reduce((total, settlement) => (
      settlement.createdAt >= usageStart && settlement.createdAt < resetAt
        ? total + membershipQuotaSettlementUnits(quota.type, settlement.breakdown)
        : total
    ), 0n);
    const reserved = activeRequests.reduce((total, request) => (
      total + matchingReservationUnits(request.pricingSnapshot, quota, period.startAt)
    ), 0n);
    const remaining = BigInt(period.limit) - used - reserved;
    const available = remaining > 0n ? remaining : 0n;
    return minimum === null || available < minimum ? available : minimum;
  }, null) ?? 0n;
}

export async function reserveMembershipQuota(
  transaction: QuotaTransaction,
  input: {
    userId: string;
    snapshot: PricingSnapshot;
    requestedUnits: bigint;
    now?: Date;
  },
): Promise<MembershipQuotaReservationSnapshot | null> {
  if (!transaction.userMembership || !transaction.aiBillingSettlement || !transaction.aiRequest) return null;
  const now = input.now ?? new Date();
  const initial = await transaction.userMembership.findFirst({
    where: {
      userId: input.userId,
      status: 'ACTIVE',
      startsAt: { lte: now },
      expiresAt: { gt: now },
    },
    orderBy: { expiresAt: 'desc' },
    include: { plan: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } },
  });
  if (!initial) return null;
  await lockMembership(transaction, initial.id);
  const membership = await transaction.userMembership.findFirst({
    where: {
      id: initial.id,
      userId: input.userId,
      status: 'ACTIVE',
      startsAt: { lte: now },
      expiresAt: { gt: now },
    },
    include: { plan: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } },
  });
  const version = membership?.plan.versions[0];
  if (!membership || !version) return null;
  const type: MembershipQuotaType | null = input.snapshot.modality === 'image'
    ? 'IMAGE_COUNT'
    : input.snapshot.modality === 'chat'
      ? 'LLM_TOKENS'
      : null;
  if (!type) return null;
  const definitions = parseMembershipQuotaDefinitions(version.freeQuota).filter(definition => (
    definition.type === type && definition.canonicalModelId === input.snapshot.canonicalModelId
  ));
  if (definitions.length === 0) return null;
  const periods = definitions.map((definition): MembershipQuotaPeriodSnapshot => {
    const range = membershipQuotaPeriodRange(definition.period, now);
    const usageStart = membership.startsAt > range.start ? membership.startsAt : range.start;
    return {
      period: definition.period,
      startAt: range.start.toISOString(),
      usageStartAt: usageStart.toISOString(),
      resetAt: range.end.toISOString(),
      limit: String(definition.limit),
    };
  });
  const quota = {
    membershipId: membership.id,
    membershipPlanId: membership.planId,
    membershipPlanVersionId: version.id,
    type,
    canonicalModelId: input.snapshot.canonicalModelId,
    periods,
  };
  const available = await availableQuotaUnits(transaction, input.userId, quota);
  if (available <= 0n) return null;
  const requested = input.requestedUnits > 0n ? input.requestedUnits : 0n;
  return {
    ...quota,
    reservedUnits: (requested < available ? requested : available).toString(),
  };
}

export async function settleMembershipQuota(
  transaction: QuotaTransaction,
  userId: string,
  pricingSnapshot: unknown,
  actualUnits: bigint,
) {
  const quota = membershipQuotaFromPricingSnapshot(pricingSnapshot);
  if (!quota || actualUnits <= 0n) return 0n;
  await lockMembership(transaction, quota.membershipId);
  if (quota.type === 'IMAGE_COUNT') {
    const reserved = BigInt(quota.reservedUnits);
    return actualUnits < reserved ? actualUnits : reserved;
  }
  const available = await availableQuotaUnits(transaction, userId, quota);
  return actualUnits < available ? actualUnits : available;
}

export async function releaseMembershipQuota(
  transaction: QuotaTransaction,
  pricingSnapshot: unknown,
) {
  const quota = membershipQuotaFromPricingSnapshot(pricingSnapshot);
  if (quota) await lockMembership(transaction, quota.membershipId);
}

export function applyMembershipQuotaCharge(
  breakdown: ChargeBreakdown,
  quota: MembershipQuotaReservationSnapshot | null,
  actualUnits: bigint,
  freeUnits: bigint,
): ChargeBreakdown {
  if (!quota || actualUnits <= 0n || freeUnits <= 0n) return breakdown;
  const covered = freeUnits < actualUnits ? freeUnits : actualUnits;
  const billable = actualUnits - covered;
  const gross = creditMicros(breakdown.totalCredits);
  const net = gross * billable / actualUnits;
  const discount = gross - net;
  return {
    ...breakdown,
    baseCharge: microsToCredit(net),
    totalCredits: microsToCredit(net),
    details: {
      ...breakdown.details,
      membershipQuota: {
        membershipId: quota.membershipId,
        membershipPlanId: quota.membershipPlanId,
        membershipPlanVersionId: quota.membershipPlanVersionId,
        type: quota.type,
        canonicalModelId: quota.canonicalModelId,
        freeUnits: covered.toString(),
        billableUnits: billable.toString(),
        grossCredits: microsToCredit(gross),
        discountCredits: microsToCredit(discount),
        periods: quota.periods.map(period => ({
          period: period.period,
          resetAt: period.resetAt,
          limit: period.limit,
        })),
      },
    },
  };
}

export type QuotaBillingPrismaClient = Pick<PrismaClient, '$transaction'>;

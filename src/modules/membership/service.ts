import { randomBytes } from 'node:crypto';
import { Prisma, type AiCapability, type PrismaClient } from '@prisma/client';
import { serializeCredit } from '../wallets/credit-amount.js';

const inviteAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function inviteCode() {
  const bytes = randomBytes(8);
  let value = '';
  for (const byte of bytes) value += inviteAlphabet[byte % inviteAlphabet.length];
  return value;
}

function normalizeInviteCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function ensureReferralProfile(prisma: PrismaClient, userId: string) {
  const existing = await prisma.referralProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.referralProfile.create({ data: { userId, inviteCode: inviteCode() } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const retry = await prisma.referralProfile.findUnique({ where: { userId } });
      if (retry) return retry;
    }
  }
  throw new Error('Could not allocate an invite code');
}

export async function validateReferralCode(
  prisma: PrismaClient,
  code: string,
  currentUserId?: string,
) {
  const normalized = normalizeInviteCode(code);
  if (normalized.length < 6 || normalized.length > 16) return { valid: false, reason: 'invalid_format' } as const;
  const profile = await prisma.referralProfile.findUnique({
    where: { inviteCode: normalized },
    select: { userId: true, inviteCode: true, user: { select: { displayName: true, status: true } } },
  });
  if (!profile || profile.user.status !== 'ACTIVE') return { valid: false, reason: 'not_found' } as const;
  if (currentUserId && profile.userId === currentUserId) return { valid: false, reason: 'self_referral' } as const;
  return {
    valid: true,
    inviteCode: profile.inviteCode,
    inviter: { userId: profile.userId, displayName: profile.user.displayName },
  } as const;
}

type TransactionClient = Prisma.TransactionClient;
type PrismaLike = PrismaClient | TransactionClient;

const referralImageCapabilities: AiCapability[] = [
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

export type ReferralBindingEligibility = {
  allowed: boolean;
  reason: 'image_generated' | 'credits_received' | null;
};

export async function getReferralBindingEligibility(
  prisma: PrismaLike,
  userId: string,
): Promise<ReferralBindingEligibility> {
  const [wallet, imageRequest] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId }, select: { lifetimeGranted: true } }),
    prisma.aiRequest.findFirst({
      where: { userId, capability: { in: referralImageCapabilities }, status: 'SUCCEEDED' },
      select: { id: true },
    }),
  ]);
  if (imageRequest) return { allowed: false, reason: 'image_generated' };
  if (wallet && new Prisma.Decimal(wallet.lifetimeGranted).gt(0)) {
    return { allowed: false, reason: 'credits_received' };
  }
  return { allowed: true, reason: null };
}

export async function bindReferralOnRegistration(
  transaction: TransactionClient,
  input: { inviteeId: string; inviteCode?: string | undefined },
) {
  const ownProfile = await transaction.referralProfile.upsert({
    where: { userId: input.inviteeId },
    create: { userId: input.inviteeId, inviteCode: inviteCode() },
    update: {},
  });
  const normalized = input.inviteCode ? normalizeInviteCode(input.inviteCode) : '';
  if (!normalized) return { profile: ownProfile, relation: null, reward: null };

  const inviterProfile = await transaction.referralProfile.findUnique({
    where: { inviteCode: normalized },
    include: { user: { select: { id: true, status: true } } },
  });
  if (!inviterProfile || inviterProfile.user.status !== 'ACTIVE') {
    throw new ReferralServiceError('invalid_invite_code', 'Invite code is invalid', 400);
  }
  if (inviterProfile.userId === input.inviteeId) {
    throw new ReferralServiceError('self_referral', 'You cannot use your own invite code', 400);
  }
  const existing = await transaction.referralRelation.findUnique({ where: { inviteeId: input.inviteeId } });
  if (existing) throw new ReferralServiceError('referral_already_bound', 'Referral has already been bound', 409);

  const relation = await transaction.referralRelation.create({
    data: { inviterId: inviterProfile.userId, inviteeId: input.inviteeId, inviteCode: normalized },
  });
  const rule = await transaction.referralRewardRule.findUnique({ where: { eventType: 'REGISTRATION' } });
  if (!rule || !rule.active || (rule.inviterCredits.isZero() && rule.inviteeCredits.isZero())) {
    return { profile: ownProfile, relation, reward: null };
  }

  const eventKey = `registration:${input.inviteeId}`;
  const event = await transaction.referralRewardEvent.create({
    data: {
      eventKey,
      ruleId: rule.id,
      relationId: relation.id,
      inviterId: inviterProfile.userId,
      inviteeId: input.inviteeId,
      inviterCredits: rule.inviterCredits,
      inviteeCredits: rule.inviteeCredits,
    },
  });

  for (const [userId, amount, description] of [
    [inviterProfile.userId, rule.inviterCredits, 'Referral registration reward'] as const,
    [input.inviteeId, rule.inviteeCredits, 'Welcome referral reward'] as const,
  ]) {
    if (amount.isZero()) continue;
    const wallet = await transaction.wallet.upsert({
      where: { userId },
      create: { userId, availableCredits: amount, lifetimeGranted: amount },
      update: { availableCredits: { increment: amount }, lifetimeGranted: { increment: amount } },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        type: 'GRANT',
        amount,
        balanceAfter: wallet.availableCredits,
        description,
      },
    });
  }
  return {
    profile: ownProfile,
    relation,
    reward: {
      id: event.id,
      inviterCredits: serializeCredit(event.inviterCredits),
      inviteeCredits: serializeCredit(event.inviteeCredits),
    },
  };
}

export async function bindReferralForUser(
  prisma: PrismaClient,
  input: { inviteeId: string; inviteCode: string },
) {
  return prisma.$transaction(
    async (transaction) => {
      const existing = await transaction.referralRelation.findUnique({ where: { inviteeId: input.inviteeId } });
      if (existing) {
        throw new ReferralServiceError('referral_already_bound', 'Referral has already been bound', 409);
      }
      const eligibility = await getReferralBindingEligibility(transaction, input.inviteeId);
      if (!eligibility.allowed) {
        const message = eligibility.reason === 'image_generated'
          ? 'Invite codes can no longer be bound after image generation'
          : 'Invite codes can no longer be bound after credits are received';
        throw new ReferralServiceError(`referral_not_eligible_${eligibility.reason}`, message, 409);
      }
      return bindReferralOnRegistration(transaction, input);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * Apply the one-time referral reward for a qualifying invitee recharge.
 * Redemption codes are currently the wallet's recharge mechanism; payment
 * integrations can call this helper with their own idempotent event key.
 */
export async function rewardReferralOnRecharge(
  transaction: TransactionClient,
  input: { inviteeId: string; rechargeCredits: Prisma.Decimal | string | number; eventKey: string },
) {
  const existing = await transaction.referralRewardEvent.findUnique({ where: { eventKey: input.eventKey } });
  if (existing) {
    return {
      id: existing.id,
      inviterCredits: serializeCredit(existing.inviterCredits),
      inviteeCredits: serializeCredit(existing.inviteeCredits),
    };
  }
  const relation = await transaction.referralRelation.findUnique({ where: { inviteeId: input.inviteeId } });
  if (!relation) return null;
  const rule = await transaction.referralRewardRule.findUnique({ where: { eventType: 'RECHARGE' } });
  if (!rule || !rule.active) return null;
  const rechargeCredits = new Prisma.Decimal(input.rechargeCredits);
  if (rule.minRecharge && rechargeCredits.lt(rule.minRecharge)) return null;
  if (rule.inviterCredits.isZero() && rule.inviteeCredits.isZero()) return null;

  const event = await transaction.referralRewardEvent.create({
    data: {
      eventKey: input.eventKey,
      ruleId: rule.id,
      relationId: relation.id,
      inviterId: relation.inviterId,
      inviteeId: relation.inviteeId,
      inviterCredits: rule.inviterCredits,
      inviteeCredits: rule.inviteeCredits,
    },
  });
  for (const [userId, amount, description] of [
    [relation.inviterId, rule.inviterCredits, 'Referral recharge reward'] as const,
    [relation.inviteeId, rule.inviteeCredits, 'Recharge referral bonus'] as const,
  ]) {
    if (amount.isZero()) continue;
    const wallet = await transaction.wallet.upsert({
      where: { userId },
      create: { userId, availableCredits: amount, lifetimeGranted: amount },
      update: { availableCredits: { increment: amount }, lifetimeGranted: { increment: amount } },
    });
    await transaction.walletLedger.create({
      data: {
        userId,
        type: 'GRANT',
        amount,
        balanceAfter: wallet.availableCredits,
        description,
      },
    });
  }
  return {
    id: event.id,
    inviterCredits: serializeCredit(event.inviterCredits),
    inviteeCredits: serializeCredit(event.inviteeCredits),
  };
}

export class ReferralServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ReferralServiceError';
  }
}

function serializeMembership(value: {
  id: string;
  status: string;
  startsAt: Date;
  expiresAt: Date;
  source: string;
  note: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    versions: Array<{ freeQuota: unknown }>;
  };
}, quotas: MembershipQuotaSummary[]) {
  return {
    id: value.id,
    status: value.status,
    startsAt: value.startsAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
    source: value.source,
    note: value.note,
    plan: {
      id: value.plan.id,
      code: value.plan.code,
      name: value.plan.name,
      description: value.plan.description,
    },
    quotas,
  };
}

export type MembershipQuotaType = 'IMAGE_COUNT' | 'LLM_TOKENS';
export type MembershipQuotaPeriod = 'DAILY' | 'MONTHLY';

type MembershipQuotaDefinition = {
  type: MembershipQuotaType;
  canonicalModelId: string;
  period: MembershipQuotaPeriod;
  limit: number;
};

type MembershipQuotaSummary = MembershipQuotaDefinition & {
  modelName: string;
  used: number;
  remaining: number;
  resetAt: string;
};

const CST_OFFSET_MS = 8 * 60 * 60 * 1_000;

const quotaObject = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const quotaCount = (value: unknown) => {
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    return BigInt(Math.trunc(value));
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 0n;
  try {
    return BigInt(value.trim());
  } catch {
    return 0n;
  }
};

export function parseMembershipQuotaDefinitions(value: unknown): MembershipQuotaDefinition[] {
  const root = quotaObject(value);
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(root?.quotas)
      ? root.quotas
      : [];
  const seen = new Set<string>();
  const definitions: MembershipQuotaDefinition[] = [];

  for (const candidate of candidates) {
    const quota = quotaObject(candidate);
    const type = quota?.type;
    const canonicalModelId = typeof quota?.canonicalModelId === 'string'
      ? quota.canonicalModelId.trim()
      : '';
    const period = quota?.period;
    const numericLimit = typeof quota?.limit === 'string'
      ? Number(quota.limit.trim())
      : quota?.limit;
    if ((type !== 'IMAGE_COUNT' && type !== 'LLM_TOKENS')
      || (period !== 'DAILY' && period !== 'MONTHLY')
      || !canonicalModelId
      || typeof numericLimit !== 'number'
      || !Number.isSafeInteger(numericLimit)
      || numericLimit <= 0) continue;
    const key = `${type}:${canonicalModelId}:${period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    definitions.push({ type, canonicalModelId, period, limit: numericLimit });
  }
  return definitions;
}

async function validateMembershipQuotaModels(
  transaction: Prisma.TransactionClient,
  freeQuota: unknown,
) {
  const definitions = parseMembershipQuotaDefinitions(freeQuota);
  if (definitions.length === 0) return;
  const models = await transaction.aiModel.findMany({
    where: { id: { in: [...new Set(definitions.map(quota => quota.canonicalModelId))] } },
    select: { id: true, modality: true },
  });
  const modalities = new Map(models.map(model => [model.id, model.modality]));
  for (const quota of definitions) {
    const modality = modalities.get(quota.canonicalModelId);
    if (!modality) {
      throw new ReferralServiceError(
        'quota_model_not_found',
        'The canonical model configured for this membership quota was not found',
        400,
      );
    }
    const expectedModality = quota.type === 'IMAGE_COUNT' ? 'image' : 'chat';
    if (modality !== expectedModality) {
      throw new ReferralServiceError(
        'quota_model_mismatch',
        `${quota.type} cannot be configured for a ${modality} canonical model`,
        400,
      );
    }
  }
}

export function membershipQuotaPeriodRange(
  period: MembershipQuotaPeriod,
  now = new Date(),
) {
  const shifted = new Date(now.getTime() + CST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const startMs = period === 'DAILY'
    ? Date.UTC(year, month, day) - CST_OFFSET_MS
    : Date.UTC(year, month, 1) - CST_OFFSET_MS;
  const endMs = period === 'DAILY'
    ? Date.UTC(year, month, day + 1) - CST_OFFSET_MS
    : Date.UTC(year, month + 1, 1) - CST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(endMs) };
}

const settledImageCount = (value: unknown) => {
  const breakdown = quotaObject(value);
  const details = quotaObject(breakdown?.details);
  return quotaCount(details?.generatedCount ?? breakdown?.quantity);
};

const settledTokenCount = (value: unknown) => {
  const breakdown = quotaObject(value);
  const details = quotaObject(breakdown?.details);
  const usage = quotaObject(details?.usage) ?? quotaObject(breakdown?.usage);
  if (!usage) return 0n;
  return quotaCount(usage.inputTokens)
    + quotaCount(usage.outputTokens)
    + quotaCount(usage.cacheWriteTokens);
};

const safeQuotaNumber = (value: bigint) => Number(
  value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value,
);

async function summarizeMembershipQuotas(
  prisma: PrismaClient,
  userId: string,
  membershipStartsAt: Date,
  definitions: MembershipQuotaDefinition[],
  now: Date,
): Promise<MembershipQuotaSummary[]> {
  if (definitions.length === 0) return [];
  const canonicalModelIds = [...new Set(definitions.map(quota => quota.canonicalModelId))];
  const ranges = definitions.map(quota => membershipQuotaPeriodRange(quota.period, now));
  const earliestStart = ranges.reduce(
    (earliest, range) => range.start < earliest ? range.start : earliest,
    ranges[0]!.start,
  );
  const usageStart = membershipStartsAt > earliestStart ? membershipStartsAt : earliestStart;
  const [models, settlements] = await Promise.all([
    prisma.aiModel.findMany({
      where: { id: { in: canonicalModelIds } },
      select: { id: true, displayName: true },
    }),
    prisma.aiBillingSettlement.findMany({
      where: {
        canonicalModelId: { in: canonicalModelIds },
        createdAt: { gte: usageStart, lt: ranges.reduce(
          (latest, range) => range.end > latest ? range.end : latest,
          ranges[0]!.end,
        ) },
        request: { userId },
      },
      select: { canonicalModelId: true, breakdown: true, createdAt: true },
    }),
  ]);
  const names = new Map(models.map(model => [model.id, model.displayName]));

  return definitions.flatMap((definition) => {
    const modelName = names.get(definition.canonicalModelId)?.trim();
    if (!modelName) return [];
    const range = membershipQuotaPeriodRange(definition.period, now);
    const start = membershipStartsAt > range.start ? membershipStartsAt : range.start;
    const usedBigInt = settlements.reduce((total, settlement) => {
      if (settlement.canonicalModelId !== definition.canonicalModelId
        || settlement.createdAt < start
        || settlement.createdAt >= range.end) return total;
      return total + (definition.type === 'IMAGE_COUNT'
        ? settledImageCount(settlement.breakdown)
        : settledTokenCount(settlement.breakdown));
    }, 0n);
    const used = safeQuotaNumber(usedBigInt);
    return [{
      ...definition,
      modelName,
      used,
      remaining: Math.max(0, definition.limit - used),
      resetAt: range.end.toISOString(),
    }];
  });
}

export async function getMembershipPlans(prisma: PrismaClient) {
  const plans = await prisma.membershipPlan.findMany({
    where: { active: true },
    orderBy: { updatedAt: 'desc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    currentVersion: plan.versions[0]
      ? {
          version: plan.versions[0].version,
          prices: plan.versions[0].prices,
          freeQuota: plan.versions[0].freeQuota,
          publishedAt: plan.versions[0].publishedAt.toISOString(),
        }
      : null,
  }));
}

export async function getMembershipForUser(prisma: PrismaClient, userId: string, now = new Date()) {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    include: {
      plan: {
        include: {
          versions: { orderBy: { version: 'desc' }, take: 1, select: { freeQuota: true } },
        },
      },
    },
  });
  if (!membership) return null;
  const definitions = parseMembershipQuotaDefinitions(membership.plan.versions[0]?.freeQuota);
  const quotas = await summarizeMembershipQuotas(
    prisma,
    userId,
    membership.startsAt,
    definitions,
    now,
  );
  return serializeMembership(membership, quotas);
}

export async function getReferralSnapshot(prisma: PrismaClient, userId: string) {
  const profile = await ensureReferralProfile(prisma, userId);
  const [relation, invited, rewards] = await Promise.all([
    prisma.referralRelation.findUnique({ where: { inviteeId: userId }, include: { inviter: { select: { id: true, displayName: true } } } }),
    prisma.referralRelation.findMany({ where: { inviterId: userId }, orderBy: { boundAt: 'desc' }, take: 100, include: { invitee: { select: { id: true, displayName: true, email: true } } } }),
    prisma.referralRewardEvent.findMany({ where: { OR: [{ inviterId: userId }, { inviteeId: userId }] }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return {
    inviteCode: profile.inviteCode,
    inviter: relation ? relation.inviter : null,
    invited: invited.map((item) => ({
      userId: item.invitee.id,
      displayName: item.invitee.displayName,
      email: item.invitee.email,
      boundAt: item.boundAt.toISOString(),
    })),
    rewards: rewards.map((item) => ({
      id: item.id,
      eventKey: item.eventKey,
      inviterCredits: serializeCredit(item.inviterCredits),
      inviteeCredits: serializeCredit(item.inviteeCredits),
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

export { normalizeInviteCode };

export async function listMembershipPlansAdmin(prisma: PrismaClient) {
  const plans = await prisma.membershipPlan.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 10 },
      _count: { select: { memberships: true } },
    },
  });
  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    active: plan.active,
    memberCount: plan._count.memberships,
    versions: plan.versions.map((version) => ({
      id: version.id,
      version: version.version,
      prices: version.prices,
      freeQuota: version.freeQuota,
      publishedAt: version.publishedAt.toISOString(),
    })),
  }));
}

export async function createMembershipPlan(
  prisma: PrismaClient,
  input: { code: string; name: string; description?: string | null | undefined; prices: Prisma.InputJsonValue; freeQuota?: Prisma.InputJsonValue | null | undefined },
) {
  return prisma.$transaction(async (transaction) => {
    await validateMembershipQuotaModels(transaction, input.freeQuota);
    const plan = await transaction.membershipPlan.create({
      data: {
        code: input.code.trim().toLowerCase(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        versions: { create: { version: 1, prices: input.prices, freeQuota: input.freeQuota ?? Prisma.JsonNull } },
      },
      include: { versions: true },
    });
    return plan;
  });
}

export async function updateMembershipPlan(
  prisma: PrismaClient,
  planId: string,
  input: { name?: string | undefined; description?: string | null | undefined; active?: boolean | undefined; prices?: Prisma.InputJsonValue | undefined; freeQuota?: Prisma.InputJsonValue | null | undefined },
) {
  return prisma.$transaction(async (transaction) => {
    const plan = await transaction.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new ReferralServiceError('plan_not_found', 'Membership plan was not found', 404);
    if (input.freeQuota !== undefined) {
      await validateMembershipQuotaModels(transaction, input.freeQuota);
    }
    const update = await transaction.membershipPlan.update({
      where: { id: planId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    if (input.prices !== undefined || input.freeQuota !== undefined) {
      const latest = await transaction.membershipPlanVersion.findFirst({ where: { planId }, orderBy: { version: 'desc' } });
      await transaction.membershipPlanVersion.create({
        data: {
          planId,
          version: (latest?.version ?? 0) + 1,
          prices: input.prices ?? latest?.prices ?? {},
          freeQuota: input.freeQuota !== undefined ? input.freeQuota ?? Prisma.JsonNull : latest?.freeQuota ?? Prisma.JsonNull,
        },
      });
    }
    return update;
  });
}

function membershipExpiry(days: number, base = new Date()) {
  const expiresAt = new Date(base);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
  return expiresAt;
}

export async function grantMembership(
  prisma: PrismaClient,
  input: { userId: string; planId: string; days: number; note?: string | null | undefined },
) {
  return prisma.$transaction(async (transaction) => {
    const [user, plan] = await Promise.all([
      transaction.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
      transaction.membershipPlan.findUnique({ where: { id: input.planId }, select: { id: true } }),
    ]);
    if (!user) throw new ReferralServiceError('user_not_found', 'User was not found', 404);
    if (!plan) throw new ReferralServiceError('plan_not_found', 'Membership plan was not found', 404);
    const startsAt = new Date();
    return transaction.userMembership.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        startsAt,
        expiresAt: membershipExpiry(input.days, startsAt),
        source: 'ADMIN',
        note: input.note?.trim() || null,
      },
      include: { plan: true },
    });
  });
}

export async function extendMembership(
  prisma: PrismaClient,
  input: { userId: string; days: number; planId?: string | undefined },
) {
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.userMembership.findFirst({
      where: { userId: input.userId, status: 'ACTIVE' },
      orderBy: { expiresAt: 'desc' },
    });
    if (!current) {
      if (!input.planId) throw new ReferralServiceError('membership_not_found', 'No active membership was found', 404);
      const [user, plan] = await Promise.all([
        transaction.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
        transaction.membershipPlan.findUnique({ where: { id: input.planId }, select: { id: true } }),
      ]);
      if (!user) throw new ReferralServiceError('user_not_found', 'User was not found', 404);
      if (!plan) throw new ReferralServiceError('plan_not_found', 'Membership plan was not found', 404);
      const startsAt = new Date();
      return transaction.userMembership.create({
        data: { userId: input.userId, planId: input.planId, startsAt, expiresAt: membershipExpiry(input.days, startsAt), source: 'ADMIN' },
        include: { plan: true },
      });
    }
    const base = current.expiresAt > new Date() ? current.expiresAt : new Date();
    return transaction.userMembership.update({
      where: { id: current.id },
      data: { expiresAt: membershipExpiry(input.days, base) },
      include: { plan: true },
    });
  });
}

export async function revokeMembership(prisma: PrismaClient, userId: string) {
  const result = await prisma.userMembership.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'REVOKED' },
  });
  return { revoked: result.count };
}

export async function listReferralRules(prisma: PrismaClient) {
  const rules = await prisma.referralRewardRule.findMany({ orderBy: { eventType: 'asc' } });
  return rules.map((rule) => ({
    id: rule.id,
    eventType: rule.eventType,
    inviterCredits: serializeCredit(rule.inviterCredits),
    inviteeCredits: serializeCredit(rule.inviteeCredits),
    minRecharge: rule.minRecharge ? serializeCredit(rule.minRecharge) : null,
    active: rule.active,
  }));
}

export async function upsertReferralRule(
  prisma: PrismaClient,
  input: { eventType: string; inviterCredits: string; inviteeCredits: string; minRecharge?: string | null | undefined; active?: boolean | undefined },
) {
  const row = await prisma.referralRewardRule.upsert({
    where: { eventType: input.eventType.trim().toUpperCase() },
    create: {
      eventType: input.eventType.trim().toUpperCase(),
      inviterCredits: new Prisma.Decimal(input.inviterCredits),
      inviteeCredits: new Prisma.Decimal(input.inviteeCredits),
      minRecharge: input.minRecharge ? new Prisma.Decimal(input.minRecharge) : null,
      active: input.active ?? true,
    },
    update: {
      inviterCredits: new Prisma.Decimal(input.inviterCredits),
      inviteeCredits: new Prisma.Decimal(input.inviteeCredits),
      minRecharge: input.minRecharge ? new Prisma.Decimal(input.minRecharge) : null,
      ...(input.active === undefined ? {} : { active: input.active }),
    },
  });
  return {
    id: row.id,
    eventType: row.eventType,
    inviterCredits: serializeCredit(row.inviterCredits),
    inviteeCredits: serializeCredit(row.inviteeCredits),
    minRecharge: row.minRecharge ? serializeCredit(row.minRecharge) : null,
    active: row.active,
  };
}

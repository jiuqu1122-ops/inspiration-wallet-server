import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
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
  plan: { id: string; code: string; name: string; description: string | null };
}) {
  return {
    id: value.id,
    status: value.status,
    startsAt: value.startsAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
    source: value.source,
    note: value.note,
    plan: value.plan,
  };
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

export async function getMembershipForUser(prisma: PrismaClient, userId: string) {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
    include: { plan: true },
  });
  return membership ? serializeMembership(membership) : null;
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

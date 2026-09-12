import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { hashCloudLicenseId, hashLicenseMachineId, verifySignedLicenseForMigration } from './license-verifier.js';
import { canSignServerLicenses, signServerLicense } from './license-signer.js';
import { sendVerificationEmail } from './mailer.js';
import { AuthFlowError, createAccountSession, exchangeLicense } from './service.js';
import { bindReferralOnRegistration, validateReferralCode } from '../membership/service.js';

const maxCodeAttempts = 5;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function codeHash(challengeId: string, email: string, code: string) {
  return createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update('inspiration-email-code-v1\0')
    .update(challengeId)
    .update('\0')
    .update(email)
    .update('\0')
    .update(code)
    .digest('hex');
}

function hashMatches(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function compatibilityLicenseExpiration() {
  const expiresAt = new Date();
  // Legacy desktop clients still require a signed expiration field. Keep this
  // compatibility shim far beyond any normal account lifetime; new clients use
  // the nullable account session and membership expiry instead.
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 36500);
  expiresAt.setUTCHours(23, 59, 59, 999);
  return expiresAt;
}

function validDisplayName(value: string | undefined) {
  const displayName = value?.trim() ?? '';
  const length = [...displayName].length;
  const containsControlCharacter = [...displayName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  return length >= 2 && length <= 32 && !containsControlCharacter
    ? displayName
    : null;
}

export async function requestEmailCode(app: FastifyInstance, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const challengeId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + env.EMAIL_CODE_TTL_MINUTES * 60_000);
  const user = await app.prisma.user.findUnique({ where: { email }, select: { id: true } });

  await app.prisma.emailVerificationChallenge.create({
    data: {
      id: challengeId,
      email,
      codeHash: codeHash(challengeId, email, code),
      expiresAt,
      ...(user ? { user: { connect: { id: user.id } } } : {}),
    },
  });

  try {
    await sendVerificationEmail(email, code);
  } catch {
    await app.prisma.emailVerificationChallenge.deleteMany({ where: { id: challengeId } });
    throw new AuthFlowError(
      'email_delivery_unavailable',
      'Verification email could not be sent',
      503,
    );
  }

  return {
    status: 'verification_required',
    challengeId,
    expiresIn: env.EMAIL_CODE_TTL_MINUTES * 60,
    resendAfter: 60,
  };
}

type VerifyEmailInput = {
  email: string;
  challengeId: string;
  code: string;
  machineId: string;
  displayName?: string | undefined;
  legacyLicense?: string | undefined;
  inviteCode?: string | undefined;
};

export async function verifyEmailCode(app: FastifyInstance, input: VerifyEmailInput) {
  if (!canSignServerLicenses()) {
    throw new AuthFlowError(
      'automatic_license_unavailable',
      'Automatic license signing is not configured',
      503,
    );
  }

  const email = normalizeEmail(input.email);
  if (input.inviteCode) {
    const referral = await validateReferralCode(app.prisma, input.inviteCode);
    if (!referral.valid) {
      throw new AuthFlowError('invalid_invite_code', 'Invite code is invalid', 400);
    }
  }
  const challenge = await app.prisma.emailVerificationChallenge.findUnique({
    where: { id: input.challengeId },
  });
  const now = new Date();
  if (
    !challenge
    || challenge.email !== email
    || challenge.consumedAt
    || challenge.expiresAt <= now
    || challenge.attempts >= maxCodeAttempts
  ) {
    throw new AuthFlowError('invalid_email_code', 'Verification code is invalid or expired', 400);
  }

  const presentedHash = codeHash(challenge.id, email, input.code);
  if (!hashMatches(challenge.codeHash, presentedHash)) {
    await app.prisma.emailVerificationChallenge.update({
      where: { id: challenge.id },
      data: {
        attempts: { increment: 1 },
        ...(challenge.attempts + 1 >= maxCodeAttempts ? { consumedAt: now } : {}),
      },
    });
    throw new AuthFlowError('invalid_email_code', 'Verification code is invalid or expired', 400);
  }

  const consumed = await app.prisma.emailVerificationChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) {
    throw new AuthFlowError('email_code_reused', 'Verification code was already used', 400);
  }

  const machineId = input.machineId.trim().toLowerCase();
  const machineIdHash = hashLicenseMachineId(machineId);
  const legacy = input.legacyLicense
    ? verifySignedLicenseForMigration(input.legacyLicense, machineId)
    : null;

  const result = await app.prisma.$transaction(
    async (transaction) => {
      const [emailUser, legacyLicense, priorMachineLicense] = await Promise.all([
        transaction.user.findUnique({ where: { email } }),
        legacy
          ? transaction.license.findUnique({ where: { codeHash: legacy.codeHash }, include: { user: true } })
          : null,
        transaction.license.findFirst({
          where: { machineIdHash },
          orderBy: { updatedAt: 'desc' },
          include: { user: true },
        }),
      ]);

      const candidateUsers = [emailUser, legacyLicense?.user, priorMachineLicense?.user]
        .filter((user): user is NonNullable<typeof user> => Boolean(user));
      const isNewAccount = !emailUser && !legacyLicense && !priorMachineLicense;
      const distinctUserIds = new Set(candidateUsers.map((user) => user.id));
      if (distinctUserIds.size > 1) {
        throw new AuthFlowError(
          'account_binding_conflict',
          'The email, legacy license, or device is already bound to another account',
          409,
        );
      }

      let user = candidateUsers[0] ?? null;
      if (user?.email && user.email !== email) {
        throw new AuthFlowError('device_already_bound', 'This device is bound to another email', 409);
      }

      const requestedDisplayName = validDisplayName(input.displayName);
      const displayName = user?.displayName
        ?? legacy?.customer
        ?? requestedDisplayName;
      if (!displayName) {
        throw new AuthFlowError('display_name_required', 'A 2-32 character display name is required', 400);
      }

      const inheritedExpiration = legacy?.expiresAt
        ?? priorMachineLicense?.expiresAt
        ?? null;
      let entitlementExpiresAt = user?.entitlementExpiresAt
        ?? inheritedExpiration
        ?? null;
      if (legacy?.expiresAt && (!entitlementExpiresAt || legacy.expiresAt > entitlementExpiresAt)) {
        entitlementExpiresAt = legacy.expiresAt;
      }

      if (user) {
        user = await transaction.user.update({
          where: { id: user.id },
          data: {
            email,
            displayName,
            emailVerifiedAt: now,
            entitlementEdition: 'ENTERPRISE',
            entitlementFeatures: ['*'],
          entitlementExpiresAt,
          },
        });
      } else {
        user = await transaction.user.create({
          data: {
            email,
            displayName,
            emailVerifiedAt: now,
            entitlementEdition: 'ENTERPRISE',
            entitlementFeatures: ['*'],
            wallet: { create: {} },
          },
        });
      }
      await transaction.wallet.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      const referral = isNewAccount
        ? await bindReferralOnRegistration(transaction, {
            inviteeId: user.id,
            inviteCode: input.inviteCode,
          })
        : null;

      if (legacy && !legacyLicense) {
        await transaction.license.create({
          data: {
            codeHash: legacy.codeHash,
            customer: legacy.customer,
            machineIdHash: legacy.machineIdHash,
            userId: user.id,
            status: legacy.expiresAt < now ? 'EXPIRED' : 'ACTIVE',
            edition: 'ENTERPRISE',
            features: ['*'],
            expiresAt: legacy.expiresAt,
          },
        });
      }

      const deviceLicenseId = `emaildev_${machineIdHash}`;
      const deviceLicenseExpiresAt = entitlementExpiresAt ?? compatibilityLicenseExpiration();
      const existingDeviceLicense = await transaction.license.findUnique({
        where: { id: deviceLicenseId },
      });
      if (existingDeviceLicense && existingDeviceLicense.userId !== user.id) {
        throw new AuthFlowError('device_already_bound', 'This device is bound to another email', 409);
      }
      const deviceLicense = await transaction.license.upsert({
        where: { id: deviceLicenseId },
        create: {
          id: deviceLicenseId,
          codeHash: hashCloudLicenseId(deviceLicenseId),
          customer: displayName,
          machineIdHash,
          userId: user.id,
          status: deviceLicenseExpiresAt < now ? 'EXPIRED' : 'ACTIVE',
          edition: 'ENTERPRISE',
          features: ['*'],
          expiresAt: deviceLicenseExpiresAt,
          lastExchangedAt: now,
        },
        update: {
          customer: displayName,
          status: deviceLicenseExpiresAt < now ? 'EXPIRED' : 'ACTIVE',
          edition: 'ENTERPRISE',
          features: ['*'],
          expiresAt: deviceLicenseExpiresAt,
          lastExchangedAt: now,
        },
      });

      return {
        user,
        deviceLicense,
        isNewAccount,
        referral,
        deviceLicenseExpiresAt,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (result.user.entitlementExpiresAt && result.user.entitlementExpiresAt < now) {
    throw new AuthFlowError('license_expired', 'Account authorization has expired', 403);
  }

  const authentication = canSignServerLicenses()
    ? await (async () => {
        const license = signServerLicense({
          licenseId: result.deviceLicense.id,
          customer: result.user.displayName ?? email,
          machineId,
          edition: 'enterprise',
          features: ['*'],
          expiresAt: result.deviceLicenseExpiresAt,
        });
        return { license, ...(await exchangeLicense(app, { license, machineId })) };
      })()
    : await createAccountSession(app, result.user.id);

  return {
    ...authentication,
    registration: {
      isNewAccount: result.isNewAccount,
      email,
      displayName: result.user.displayName,
      edition: 'enterprise',
      expiresAt: result.user.entitlementExpiresAt?.toISOString() ?? null,
      referral: result.referral?.reward ?? null,
    },
  };
}

export async function syncEmailLicense(
  app: FastifyInstance,
  input: { license: string; machineId: string },
) {
  if (!canSignServerLicenses()) {
    throw new AuthFlowError(
      'automatic_license_unavailable',
      'Automatic license signing is not configured',
      503,
    );
  }

  const verified = verifySignedLicenseForMigration(input.license, input.machineId);
  const storedLicense = await app.prisma.license.findUnique({
    where: { codeHash: verified.codeHash },
    include: { user: true },
  });
  if (!storedLicense || storedLicense.machineIdHash !== verified.machineIdHash) {
    throw new AuthFlowError('license_revoked', 'Cloud license was not found', 403);
  }
  if (storedLicense.user.status !== 'ACTIVE') {
    throw new AuthFlowError('account_disabled', 'Account is not active', 403);
  }
  const expiresAt = storedLicense.user.entitlementExpiresAt ?? storedLicense.expiresAt;
  if (!expiresAt || expiresAt < new Date()) {
    throw new AuthFlowError('license_expired', 'Account authorization has expired', 403);
  }

  await app.prisma.license.update({
    where: { id: storedLicense.id },
    data: {
      customer: storedLicense.user.displayName ?? storedLicense.customer,
      status: 'ACTIVE',
      edition: 'ENTERPRISE',
      features: ['*'],
      expiresAt,
      lastExchangedAt: new Date(),
    },
  });

  const license = signServerLicense({
    licenseId: storedLicense.id,
    customer: storedLicense.user.displayName ?? storedLicense.customer ?? storedLicense.user.email ?? 'Unmind User',
    machineId: input.machineId,
    edition: 'enterprise',
    features: ['*'],
    expiresAt,
  });
  const authentication = await exchangeLicense(app, { license, machineId: input.machineId });
  return { license, ...authentication };
}

export const emailAuthInternals = {
  codeHash,
  normalizeEmail,
  validDisplayName,
};

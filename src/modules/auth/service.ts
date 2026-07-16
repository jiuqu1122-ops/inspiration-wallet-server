import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import {
  createTokenPair,
  durationToMilliseconds,
  verifyRefreshToken,
} from '../../lib/tokens.js';
import { getAccountSnapshot } from '../users/service.js';
import {
  hashRefreshToken,
  verifySignedLicense,
  type VerifiedLicense,
} from './license-verifier.js';

export class AuthFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

function sessionExpiration(licenseExpiration: Date) {
  const refreshExpiration = new Date(
    Date.now() + durationToMilliseconds(env.JWT_REFRESH_EXPIRES_IN),
  );
  return refreshExpiration < licenseExpiration ? refreshExpiration : licenseExpiration;
}

function assertActiveIdentity(identity: {
  user: { status: string };
  status: string;
  expiresAt: Date | null;
}) {
  if (identity.user.status !== 'ACTIVE') {
    throw new AuthFlowError('account_disabled', 'The account is disabled', 403);
  }
  if (identity.status === 'REVOKED') {
    throw new AuthFlowError('license_revoked', 'The license has been revoked', 403);
  }
  if (identity.status === 'EXPIRED' || (identity.expiresAt !== null && identity.expiresAt < new Date())) {
    throw new AuthFlowError('license_expired', 'The license has expired', 403);
  }
}

async function resolveLicenseIdentity(app: FastifyInstance, verified: VerifiedLicense) {
  const now = new Date();

  return app.prisma.$transaction(
    async (transaction) => {
      const existing = await transaction.license.findUnique({
        where: { codeHash: verified.codeHash },
        include: { user: { select: { status: true } } },
      });

      if (existing) {
        assertActiveIdentity(existing);
        const license = await transaction.license.update({
          where: { id: existing.id },
          data: {
            machineIdHash: verified.machineIdHash,
            edition: verified.edition,
            features: verified.features,
            expiresAt: verified.expiresAt,
            lastExchangedAt: now,
          },
        });
        return { userId: existing.userId, licenseId: license.id };
      }

      const priorMachineLicense = await transaction.license.findFirst({
        where: { machineIdHash: verified.machineIdHash },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { status: true } } },
      });

      let userId: string;
      if (priorMachineLicense) {
        if (priorMachineLicense.user.status !== 'ACTIVE') {
          throw new AuthFlowError('account_disabled', 'The account is disabled', 403);
        }
        userId = priorMachineLicense.userId;
      } else {
        const user = await transaction.user.create({
          data: { wallet: { create: {} } },
          select: { id: true },
        });
        userId = user.id;
      }

      const license = await transaction.license.create({
        data: {
          codeHash: verified.codeHash,
          machineIdHash: verified.machineIdHash,
          userId,
          status: 'ACTIVE',
          edition: verified.edition,
          features: verified.features,
          expiresAt: verified.expiresAt,
          lastExchangedAt: now,
        },
        select: { id: true },
      });
      return { userId, licenseId: license.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function createSession(
  app: FastifyInstance,
  userId: string,
  licenseId: string,
  licenseExpiresAt: Date,
) {
  const sessionId = randomUUID();
  const tokens = createTokenPair(app, userId, sessionId, licenseId);
  await app.prisma.authSession.create({
    data: {
      id: sessionId,
      userId,
      licenseId,
      refreshTokenHash: hashRefreshToken(tokens.refreshToken),
      expiresAt: sessionExpiration(licenseExpiresAt),
    },
  });
  return tokens;
}

export async function exchangeLicense(
  app: FastifyInstance,
  input: { license: string; machineId: string },
) {
  const verified = verifySignedLicense(input.license, input.machineId);
  let identity: { userId: string; licenseId: string };
  try {
    identity = await resolveLicenseIdentity(app, verified);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await app.prisma.license.findUnique({
        where: { codeHash: verified.codeHash },
        include: { user: { select: { status: true } } },
      });
      if (!existing) {
        throw error;
      }
      assertActiveIdentity(existing);
      identity = { userId: existing.userId, licenseId: existing.id };
    } else {
      throw error;
    }
  }

  const tokens = await createSession(
    app,
    identity.userId,
    identity.licenseId,
    verified.expiresAt,
  );
  const account = await getAccountSnapshot(app.prisma, identity.userId, identity.licenseId);
  if (!account) {
    throw new Error('Account snapshot could not be created');
  }

  return {
    tokenType: 'Bearer',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
    account,
  };
}

function secureHashMatches(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function rotateRefreshToken(app: FastifyInstance, refreshToken: string) {
  let claims: ReturnType<typeof verifyRefreshToken>;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    throw new AuthFlowError('invalid_refresh_token', 'Refresh token is invalid', 401);
  }

  const session = await app.prisma.authSession.findUnique({
    where: { id: claims.sessionId },
    include: {
      user: { select: { status: true } },
      license: { select: { status: true, expiresAt: true } },
    },
  });
  const presentedHash = hashRefreshToken(refreshToken);
  if (
    !session ||
    session.userId !== claims.sub ||
    session.licenseId !== claims.licenseId ||
    !secureHashMatches(session.refreshTokenHash, presentedHash)
  ) {
    throw new AuthFlowError('invalid_refresh_token', 'Refresh token is invalid', 401);
  }
  assertActiveIdentity({
    user: session.user,
    status: session.license.status,
    expiresAt: session.license.expiresAt,
  });
  const now = new Date();
  if (session.revokedAt !== null || session.expiresAt <= now) {
    throw new AuthFlowError('refresh_token_expired', 'Refresh token is expired or revoked', 401);
  }
  const licenseExpiresAt = session.license.expiresAt;
  if (licenseExpiresAt === null) {
    throw new AuthFlowError('license_invalid', 'License expiration is not configured', 403);
  }

  const nextSessionId = randomUUID();
  const nextTokens = createTokenPair(
    app,
    session.userId,
    nextSessionId,
    session.licenseId,
  );
  await app.prisma.$transaction(async (transaction) => {
    const revoked = await transaction.authSession.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
      },
      data: { revokedAt: now, lastUsedAt: now },
    });
    if (revoked.count !== 1) {
      throw new AuthFlowError('refresh_token_reused', 'Refresh token was already used', 401);
    }
    await transaction.authSession.create({
      data: {
        id: nextSessionId,
        userId: session.userId,
        licenseId: session.licenseId,
        refreshTokenHash: hashRefreshToken(nextTokens.refreshToken),
        expiresAt: sessionExpiration(licenseExpiresAt),
      },
    });
  });

  return {
    tokenType: 'Bearer',
    accessToken: nextTokens.accessToken,
    refreshToken: nextTokens.refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  };
}

export async function revokeRefreshToken(app: FastifyInstance, refreshToken: string) {
  try {
    const claims = verifyRefreshToken(refreshToken);
    await app.prisma.authSession.updateMany({
      where: {
        id: claims.sessionId,
        userId: claims.sub,
        licenseId: claims.licenseId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  } catch {
    // Logout is intentionally idempotent and does not reveal token validity.
  }
}

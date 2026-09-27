import type { PrismaClient } from '@prisma/client';
import { toInputJson } from './pricing-center.js';
import { releaseMembershipQuota } from '../membership/quota-billing.js';

const ACTIVE_REQUEST_STATUSES = ['RESERVED', 'PROCESSING'] as const;
const STALE_REQUEST_MESSAGE = '任务长时间未完成，已自动释放预留积分';

function staleFailureDiagnostic(now: Date) {
  return {
    version: 1,
    code: 'REQUEST_STALE',
    message: STALE_REQUEST_MESSAGE,
    stage: 'request_recovery',
    httpStatus: null,
    causeCode: null,
    recordedAt: now.toISOString(),
    resolution: null,
  };
}

/**
 * Release reservations that can no longer be completed by an API/client poll.
 * The conditional request update is the claim boundary, so retries and
 * multiple workers cannot release the same reservation twice.
 */
export async function recoverStaleAiRequests(
  prisma: PrismaClient,
  staleBefore: Date,
  limit = 100,
) {
  const candidates = await prisma.aiRequest.findMany({
    where: {
      // Agent/chat and inspiration-analysis requests have their own AiTask
      // heartbeat/recovery lifecycle. This sweeper owns image/video credits.
      capability: { in: ['IMAGE', 'VIDEO'] },
      status: { in: [...ACTIVE_REQUEST_STATUSES] },
      createdAt: { lt: staleBefore },
      completedAt: null,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(500, Math.round(limit))),
    select: {
      id: true,
      userId: true,
      capability: true,
      estimatedCredits: true,
      pricingSnapshot: true,
      clientRequestId: true,
    },
  });

  let recovered = 0;
  for (const candidate of candidates) {
    const now = new Date();
    try {
      const released = await prisma.$transaction(async transaction => {
        const claimed = await transaction.aiRequest.updateMany({
          where: {
            id: candidate.id,
            capability: { in: ['IMAGE', 'VIDEO'] },
            status: { in: [...ACTIVE_REQUEST_STATUSES] },
            createdAt: { lt: staleBefore },
            completedAt: null,
            estimatedCredits: candidate.estimatedCredits,
          },
          data: {
            status: 'FAILED',
            completedAt: now,
            failureDiagnostic: toInputJson(staleFailureDiagnostic(now)),
          },
        });
        if (claimed.count !== 1) return false;

        // A late video status poll must not leave a task looking successful
        // after its request reservation has already been released.
        await transaction.aiVideoTask.updateMany({
          where: {
            requestId: candidate.id,
            status: { notIn: ['SUCCEEDED', 'FAILED'] },
          },
          data: {
            status: 'FAILED',
            assetState: 'expired',
            videoAvailable: false,
            lastError: STALE_REQUEST_MESSAGE,
            completedAt: now,
          },
        });

        await releaseMembershipQuota(transaction, candidate.pricingSnapshot);
        const wallet = await transaction.wallet.update({
          where: { userId: candidate.userId },
          data: {
            availableCredits: { increment: candidate.estimatedCredits },
            reservedCredits: { decrement: candidate.estimatedCredits },
          },
        });
        await transaction.walletLedger.create({
          data: {
            userId: candidate.userId,
            requestId: candidate.id,
            type: 'RELEASE',
            amount: candidate.estimatedCredits,
            balanceAfter: wallet.availableCredits,
            description: `${candidate.capability} 请求超时，释放预扣额度`,
          },
        });
        return true;
      });
      if (released) {
        recovered += 1;
        console.warn('[ai_request_stale_recovered]', {
          requestId: candidate.id,
          clientRequestId: candidate.clientRequestId,
          userId: candidate.userId,
          capability: candidate.capability,
          estimatedCredits: candidate.estimatedCredits.toString(),
          staleBefore: staleBefore.toISOString(),
          recoveredAt: now.toISOString(),
        });
      }
    } catch (error) {
      console.error('[ai_request_stale_recovery_failed]', {
        requestId: candidate.id,
        clientRequestId: candidate.clientRequestId,
        userId: candidate.userId,
        capability: candidate.capability,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: candidates.length, recovered };
}

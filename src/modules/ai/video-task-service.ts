import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { creditDecimal } from '../wallets/credit-amount.js';
import { calculateSnapshotCharge, toInputJson, type PricingSnapshot } from './pricing-center.js';

export const VIDEO_TASK_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);

export const videoOutputIdempotencyKey = (clientRequestId: string, outputIndex: number) => (
  createHash('sha256').update(`${clientRequestId}:${outputIndex}`).digest('hex')
);

export const clampVideoPollAfterMs = (value: unknown, fallback = 2_500) => {
  const number = Number(value);
  // Providers commonly ask for 120s or more.  Keep a safety ceiling for
  // malformed responses, but never truncate a valid Retry-After/poll_after_ms
  // to the old 30s client cadence.
  return Number.isFinite(number) ? Math.max(1_000, Math.min(24 * 60 * 60_000, Math.round(number))) : fallback;
};

export async function createVideoTasks(
  prisma: PrismaClient,
  requestId: string,
  routeId: string,
  count: number,
) {
  await prisma.$transaction([
    prisma.aiVideoTask.deleteMany({ where: { requestId, outputIndex: { gte: count } } }),
    ...Array.from({ length: count }, (_, outputIndex) => prisma.aiVideoTask.upsert({
      where: { requestId_outputIndex: { requestId, outputIndex } },
      create: { requestId, routeId, outputIndex, status: 'RESERVED' },
      update: {
        routeId,
        upstreamTaskId: null,
        status: 'RESERVED',
        assetState: null,
        videoAvailable: null,
        pollAfterMs: null,
        lastPolledAt: null,
        resultObjectKey: null,
        resultUrl: null,
        upstreamPayload: Prisma.DbNull,
        lastError: null,
        completedAt: null,
      },
    })),
  ]);
  return prisma.aiVideoTask.findMany({ where: { requestId }, orderBy: { outputIndex: 'asc' } });
}

export async function recordVideoTaskSubmission(
  prisma: PrismaClient,
  taskId: string,
  submission: { upstreamTaskId: string; upstreamPayload: unknown; pollAfterMs?: number },
) {
  return prisma.$transaction(async transaction => {
    const task = await transaction.aiVideoTask.update({
      where: { id: taskId },
      data: {
        upstreamTaskId: submission.upstreamTaskId,
        upstreamPayload: toInputJson(submission.upstreamPayload),
        pollAfterMs: submission.pollAfterMs === undefined ? null : clampVideoPollAfterMs(submission.pollAfterMs),
        status: 'PROCESSING',
        lastError: null,
      },
    });
    await transaction.aiRequest.updateMany({
      where: { id: task.requestId, status: 'RESERVED' },
      data: { status: 'PROCESSING' },
    });
    return task;
  });
}

export async function recordVideoTaskFailure(
  prisma: PrismaClient,
  taskId: string,
  error: unknown,
) {
  return prisma.aiVideoTask.update({
    where: { id: taskId },
    data: {
      status: 'FAILED',
      lastError: error instanceof Error ? error.message : String(error),
      completedAt: new Date(),
    },
  });
}

export async function settleVideoRequestIfTerminal(prisma: PrismaClient, requestId: string) {
  return prisma.$transaction(async transaction => {
    const request = await transaction.aiRequest.findUnique({
      where: { id: requestId },
      include: { videoTasks: { orderBy: { outputIndex: 'asc' } } },
    });
    if (!request || !['RESERVED', 'PROCESSING'].includes(request.status)) return null;
    if (request.videoTasks.length === 0
      || request.videoTasks.some(task => !VIDEO_TASK_TERMINAL_STATUSES.has(task.status))) return null;

    const succeeded = request.videoTasks.filter(task => task.status === 'SUCCEEDED' && task.resultUrl);
    if (succeeded.length === 0) {
      const claimed = await transaction.aiRequest.updateMany({
        where: { id: request.id, status: { in: ['RESERVED', 'PROCESSING'] } },
        data: {
          status: 'FAILED',
          result: toInputJson({
            tasks: request.videoTasks.map(task => ({ id: task.id, status: task.status, error: task.lastError })),
          }),
          completedAt: new Date(),
        },
      });
      if (claimed.count !== 1) return null;
      const wallet = await transaction.wallet.update({
        where: { userId: request.userId },
        data: {
          availableCredits: { increment: request.estimatedCredits },
          reservedCredits: { decrement: request.estimatedCredits },
        },
      });
      await transaction.walletLedger.create({
        data: {
          userId: request.userId,
          requestId: request.id,
          type: 'RELEASE',
          amount: request.estimatedCredits,
          balanceAfter: wallet.availableCredits,
          description: '视频任务全部失败，释放预扣额度',
        },
      });
      return { status: 'failed' as const, generatedCount: 0 };
    }

    const pricingSnapshot = request.pricingSnapshot
      ? request.pricingSnapshot as unknown as PricingSnapshot
      : null;
    const breakdown = pricingSnapshot
      ? calculateSnapshotCharge(pricingSnapshot, { generatedCount: succeeded.length })
      : null;
    const chargedCredits = breakdown
      ? creditDecimal(breakdown.totalCredits)
      : request.estimatedCredits;
    if (chargedCredits.gt(request.estimatedCredits)) {
      throw new Error('Final video charge exceeds the reserved estimate');
    }
    const releasedCredits = request.estimatedCredits.sub(chargedCredits);
    const result = {
      results: succeeded.map(task => task.resultUrl!),
      tasks: request.videoTasks.map(task => ({
        id: task.id,
        outputIndex: task.outputIndex,
        status: task.status,
        resultUrl: task.resultUrl,
        error: task.lastError,
      })),
    };
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: request.id, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: {
        status: 'SUCCEEDED',
        chargedCredits,
        ...(breakdown ? { chargeBreakdown: toInputJson(breakdown) } : {}),
        result: toInputJson(result),
        completedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return null;
    if (breakdown && pricingSnapshot) {
      await transaction.aiBillingSettlement.create({
        data: {
          requestId: request.id,
          canonicalModelId: pricingSnapshot.canonicalModelId,
          routeId: pricingSnapshot.routeId,
          priceVersionId: pricingSnapshot.priceVersionId,
          chargedCredits,
          breakdown: toInputJson(breakdown),
        },
      });
    }
    const wallet = await transaction.wallet.update({
      where: { userId: request.userId },
      data: {
        reservedCredits: { decrement: request.estimatedCredits },
        ...(releasedCredits.gt(0) ? { availableCredits: { increment: releasedCredits } } : {}),
        ...(chargedCredits.gt(0) ? { lifetimeConsumed: { increment: chargedCredits } } : {}),
      },
    });
    if (chargedCredits.gt(0)) {
      await transaction.walletLedger.create({
        data: {
          userId: request.userId,
          requestId: request.id,
          type: 'CHARGE',
          amount: chargedCredits,
          balanceAfter: wallet.availableCredits,
          description: `视频请求结算（成功 ${succeeded.length}/${request.videoTasks.length}）`,
        },
      });
    }
    if (releasedCredits.gt(0)) {
      await transaction.walletLedger.create({
        data: {
          userId: request.userId,
          requestId: request.id,
          type: 'RELEASE',
          amount: releasedCredits,
          balanceAfter: wallet.availableCredits,
          description: '视频请求部分失败，释放未生成条目的预扣额度',
        },
      });
    }
    return { status: 'succeeded' as const, generatedCount: succeeded.length, result };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export function publicVideoTask(task: {
  id: string;
  upstreamTaskId: string | null;
  status: string;
  assetState: string | null;
  videoAvailable: boolean | null;
  pollAfterMs: number | null;
  resultUrl: string | null;
  lastError: string | null;
}) {
  const status = task.status === 'SUCCEEDED'
    ? 'completed'
    : task.status === 'FAILED' ? 'failed' : 'processing';
  const confirmationRequired = task.status === 'SUBMISSION_PENDING'
    || task.status === 'PERSISTENCE_PENDING';
  return {
    taskId: task.id,
    upstreamTaskId: task.upstreamTaskId,
    status,
    ...(confirmationRequired ? { confirmationRequired: true, recoveryStatus: 'pending_confirmation' } : {}),
    video_available: task.videoAvailable ?? Boolean(task.resultUrl),
    videoAvailable: task.videoAvailable ?? Boolean(task.resultUrl),
    asset_state: task.assetState,
    assetState: task.assetState,
    poll_after_ms: task.pollAfterMs,
    pollAfterMs: task.pollAfterMs,
    ...(task.resultUrl ? { video_url: task.resultUrl, videoUrl: task.resultUrl, walletVideoResults: [task.resultUrl] } : {}),
    ...(task.lastError ? { error: task.lastError } : {}),
  };
}

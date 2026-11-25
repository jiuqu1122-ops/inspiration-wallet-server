import { buildFailureDiagnostic, readFailureDiagnostic } from './failure-diagnostic.js';
import { Prisma, type AiRequest, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { sealProviderData, openProviderData } from '../../lib/provider-secrets.js';
import { creditDecimal } from '../wallets/credit-amount.js';
import { calculateSnapshotCharge, toInputJson, type PricingSnapshot } from './pricing-center.js';

import type { VideoInput } from './image-service.js';
import type { NormalizedVideoRequest } from './video-request.js';
import { isStoredVideoResultUrl } from './video-result-store.js';

export type VideoDispatch = {
  providerChannelId: string;
  genericRouteIds: string[];
  input: VideoInput;
  normalizedInput?: NormalizedVideoRequest;
};

const dispatchContext = (request: Pick<VideoInput, 'userId' | 'clientRequestId'>) =>
  Buffer.from(JSON.stringify(['video-dispatch', request.userId, request.clientRequestId]));

export const sealVideoDispatch = (request: VideoInput, dispatch: VideoDispatch) =>
  sealProviderData(dispatch, dispatchContext(request));

export const openVideoDispatch = (request: Pick<AiRequest, 'videoDispatch' | 'userId' | 'clientRequestId'>) =>
  request.videoDispatch ? openProviderData(request.videoDispatch, dispatchContext(request)) as VideoDispatch : null;

export const VIDEO_TASK_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);

export const videoOutputIdempotencyKey = (clientRequestId: string, outputIndex: number) => (
  createHash('sha256').update(`${clientRequestId}:${outputIndex}`).digest('hex')
);

export const clampVideoPollAfterMs = (value: unknown, fallback = 2_500) => {
  const number = value == null ? NaN : Number(value);
  // Providers commonly ask for 120s or more.  Keep a safety ceiling for
  // malformed responses, but never truncate a valid Retry-After/poll_after_ms
  // to the old 30s client cadence.
  return Number.isFinite(number) ? Math.max(1_000, Math.min(24 * 60 * 60_000, Math.round(number))) : fallback;
};

export async function settleVideoRequestIfTerminal(prisma: PrismaClient, requestId: string) {
  return prisma.$transaction(async transaction => {
    const request = await transaction.aiRequest.findUnique({
      where: { id: requestId },
      include: { videoTasks: { orderBy: { outputIndex: 'asc' } } },
    });
    if (!request || !['RESERVED', 'PROCESSING', 'SUCCEEDED'].includes(request.status)) return null;
    if (request.videoTasks.length === 0
      || request.videoTasks.some(task => !VIDEO_TASK_TERMINAL_STATUSES.has(task.status))) return null;

    const succeeded = request.videoTasks.filter(task => task.status === 'SUCCEEDED' && task.resultUrl);
    if (request.status === 'SUCCEEDED') {
      // Migration adopts already-charged receipts only when they were never
      // mirrored. Repair delivery without charging again.
      if (succeeded.length || request.videoDispatch || !request.chargedCredits.gt(0)) return null;
      const refunded = await transaction.aiRequest.updateMany({
        where: { id: request.id, status: 'SUCCEEDED' },
        data: { status: 'REFUNDED', completedAt: new Date() },
      });
      if (refunded.count !== 1) return null;
      const wallet = await transaction.wallet.update({
        where: { userId: request.userId },
        data: {
          availableCredits: { increment: request.chargedCredits },
          lifetimeConsumed: { decrement: request.chargedCredits },
        },
      });
      await transaction.walletLedger.create({
        data: {
          userId: request.userId, requestId: request.id, type: 'REFUND',
          amount: request.chargedCredits, balanceAfter: wallet.availableCredits,
          description: 'Previously charged video failed upstream',
        },
      });
      return { status: 'failed' as const, generatedCount: 0 };
    }

    if (succeeded.length === 0) {
      const claimed = await transaction.aiRequest.updateMany({
        where: { id: request.id, status: { in: ['RESERVED', 'PROCESSING'] } },
        data: {
          status: 'FAILED',
          videoDispatch: null,
          failureDiagnostic: toInputJson(
            readFailureDiagnostic(request.videoTasks.find(task => task.status === 'FAILED')?.failureDiagnostic)
            ?? buildFailureDiagnostic(undefined, { stage: 'video_task' }),
          ),
          result: toInputJson({ tasks: request.videoTasks.map(publicVideoTask) }),
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
      : creditDecimal(request.estimatedCredits.mul(succeeded.length).div(request.videoTasks.length).toFixed(6));
    if (chargedCredits.gt(request.estimatedCredits)) {
      throw new Error('Final video charge exceeds the reserved estimate');
    }
    const releasedCredits = request.estimatedCredits.sub(chargedCredits);
    const resultUrls = succeeded.map(task => task.resultUrl!);
    const primaryResultUrl = resultUrls[0] || null;
    const result = {
      results: resultUrls,
      ...(primaryResultUrl ? {
        // Keep the stable wallet URL under the field names used by both the
        // current canvas client and older video clients.
        video_url: primaryResultUrl,
        videoUrl: primaryResultUrl,
        result_url: primaryResultUrl,
        resultUrl: primaryResultUrl,
        cos_url: primaryResultUrl,
        cosUrl: primaryResultUrl,
      } : {}),
      tasks: request.videoTasks.map(publicVideoTask),
    };
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: request.id, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: {
        status: 'SUCCEEDED',
        videoDispatch: null,
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

const safeAssetStates = new Set(['available', 'ready', 'saved', 'saving', 'failed', 'expired']);

type PublicVideoTaskInput = {
  id: string;
  upstreamTaskId: string | null;
  outputIndex?: number;
  status: string;
  assetState: string | null;
  videoAvailable: boolean | null;
  pollAfterMs: number | null;
  resultUrl: string | null;
  nextPollAt?: Date | null;
  failureDiagnostic?: unknown;
  // Legacy database fields may still arrive during a rolling upgrade.
  upstreamPayload?: unknown;
  lastError?: string | null;
};

export function publicVideoTask(task: PublicVideoTaskInput) {
  const isRecovering = ['SUBMISSION_PENDING', 'CONFIRMATION_REQUIRED', 'PERSISTENCE_PENDING'].includes(task.status);
  const status = task.status === 'SUCCEEDED' ? 'succeeded'
    : task.status === 'FAILED' ? 'failed' : 'processing';
  const isTerminal = status !== 'processing';
  const resultUrl = status === 'succeeded' && task.resultUrl && isStoredVideoResultUrl(task.resultUrl)
    ? task.resultUrl : null;
  const diagnostic = readFailureDiagnostic(task.failureDiagnostic);
  const errorCode = isRecovering ? 'VIDEO_RECOVERY_PENDING' : status === 'failed'
    ? diagnostic?.code ?? 'GENERATION_FAILED' : null;
  const error = isRecovering ? '视频任务正在恢复或等待上游确认' : status === 'failed'
    ? diagnostic?.message ?? '视频生成失败' : null;
  const pollAfterMs = task.nextPollAt
    ? Math.max(1_000, task.nextPollAt.getTime() - Date.now())
    : task.pollAfterMs;
  const assetState = task.assetState && safeAssetStates.has(task.assetState) ? task.assetState : null;
  return {
    task_id: task.id,
    taskId: task.id,
    upstreamTaskIds: [task.id],
    outputIndex: task.outputIndex ?? 0,
    status,
    phase: task.status.toLowerCase(),
    progress: isTerminal ? 100 : task.status === 'QUEUED' ? 0 : task.status === 'SUBMITTING' ? 5
      : task.status === 'PERSISTENCE_PENDING' ? 90 : null,
    isTerminal, isRecovering,
    retryable: status === 'failed' && !['PROVIDER_AUTH_FAILED', 'PROVIDER_QUOTA_EXCEEDED',
      'PROVIDER_INVALID_REQUEST', 'PROVIDER_CONTENT_REJECTED'].includes(errorCode ?? ''),
    ...(isRecovering ? { confirmationRequired: true, recoveryStatus: 'pending_confirmation' } : {}),
    video_available: Boolean(resultUrl),
    videoAvailable: Boolean(resultUrl),
    asset_state: assetState,
    assetState,
    poll_after_ms: pollAfterMs,
    pollAfterMs,
    resultUrl,
    ...(resultUrl ? {
      video_url: resultUrl, videoUrl: resultUrl, result_url: resultUrl,
      cos_url: resultUrl, cosUrl: resultUrl, walletVideoResults: [resultUrl],
    } : {}),
    ...(errorCode ? { errorCode, error } : {}),
  };
}

export function storedHistoricalVideoUrls(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return isStoredVideoResultUrl(value) ? [value] : [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => storedHistoricalVideoUrls(item, depth + 1)))];
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...new Set(
    ['results', 'tasks', 'walletVideoResults', 'video_url', 'videoUrl', 'result_url', 'resultUrl', 'cos_url', 'cosUrl']
      .flatMap(key => storedHistoricalVideoUrls(row[key], depth + 1)),
  )];
}

type VideoRequestRecord = Pick<AiRequest, 'id' | 'clientRequestId' | 'logicalModel' | 'status' | 'chargedCredits' | 'result' | 'failureDiagnostic'>
  & { videoTasks: PublicVideoTaskInput[] };

export function publicVideoRequest(request: VideoRequestRecord) {
  const failed = request.status === 'FAILED' || request.status === 'REFUNDED';
  const recovering = !failed && request.videoTasks.some(task => !VIDEO_TASK_TERMINAL_STATUSES.has(task.status));
  const status = failed ? 'failed' : request.status === 'SUCCEEDED' && !recovering ? 'succeeded' : 'processing';
  const historical = request.videoTasks.length === 0 && status === 'succeeded'
    ? storedHistoricalVideoUrls(request.result) : [];
  const tasks = request.videoTasks.map(task => publicVideoTask(failed
    ? { ...task, status: 'FAILED', failureDiagnostic: task.failureDiagnostic ?? request.failureDiagnostic } : task));
  const diagnostic = failed ? readFailureDiagnostic(request.failureDiagnostic) : null;
  return {
    requestId: request.id,
    clientRequestId: request.clientRequestId,
    status,
    provider: 'managed',
    model: request.logicalModel,
    chargedCredits: request.chargedCredits.toString(),
    tasks,
    results: tasks.length ? tasks : historical,
    isTerminal: status !== 'processing',
    isRecovering: tasks.some(task => task.isRecovering),
    completedCount: tasks.length ? tasks.filter(task => task.isTerminal).length : historical.length,
    totalCount: tasks.length || historical.length,
    ...(failed ? { errorCode: diagnostic?.code ?? 'GENERATION_FAILED', error: diagnostic?.message ?? 'Video generation failed' } : {}),
  };
}

export async function getVideoRequestByClientId(prisma: PrismaClient, userId: string, clientRequestId: string) {
  const row = await prisma.aiRequest.findFirst({
    where: { userId, clientRequestId, capability: 'VIDEO' },
    include: { videoTasks: { orderBy: { outputIndex: 'asc' } } },
  });
  return row ? publicVideoRequest(row) : null;
}

export async function getVideoTaskForUser(
  prisma: PrismaClient,
  input: { userId: string; taskId: string; clientRequestId?: string | undefined },
) {
  const { userId, taskId, clientRequestId } = input;
  const task = await prisma.aiVideoTask.findFirst({
    where: {
      request: { userId, capability: 'VIDEO', ...(clientRequestId ? { clientRequestId } : {}) },
      OR: [{ id: taskId }, ...(clientRequestId ? [{ upstreamTaskId: taskId }] : [])],
    },
    include: { request: { select: { status: true, failureDiagnostic: true } } },
  });
  if (task) {
    const view = publicVideoTask(['FAILED', 'REFUNDED'].includes(task.request.status)
      ? { ...task, status: 'FAILED', failureDiagnostic: task.failureDiagnostic ?? task.request.failureDiagnostic } : task);
    // Echo only the already-known alias supplied by the owner of an old
    // receipt. New requests never disclose IDs assigned by the upstream.
    return view.taskId === taskId ? view : { ...view, task_id: taskId, taskId, upstreamTaskIds: [taskId] };
  }
  if (!clientRequestId) return null;
  // Older desktop clients used the original request ID as the task ID.
  const request = await getVideoRequestByClientId(prisma, userId, clientRequestId);
  if (!request) return null;
  if (taskId !== clientRequestId && request.tasks.length) return null;
  if (request.tasks.length === 1) return request.tasks[0];
  const historical = request.results.filter((result): result is string => typeof result === 'string');
  return { ...request, task_id: taskId, taskId, walletVideoResults: historical };
}

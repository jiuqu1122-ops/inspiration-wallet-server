import { randomUUID } from 'node:crypto';
import { Prisma, type AiVideoTask, type PrismaClient } from '@prisma/client';
import { decryptProviderSecrets, openProviderData, sealProviderData } from '../../lib/provider-secrets.js';
import { buildFailureDiagnostic } from './failure-diagnostic.js';
import { legacyVideoSubmitRejected, pollLegacyVideoTask, providerVideoResultRequestHeaders, submitLegacyVideoTask } from './image-service.js';
import { getVideoAdapter } from './video-adapters/registry.js';
import { isStoredVideoResultUrl, mirrorGeneratedVideoResultToStorage, recoverStoredVideoTaskResult } from './video-result-store.js';
import { clampVideoPollAfterMs, openVideoDispatch, settleVideoRequestIfTerminal, videoOutputIdempotencyKey } from './video-task-service.js';
import { logVideoEvent } from './video-log.js';
import { ReferenceUploadError, resolveReferenceImageSources, resolveVideoReferenceSources } from './reference-upload-service.js';
import type { VideoAdapterContext, VideoAdapterSubmission } from './video-adapters/types.js';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const DIAGNOSTIC_AFTER_MS = 60 * 60_000;
const activeParents: Prisma.AiRequestWhereInput = { status: { in: ['RESERVED', 'PROCESSING', 'SUCCEEDED'] } };
const dueStatuses = ['QUEUED', 'SUBMITTING', 'SUBMISSION_PENDING', 'PROCESSING', 'PERSISTENCE_PENDING', 'CONFIRMATION_REQUIRED'];

const include = { request: true, route: { include: { channel: true } } } as const;
type ClaimedTask = Prisma.AiVideoTaskGetPayload<{ include: typeof include }> & { leaseToken: string };

export async function claimVideoTask(prisma: PrismaClient, now = new Date()): Promise<ClaimedTask | null> {
  const due: Prisma.AiVideoTaskWhereInput = {
    status: { in: dueStatuses },
    nextPollAt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    request: activeParents,
  };
  // Compare-and-set works with other worker processes and with renewed leases.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = await prisma.aiVideoTask.findFirst({
      where: due, select: { id: true },
      orderBy: [{ nextPollAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) return null;
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claim = await prisma.aiVideoTask.updateMany({
      where: { id: candidate.id, ...due },
      data: { leaseToken, leaseUntil },
    });
    if (claim.count === 1) {
      const task = await prisma.aiVideoTask.findFirst({ where: { id: candidate.id, leaseToken }, include });
      return task ? { ...task, leaseToken } : null;
    }
  }
  return null;
}

function ownership(task: ClaimedTask): Prisma.AiVideoTaskWhereInput {
  return {
    id: task.id, leaseToken: task.leaseToken, leaseUntil: { gt: new Date() },
    request: activeParents,
  };
}

async function writeTask(prisma: PrismaClient, task: ClaimedTask, data: Prisma.AiVideoTaskUncheckedUpdateManyInput) {
  const updated = await prisma.aiVideoTask.updateMany({ where: ownership(task), data });
  return updated.count === 1;
}

function nextAt(hint: unknown, fallback?: number) {
  return new Date(Date.now() + clampVideoPollAfterMs(hint, fallback));
}

function retryAt(task: AiVideoTask, hint?: unknown, slow = false) {
  const backoff = Math.min(15 * 60_000, 2_500 * 2 ** Math.min(task.retryCount, 10));
  const minimum = slow ? Math.max(backoff, 60_000) : backoff;
  return nextAt(Math.max(minimum, clampVideoPollAfterMs(hint, minimum)));
}

function diagnose(error: unknown, stage: 'video_submit' | 'video_task') {
  return buildFailureDiagnostic(error, { stage });
}

function retryableStatus(error: unknown) {
  const status = Number((error as { status?: unknown } | undefined)?.status);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

// Only errors known to precede an HTTP exchange can put a POST back in the
// queue. A reset, HTTP 5xx, abort or deadline after dispatch is ambiguous.
function failedBeforeVideoSend(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth >= 6) return false;
  const entry = error as Record<string, unknown>;
  if (Array.isArray(entry.errors) && entry.errors.length) {
    return entry.errors.every((item: unknown) => failedBeforeVideoSend(item, depth + 1));
  }
  const code = entry.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT'
    || (entry.syscall === 'connect' && ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(code)))
    || failedBeforeVideoSend(entry.cause, depth + 1);
}

async function retrySubmission(prisma: PrismaClient, task: ClaimedTask, error: unknown) {
  await writeTask(prisma, task, {
    status: 'QUEUED', nextPollAt: retryAt(task), retryCount: { increment: 1 },
    failureDiagnostic: diagnose(error, 'video_submit'),
  });
}

const resultContext = (task: AiVideoTask) => Buffer.from(`video-delivery:${task.id}`);

async function saveReceipt(prisma: PrismaClient, task: ClaimedTask, receipt: {
  upstreamTaskId?: string | undefined;
  source?: string | undefined;
  pollAfterMs?: number | undefined;
}) {
  const source = receipt.source && sealProviderData(receipt.source, resultContext(task));
  const now = new Date();
  const updated = await writeTask(prisma, task, {
    status: source ? 'PERSISTENCE_PENDING' : 'PROCESSING',
    upstreamTaskId: receipt.upstreamTaskId ?? null,
    deliverySource: source || null,
    nextPollAt: source ? now : nextAt(receipt.pollAfterMs),
    pollAfterMs: clampVideoPollAfterMs(receipt.pollAfterMs), retryCount: 0,
    failureDiagnostic: Prisma.DbNull,
  });
  if (updated) {
    await prisma.aiRequest.updateMany({
      where: { id: task.requestId, status: 'RESERVED' },
      data: { status: 'PROCESSING' },
    });
  }
}

async function finishTask(prisma: PrismaClient, task: ClaimedTask, resultUrl: string | null, error?: unknown) {
  const key = resultUrl && isStoredVideoResultUrl(resultUrl) ? resultUrl.split('/').pop() : null;
  const success = Boolean(key);
  const updated = await writeTask(prisma, task, {
    status: success ? 'SUCCEEDED' : 'FAILED',
    assetState: success ? 'available' : 'failed',
    videoAvailable: success,
    resultUrl: success ? resultUrl : null,
    resultObjectKey: key ? `generated-videos/${key}` : null,
    failureDiagnostic: success ? Prisma.DbNull : diagnose(error, task.upstreamTaskId ? 'video_task' : 'video_submit'),
    completedAt: new Date(), nextPollAt: null, deliverySource: null,
  });
  if (updated) await settleVideoRequestIfTerminal(prisma, task.requestId);
}

async function pendingReceipt(prisma: PrismaClient, task: ClaimedTask, error?: unknown) {
  const adapter = getVideoAdapter(task.route?.adapterKey);
  const canLookup = task.route?.channel && adapter?.canRecoverSubmission?.({ route: task.route, provider: task.route.channel });
  await writeTask(prisma, task, {
    status: 'SUBMISSION_PENDING',
    nextPollAt: canLookup ? retryAt(task, undefined, true) : null,
    retryCount: { increment: 1 },
    failureDiagnostic: diagnose(error, 'video_submit'),
  });
}

async function recoverReceipt(prisma: PrismaClient, task: ClaimedTask, key: string) {
  const route = task.route;
  const adapter = getVideoAdapter(route?.adapterKey);
  if (!route?.channel || !adapter?.recoverSubmission
    || !adapter.canRecoverSubmission?.({ route, provider: route.channel })) {
    await pendingReceipt(prisma, task);
    return;
  }
  let receipt: VideoAdapterSubmission | null;
  try {
    receipt = await adapter.recoverSubmission({ route, provider: route.channel }, key);
  } catch (error) {
    await pendingReceipt(prisma, task, error);
    return;
  }
  if (receipt) await saveReceipt(prisma, task, receipt);
  else await pendingReceipt(prisma, task);
}

async function submitTask(prisma: PrismaClient, task: ClaimedTask, key: string) {
  const dispatch = openVideoDispatch(task.request);
  if (!dispatch) {
    await pendingReceipt(prisma, task);
    return;
  }
  const input = dispatch.input;
  let references: Pick<typeof input, 'inputImages' | 'inputVideos' | 'inputAudios'>;
  try {
    const [inputImages, inputVideos, inputAudios] = await Promise.all([
      resolveReferenceImageSources(prisma, task.request.userId, input.inputImages),
      resolveVideoReferenceSources(prisma, task.request.userId, input.inputVideos, 'video'),
      resolveVideoReferenceSources(prisma, task.request.userId, input.inputAudios, 'audio'),
    ]);
    references = { inputImages, inputVideos, inputAudios };
  } catch (error) {
    if (error instanceof ReferenceUploadError) await finishTask(prisma, task, null, error);
    else await retrySubmission(prisma, task, error);
    return;
  }
  // Write the attempt before sending bytes. A new worker must recover a
  // crashed attempt, even if it cannot determine whether the POST arrived.
  if (!await writeTask(prisma, task, { status: 'SUBMITTING' })) return;
  if (dispatch.normalizedInput && dispatch.genericRouteIds.length) {
    const normalized = { ...dispatch.normalizedInput, ...references };
    let lastRejection: unknown;
    for (const routeId of dispatch.genericRouteIds) {
      const route = await prisma.aiModelRoute.findUnique({ where: { id: routeId }, include: { channel: true } });
      const adapter = getVideoAdapter(route?.adapterKey);
      if (!route?.enabled || !route.channel || route.channel.status !== 'ACTIVE' || !adapter) continue;
      const context = { route, provider: route.channel };
      if (!adapter.canHandleRequest(context, normalized)) continue;
      if (!await writeTask(prisma, task, { routeId })) return;
      let receipt: VideoAdapterSubmission;
      try {
        receipt = await adapter.submit(context, normalized, task.outputIndex, key);
      } catch (error) {
        if (failedBeforeVideoSend(error)) {
          await retrySubmission(prisma, task, error);
          return;
        }
        if (legacyVideoSubmitRejected(error)) {
          lastRejection = error;
          continue;
        }
        await pendingReceipt(prisma, { ...task, route }, error);
        return;
      }
      // Retry only the receipt write if PostgreSQL briefly disconnects.
      try { await saveReceipt(prisma, task, receipt); }
      catch { await saveReceipt(prisma, task, receipt); }
      return;
    }
    await finishTask(prisma, task, null, lastRejection ?? new Error('Video route unavailable'));
    return;
  }
  const provider = await prisma.aiProviderChannel.findUnique({ where: { id: dispatch.providerChannelId } });
  if (!provider || provider.status !== 'ACTIVE') {
    await finishTask(prisma, task, null, new Error('Video channel unavailable'));
    return;
  }
  let receipt: Awaited<ReturnType<typeof submitLegacyVideoTask>>;
  try {
    receipt = await submitLegacyVideoTask(provider, { ...input, ...references }, key);
  } catch (error) {
    if (failedBeforeVideoSend(error)) await retrySubmission(prisma, task, error);
    else if (legacyVideoSubmitRejected(error)) await finishTask(prisma, task, null, error);
    else await pendingReceipt(prisma, task, error);
    return;
  }
  if (!receipt.upstreamTaskId && !receipt.source) {
    await pendingReceipt(prisma, task, new Error('Video channel returned no task receipt'));
    return;
  }
  try { await saveReceipt(prisma, task, receipt); }
  catch { await saveReceipt(prisma, task, receipt); }
}

async function deferPoll(prisma: PrismaClient, task: ClaimedTask, error: unknown, hint?: unknown) {
  const stalledSince = task.lastPolledAt ?? task.createdAt;
  const slow = !retryableStatus(error) || Date.now() - stalledSince.getTime() > DIAGNOSTIC_AFTER_MS;
  await writeTask(prisma, task, {
    status: slow ? 'CONFIRMATION_REQUIRED' : task.status === 'PERSISTENCE_PENDING' ? task.status : 'PROCESSING',
    failureDiagnostic: diagnose(error, 'video_task'),
    nextPollAt: retryAt(task, hint, slow), retryCount: { increment: 1 },
  });
}

async function persistVideo(prisma: PrismaClient, task: ClaimedTask, source: string, headers?: HeadersInit) {
  let resultUrl: string;
  try {
    resultUrl = await mirrorGeneratedVideoResultToStorage(source, headers, `wallet-video:${task.id}`);
  } catch (error) {
    await deferPoll(prisma, { ...task, status: 'PERSISTENCE_PENDING' }, error);
    return;
  }
  await finishTask(prisma, task, resultUrl);
}

async function pollManagedVideo(prisma: PrismaClient, task: ClaimedTask, context: VideoAdapterContext, upstreamTaskId: string) {
  const adapter = getVideoAdapter(context.route.adapterKey)!;
  const status = await adapter.poll(context, upstreamTaskId);
  if (status.state === 'failed') {
    await finishTask(prisma, task, null, status.error);
    return;
  }
  if (status.state === 'processing' && ['rate_limited', 'temporarily_unavailable'].includes(status.upstreamStatus)) {
    await deferPoll(prisma, task, new Error(status.upstreamStatus), status.pollAfterMs);
    return;
  }
  if (status.state === 'completed') {
    if (!await writeTask(prisma, task, { status: 'PERSISTENCE_PENDING', lastPolledAt: new Date() })) return;
    const content = await adapter.fetchContent(context, upstreamTaskId, status);
    await persistVideo(prisma, task, content.source, content.requestHeaders);
    return;
  }
  await schedulePoll(prisma, task, status.pollAfterMs);
}

async function schedulePoll(prisma: PrismaClient, task: ClaimedTask, hint?: number) {
  const pollAfterMs = clampVideoPollAfterMs(hint ?? task.pollAfterMs);
  await writeTask(prisma, task, {
    status: 'PROCESSING', lastPolledAt: new Date(), nextPollAt: nextAt(pollAfterMs),
    pollAfterMs, retryCount: 0, failureDiagnostic: Prisma.DbNull,
  });
}

async function pollTask(prisma: PrismaClient, task: ClaimedTask) {
  if (task.status === 'PERSISTENCE_PENDING') {
    const stored = await recoverStoredVideoTaskResult(task.id);
    if (stored) {
      await finishTask(prisma, task, stored);
      return;
    }
  }
  const upstreamTaskId = task.upstreamTaskId;
  const route = task.route;
  const adapter = getVideoAdapter(route?.adapterKey);
  if (route?.channel && adapter?.executionMode === 'async-task' && upstreamTaskId) {
    await pollManagedVideo(prisma, task, { route, provider: route.channel }, upstreamTaskId);
    return;
  }
  const dispatch = openVideoDispatch(task.request);
  const historical = task.request.result as { providerChannelId?: string } | null;
  const channelId = dispatch?.providerChannelId ?? historical?.providerChannelId;
  const provider = channelId
    ? await prisma.aiProviderChannel.findUnique({ where: { id: channelId } })
    : task.request.routeId
      ? (await prisma.aiModelRoute.findUnique({ where: { id: task.request.routeId }, include: { channel: true } }))?.channel
      : null;
  if (!provider) throw Object.assign(new Error('Video channel cannot be resolved'), { status: 404 });
  if (task.deliverySource) {
    const source = openProviderData(task.deliverySource, resultContext(task));
    if (typeof source !== 'string') throw new Error('Video delivery checkpoint is invalid');
    await persistVideo(prisma, task, source, providerVideoResultRequestHeaders(provider, source, decryptProviderSecrets(provider.encryptedSecrets)));
    return;
  }
  if (!upstreamTaskId) throw Object.assign(new Error('Video receipt is unavailable'), { status: 404 });
  const status = await pollLegacyVideoTask(provider, upstreamTaskId);
  if (status.state === 'failed') await finishTask(prisma, task, null, status.error);
  else if (status.source) {
    // On mirror failure, repoll for a fresh URL. Never persist upstream
    // response bodies or expose signed URLs through the wallet.
    if (!await writeTask(prisma, task, { status: 'PERSISTENCE_PENDING', lastPolledAt: new Date() })) return;
    await persistVideo(prisma, task, status.source,
      providerVideoResultRequestHeaders(provider, status.source, decryptProviderSecrets(provider.encryptedSecrets)));
  } else await schedulePoll(prisma, task, status.pollAfterMs);
}

export async function processVideoTask(prisma: PrismaClient, task: ClaimedTask) {
  const heartbeat = setInterval(() => {
    void writeTask(prisma, task, { leaseUntil: new Date(Date.now() + LEASE_MS) }).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const key = videoOutputIdempotencyKey(`${task.request.userId}:${task.request.clientRequestId}`, task.outputIndex);
    if (task.status === 'QUEUED') await submitTask(prisma, task, key);
    else if (task.status === 'SUBMITTING' || task.status === 'SUBMISSION_PENDING') await recoverReceipt(prisma, task, key);
    else {
      try { await pollTask(prisma, task); }
      catch (error) { await deferPoll(prisma, task, error, (error as { retryAfterMs?: number })?.retryAfterMs); }
    }
  } catch (error) {
    // Persisted steps and deadlines are the source of truth after DB failure.
    // An in-flight submit is never replayed regardless of when the DB failed.
    await writeTask(prisma, task, {
      nextPollAt: retryAt(task, undefined, true), retryCount: { increment: 1 },
      failureDiagnostic: diagnose(error, task.upstreamTaskId ? 'video_task' : 'video_submit'),
    }).catch(() => {});
    logVideoEvent('video_worker_step_failed', { taskId: task.id });
  } finally {
    clearInterval(heartbeat);
    await prisma.aiVideoTask.updateMany({
      where: { id: task.id, leaseToken: task.leaseToken }, data: { leaseUntil: null, leaseToken: null },
    }).catch(() => {});
  }
}

export async function recoverVideoSettlement(prisma: PrismaClient) {
  const request = await prisma.aiRequest.findFirst({
    where: {
      capability: 'VIDEO',
      OR: [
        { status: { in: ['RESERVED', 'PROCESSING'] }, videoTasks: { some: {}, every: { status: { in: ['SUCCEEDED', 'FAILED'] } } } },
        { status: 'SUCCEEDED', videoDispatch: null, chargedCredits: { gt: 0 },
          videoTasks: { some: { id: { startsWith: 'video-legacy-' } }, every: { status: 'FAILED' } } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (request) await settleVideoRequestIfTerminal(prisma, request.id);
}

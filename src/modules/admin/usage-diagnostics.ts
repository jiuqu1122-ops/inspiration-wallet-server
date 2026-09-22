import type { AiCapability, Prisma, PrismaClient } from '@prisma/client';
import { buildFailureDiagnostic, readFailureDiagnostic } from '../ai/failure-diagnostic.js';
import {
  createUsageTimingCollector, decodeUsageCursor, encodeUsageCursor,
  timingModality, usageDiagnosticsRange, usageDurationMs,
} from './usage-diagnostics-core.js';

const PAGE_SIZE = 500;
const SCAN_LIMIT = 100_000;
const IMAGE_CAPABILITIES: AiCapability[] = [
  'IMAGE', 'IMAGE_NANO_BANANA', 'IMAGE_NANO_BANANA_2', 'IMAGE_NANO_BANANA_PRO_FAST',
  'IMAGE_NANO_BANANA_2_FAST', 'IMAGE_NANO_BANANA_PRO_1K', 'IMAGE_NANO_BANANA_DUAL_2K',
  'IMAGE_GPT', 'IMAGE_GPT_1K', 'IMAGE_GROK',
];

export class UsageDiagnosticsError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 400) { super(code); }
}

function scopedRange(days: number, now: Date) {
  try { return usageDiagnosticsRange(days, now); }
  catch { throw new UsageDiagnosticsError('invalid_usage_range'); }
}

/** Keep the date window identical to existing usage; discard future-clock-skew rows. */
function createdWindow(range: ReturnType<typeof scopedRange>) {
  return { gte: range.start, lt: range.end, lte: range.asOf };
}

export async function getAdminUsageMetrics(prisma: PrismaClient, days = 1, now = new Date()) {
  const range = scopedRange(days, now);
  const collector = createUsageTimingCollector(now);
  let count = 0;
  let after: { id: string; createdAt: Date } | undefined;
  // Select metadata only. Never load result/base64/prompt payloads to calculate statistics.
  while (true) {
    const rows = await prisma.aiRequest.findMany({
      where: {
        status: 'SUCCEEDED', createdAt: createdWindow(range),
        capability: { in: [...IMAGE_CAPABILITIES, 'LLM', 'VISION'] },
        ...(after ? { OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ] } : {}),
      },
      select: {
        id: true, capability: true, logicalModel: true, status: true, createdAt: true, completedAt: true,
        canonicalModel: { select: { canonicalModelKey: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE_SIZE,
    });
    for (const row of rows) {
      const modality = timingModality(row.capability);
      if (modality && modality !== 'video') collector.add({
        ...row, modality,
        modelKey: row.canonicalModel?.canonicalModelKey || row.logicalModel || 'unknown',
        displayName: row.canonicalModel?.displayName || row.logicalModel || '未知模型',
      });
    }
    count += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (count >= SCAN_LIMIT) throw new UsageDiagnosticsError('usage_range_too_large', 422);
    after = rows[rows.length - 1]!;
  }

  let videoAfter: { id: string; createdAt: Date } | undefined;
  let videoCount = 0;
  while (true) {
    const rows = await prisma.aiVideoTask.findMany({
      where: {
        status: 'SUCCEEDED', request: { createdAt: createdWindow(range) },
        ...(videoAfter ? { OR: [
          { createdAt: { lt: videoAfter.createdAt } },
          { createdAt: videoAfter.createdAt, id: { lt: videoAfter.id } },
        ] } : {}),
      },
      select: {
        id: true, status: true, createdAt: true, completedAt: true,
        request: { select: {
          logicalModel: true, canonicalModel: { select: { canonicalModelKey: true, displayName: true } },
        } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE_SIZE,
    });
    for (const row of rows) collector.add({
      ...row, modality: 'video',
      modelKey: row.request.canonicalModel?.canonicalModelKey || row.request.logicalModel || 'unknown',
      displayName: row.request.canonicalModel?.displayName || row.request.logicalModel || '未知模型',
    });
    videoCount += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (videoCount >= SCAN_LIMIT) throw new UsageDiagnosticsError('usage_range_too_large', 422);
    videoAfter = rows[rows.length - 1]!;
  }
  return {
    days, timeZone: 'Asia/Shanghai', generatedAt: now.toISOString(),
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    // Image/text: one successful logical request; video: one completed managed output.
    ...collector.result(),
  };
}

export type UsageErrorsInput = {
  days: number; limit: number; cursor?: string | undefined; snapshotAt?: string | undefined;
  kind?: 'all' | 'image' | 'text' | 'video' | undefined; query?: string | undefined;
};

export async function listAdminUsageErrors(prisma: PrismaClient, input: UsageErrorsInput, now = new Date()) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new UsageDiagnosticsError('invalid_usage_limit');
  const snapshot = input.snapshotAt ? new Date(input.snapshotAt) : now;
  if (!Number.isFinite(snapshot.getTime()) || snapshot.getTime() > now.getTime()
    || now.getTime() - snapshot.getTime() > 31 * 86_400_000) throw new UsageDiagnosticsError('invalid_usage_snapshot');
  const range = scopedRange(input.days, snapshot);
  let cursor: ReturnType<typeof decodeUsageCursor>;
  try { cursor = decodeUsageCursor(input.cursor); }
  catch { throw new UsageDiagnosticsError('invalid_usage_cursor'); }
  const query = input.query?.trim();
  if (query && query.length > 128) throw new UsageDiagnosticsError('invalid_usage_query');
  if (input.kind && !['all', 'image', 'text', 'video'].includes(input.kind)) throw new UsageDiagnosticsError('invalid_usage_kind');
  const capabilities: AiCapability[] | undefined = input.kind === 'image' ? IMAGE_CAPABILITIES
    : input.kind === 'text' ? ['LLM', 'VISION']
      : input.kind === 'video' ? ['VIDEO', 'VIDEO_MINIMAX'] : undefined;
  const where: Prisma.AiRequestWhereInput = {
    createdAt: createdWindow(range),
    ...(capabilities ? { capability: { in: capabilities } } : {}),
    AND: [
      { OR: [{ status: { in: ['FAILED', 'REFUNDED'] } }, { videoTasks: { some: { status: 'FAILED' } } }] },
      ...(query ? [{ OR: [
        { id: { contains: query, mode: 'insensitive' as const } },
        { clientRequestId: { contains: query, mode: 'insensitive' as const } },
        { logicalModel: { contains: query, mode: 'insensitive' as const } },
        { canonicalModel: { displayName: { contains: query, mode: 'insensitive' as const } } },
        { user: { email: { contains: query, mode: 'insensitive' as const } } },
        { user: { displayName: { contains: query, mode: 'insensitive' as const } } },
      ] }] : []),
    ],
  };
  const [total, rows] = await Promise.all([
    prisma.aiRequest.count({ where }),
    prisma.aiRequest.findMany({
      where: cursor ? { AND: [where, { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] }] } : where,
      select: {
        id: true, clientRequestId: true, status: true, logicalModel: true, capability: true,
        createdAt: true, completedAt: true, failureDiagnostic: true,
        canonicalModel: { select: { canonicalModelKey: true, displayName: true } },
        route: { select: { upstreamModelId: true, channel: { select: { name: true } } } },
        user: { select: { id: true, email: true, displayName: true } },
        videoTasks: {
          where: { status: 'FAILED' }, take: 16, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, lastError: true, completedAt: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit + 1,
    }),
  ]);
  const page = rows.slice(0, input.limit);
  return {
    total, snapshotAt: snapshot.toISOString(), days: input.days,
    nextCursor: rows.length > input.limit && page.length ? encodeUsageCursor(page[page.length - 1]!) : null,
    items: page.map(row => {
      const taskWithError = row.videoTasks.find(task => Boolean(task.lastError));
      const outputDiagnostic = taskWithError
        ? buildFailureDiagnostic(taskWithError.lastError, { stage: 'video_task' }, taskWithError.completedAt ?? snapshot)
        : null;
      // A request can be reused after a prior failure. For a currently partial
      // success, use the current failed output, not stale request metadata.
      const diagnostic = ['FAILED', 'REFUNDED'].includes(row.status)
        ? readFailureDiagnostic(row.failureDiagnostic) ?? outputDiagnostic
        : outputDiagnostic;
      return {
        id: row.id, clientRequestId: row.clientRequestId, status: row.status,
        kind: timingModality(row.capability) ?? 'other',
        modelKey: row.canonicalModel?.canonicalModelKey || row.logicalModel,
        modelName: row.canonicalModel?.displayName || row.logicalModel || '未知模型',
        channelName: row.route?.channel?.name ?? null,
        upstreamModel: row.route?.upstreamModelId ?? null,
        user: row.user, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
        // Historical legacy video requests may finish at receipt time: don't claim that was render time.
        durationMs: timingModality(row.capability) === 'video' ? null : usageDurationMs(row.createdAt, row.completedAt, snapshot),
        failedOutputCount: row.videoTasks.length,
        diagnostic,
      };
    }),
  };
}

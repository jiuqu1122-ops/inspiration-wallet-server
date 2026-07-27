import { AiTaskStatus, AiTaskType, Prisma, type AiTask, type PrismaClient } from '@prisma/client';
import { releaseRequestCreditsForClientRequest, sanitizeAgentUpstreamDetail } from './service.js';
import type { CreateAiTaskInput } from './task-schema.js';

export type PublicTaskError = {
  code: string;
  message: string;
};

const publicType = (type: AiTaskType) => (
  type === AiTaskType.AGENT_CHAT ? 'agent_chat' : 'inspiration_analysis'
);

export const publicTaskStatus = (status: AiTaskStatus) => status.toLowerCase();

export function serializeAiTask(task: AiTask) {
  return {
    taskId: task.id,
    type: publicType(task.type),
    status: publicTaskStatus(task.status),
    progress: task.progress,
    stage: task.stage,
    ...(task.result !== null ? { result: task.result } : {}),
    ...(task.error !== null ? { error: task.error } : {}),
    requestId: task.requestId,
    retryCount: task.retryCount,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    updatedAt: task.updatedAt.toISOString(),
  };
}

function taskType(input: CreateAiTaskInput) {
  return input.type === 'agent_chat'
    ? AiTaskType.AGENT_CHAT
    : AiTaskType.INSPIRATION_ANALYSIS;
}

export async function createAiTask(
  prisma: PrismaClient,
  userId: string,
  input: CreateAiTaskInput,
) {
  const type = taskType(input);
  const key = { userId, type, requestId: input.requestId };
  const existing = await prisma.aiTask.findUnique({
    where: { userId_type_requestId: key },
  });
  if (existing) return { task: existing, created: false };

  try {
    const task = await prisma.aiTask.create({
      data: {
        ...key,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
    return { task, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const task = await prisma.aiTask.findUniqueOrThrow({
      where: { userId_type_requestId: key },
    });
    return { task, created: false };
  }
}

export async function findUserAiTask(prisma: PrismaClient, userId: string, taskId: string) {
  return prisma.aiTask.findFirst({ where: { id: taskId, userId } });
}

export async function cancelUserAiTask(prisma: PrismaClient, userId: string, taskId: string) {
  const existing = await findUserAiTask(prisma, userId, taskId);
  if (!existing) return null;
  const completedAt = new Date();
  const cancelled = await prisma.aiTask.updateMany({
    where: {
      id: taskId,
      userId,
      status: { in: [AiTaskStatus.QUEUED, AiTaskStatus.RUNNING] },
    },
    data: {
      status: AiTaskStatus.CANCELLED,
      stage: 'cancelled',
      completedAt,
      heartbeatAt: completedAt,
      error: { code: 'CANCELLED', message: '任务已取消' },
    },
  });
  if (cancelled.count === 1) {
    await releaseRequestCreditsForClientRequest(prisma, userId, existing.requestId);
  }
  return findUserAiTask(prisma, userId, taskId);
}

export async function claimNextAiTask(prisma: PrismaClient, workerId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const queued = await prisma.aiTask.findFirst({
      where: { status: AiTaskStatus.QUEUED },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!queued) return null;
    const now = new Date();
    const claimed = await prisma.aiTask.updateMany({
      where: { id: queued.id, status: AiTaskStatus.QUEUED },
      data: {
        status: AiTaskStatus.RUNNING,
        stage: 'starting',
        progress: 2,
        workerId,
        heartbeatAt: now,
        startedAt: queued.startedAt ?? now,
      },
    });
    if (claimed.count === 1) {
      return prisma.aiTask.findUniqueOrThrow({ where: { id: queued.id } });
    }
  }
  return null;
}

export async function heartbeatAiTask(
  prisma: PrismaClient,
  taskId: string,
  workerId: string,
  progress?: number,
  stage?: string,
  retryCount?: number,
) {
  const data: Prisma.AiTaskUpdateManyMutationInput = { heartbeatAt: new Date() };
  if (progress !== undefined) data.progress = Math.max(0, Math.min(99, Math.round(progress)));
  if (stage) data.stage = stage.slice(0, 100);
  if (retryCount !== undefined) data.retryCount = Math.max(0, Math.round(retryCount));
  return prisma.aiTask.updateMany({
    where: { id: taskId, workerId, status: AiTaskStatus.RUNNING },
    data,
  });
}

export async function completeAiTask(
  prisma: PrismaClient,
  taskId: string,
  workerId: string,
  result: unknown,
) {
  const now = new Date();
  return prisma.aiTask.updateMany({
    where: { id: taskId, workerId, status: AiTaskStatus.RUNNING },
    data: {
      status: AiTaskStatus.SUCCEEDED,
      stage: 'completed',
      progress: 100,
      result: result as Prisma.InputJsonValue,
      error: Prisma.DbNull,
      completedAt: now,
      heartbeatAt: now,
    },
  });
}

export function sanitizeTaskError(error: unknown): PublicTaskError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const rawCode = typeof record?.code === 'string' ? record.code : '';
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '任务执行失败';
  const knownCodes: Record<string, string> = {
    provider_request_failed: 'UPSTREAM_UNAVAILABLE',
    provider_stream_interrupted: 'UPSTREAM_UNAVAILABLE',
    provider_invalid_response: 'UPSTREAM_INVALID_RESPONSE',
    insufficient_credits: 'INSUFFICIENT_CREDITS',
    TASK_TIMEOUT: 'TASK_TIMEOUT',
  };
  const code = knownCodes[rawCode] ?? 'TASK_FAILED';
  return {
    code,
    message: sanitizeAgentUpstreamDetail(rawMessage).slice(0, 500) || '任务执行失败，请稍后重试',
  };
}

export async function failAiTask(
  prisma: PrismaClient,
  taskId: string,
  workerId: string,
  error: unknown,
) {
  const now = new Date();
  return prisma.aiTask.updateMany({
    where: { id: taskId, workerId, status: AiTaskStatus.RUNNING },
    data: {
      status: AiTaskStatus.FAILED,
      stage: 'failed',
      error: sanitizeTaskError(error),
      completedAt: now,
      heartbeatAt: now,
    },
  });
}

export async function markStaleAiTaskFailed(
  prisma: PrismaClient,
  taskId: string,
  staleBefore: Date,
) {
  const now = new Date();
  return prisma.aiTask.updateMany({
    where: {
      id: taskId,
      status: AiTaskStatus.RUNNING,
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: AiTaskStatus.FAILED,
      stage: 'worker_lost',
      error: { code: 'WORKER_LOST', message: '后台任务进程中断，请重新提交' },
      completedAt: now,
      heartbeatAt: now,
    },
  });
}

export async function cleanupCompletedAiTasks(prisma: PrismaClient, completedBefore: Date) {
  return prisma.aiTask.deleteMany({
    where: {
      status: { in: [AiTaskStatus.SUCCEEDED, AiTaskStatus.FAILED, AiTaskStatus.CANCELLED] },
      completedAt: { lt: completedBefore },
    },
  });
}

import { hostname } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { AiTaskStatus, AiTaskType, PrismaClient, type AiTask } from '@prisma/client';
import { env } from './config/env.js';
import {
  executeWalletInspirationAnalysis,
  executeWalletAgentChat,
  releaseRequestCreditsForClientRequest,
  type AgentExecutionProgress,
} from './modules/ai/service.js';
import { agentTaskPayloadSchema, inspirationTaskPayloadSchema } from './modules/ai/task-schema.js';
import {
  claimNextAiTask,
  cleanupCompletedAiTasks,
  completeAiTask,
  failAiTask,
  heartbeatAiTask,
  markStaleAiTaskFailed,
} from './modules/ai/task-service.js';

const prisma = new PrismaClient();
const workerId = `${hostname()}:${process.pid}`;
const active = new Set<Promise<void>>();
let shuttingDown = false;

function log(event: string, fields: Record<string, unknown> = {}) {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    workerId,
    ...fields,
  }));
}

function taskLogFields(task: AiTask) {
  return {
    requestId: task.requestId,
    taskId: task.id,
    userId: task.userId,
    taskType: task.type,
    retryCount: task.retryCount,
  };
}

async function recoverStaleTasks() {
  const staleBefore = new Date(Date.now() - env.AI_TASK_STALE_AFTER_MS);
  const stale = await prisma.aiTask.findMany({
    where: {
      status: AiTaskStatus.RUNNING,
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    select: { id: true, userId: true, requestId: true, type: true },
  });
  let recovered = 0;
  for (const task of stale) {
    const result = await markStaleAiTaskFailed(prisma, task.id, staleBefore);
    if (result.count !== 1) continue;
    recovered += 1;
    await releaseRequestCreditsForClientRequest(prisma, task.userId, task.requestId);
  }
  if (recovered > 0) log('stale_tasks_failed', { count: recovered });
}

async function executeTask(task: AiTask) {
  const started = Date.now();
  log('task_started', {
    ...taskLogFields(task),
    stage: 'starting',
    queueDurationMs: Math.max(0, started - task.createdAt.getTime()),
  });
  const controller = new AbortController();
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void prisma.aiTask.findUnique({
      where: { id: task.id },
      select: { status: true, workerId: true },
    }).then((current) => {
      if (!current || current.status !== AiTaskStatus.RUNNING || current.workerId !== workerId) {
        controller.abort(new Error('Task cancelled or ownership lost'));
        return;
      }
      return heartbeatAiTask(prisma, task.id, workerId);
    }).catch(error => {
      log('task_heartbeat_failed', { ...taskLogFields(task), errorCode: 'HEARTBEAT_FAILED' });
      console.error(error);
    }).finally(() => {
      heartbeatBusy = false;
    });
  }, env.AI_TASK_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const timeout = setTimeout(() => {
    const error = Object.assign(new Error('后台任务执行超时'), { code: 'TASK_TIMEOUT' });
    controller.abort(error);
  }, env.AI_TASK_MAX_RUNTIME_MS);
  timeout.unref();

  const onProgress = async (progress: AgentExecutionProgress) => {
    const update = await heartbeatAiTask(
      prisma,
      task.id,
      workerId,
      progress.progress,
      progress.stage,
      progress.attempt !== undefined ? Math.max(0, progress.attempt - 1) : undefined,
    );
    if (update.count !== 1) controller.abort(new Error('Task cancelled or ownership lost'));
    log('task_progress', {
      ...taskLogFields(task),
      stage: progress.stage,
      progress: progress.progress,
      model: progress.model,
      provider: progress.provider,
      attempt: progress.attempt,
      durationMs: progress.durationMs,
      firstChunkMs: progress.firstChunkMs,
      upstreamStatus: progress.upstreamStatus,
    });
  };

  try {
    await onProgress({ stage: 'preparing', progress: 5 });
    let result: unknown;
    if (task.type === AiTaskType.AGENT_CHAT) {
      const payload = agentTaskPayloadSchema.parse(task.payload);
      result = await executeWalletAgentChat(prisma, {
        userId: task.userId,
        clientRequestId: task.requestId,
        ...payload,
      }, { signal: controller.signal, onProgress });
    } else {
      const payload = inspirationTaskPayloadSchema.parse(task.payload);
      result = await executeWalletInspirationAnalysis(
        prisma,
        {
          userId: task.userId,
          clientRequestId: task.requestId,
          ...payload,
        },
        { signal: controller.signal, onProgress },
      );
    }
    const completed = await completeAiTask(prisma, task.id, workerId, result);
    if (completed.count === 1) {
      log('task_succeeded', { ...taskLogFields(task), stage: 'completed', durationMs: Date.now() - started });
    }
  } catch (error) {
    await releaseRequestCreditsForClientRequest(prisma, task.userId, task.requestId);
    const failed = await failAiTask(prisma, task.id, workerId, error);
    if (failed.count === 1) {
      log('task_failed', {
        ...taskLogFields(task),
        stage: 'failed',
        durationMs: Date.now() - started,
        errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'TASK_FAILED',
      });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

async function updateHealthFile() {
  await writeFile(env.WORKER_HEALTH_FILE, `${Date.now()}\n`, 'utf8');
}

async function main() {
  await prisma.$connect();
  await recoverStaleTasks();
  let lastCleanupAt = 0;
  let lastRecoveryAt = Date.now();
  log('worker_started', { concurrency: env.AI_WORKER_CONCURRENCY });

  while (!shuttingDown) {
    await updateHealthFile();
    if (Date.now() - lastRecoveryAt > env.AI_TASK_STALE_AFTER_MS / 2) {
      await recoverStaleTasks();
      lastRecoveryAt = Date.now();
    }
    if (Date.now() - lastCleanupAt > 60 * 60_000) {
      const retentionMs = env.AI_TASK_RETENTION_DAYS * 24 * 60 * 60_000;
      const cleaned = await cleanupCompletedAiTasks(prisma, new Date(Date.now() - retentionMs));
      if (cleaned.count > 0) log('tasks_cleaned', { count: cleaned.count });
      lastCleanupAt = Date.now();
    }

    while (!shuttingDown && active.size < env.AI_WORKER_CONCURRENCY) {
      const task = await claimNextAiTask(prisma, workerId);
      if (!task) break;
      const promise = executeTask(task).finally(() => active.delete(promise));
      active.add(promise);
    }
    await new Promise(resolve => setTimeout(resolve, env.AI_TASK_POLL_INTERVAL_MS));
  }
  await Promise.allSettled(active);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('worker_stopping', { signal, activeTasks: active.size });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await main();
  await prisma.$disconnect();
} catch (error) {
  log('worker_fatal', { errorCode: 'WORKER_FATAL' });
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
}

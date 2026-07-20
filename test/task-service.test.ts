import { AiTaskStatus, AiTaskType, type AiTask, type PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { aiRoutes } from '../src/modules/ai/routes.js';
import {
  claimNextAiTask,
  completeAiTask,
  createAiTask,
  failAiTask,
  markStaleAiTaskFailed,
  sanitizeTaskError,
  serializeAiTask,
} from '../src/modules/ai/task-service.js';

const makeTask = (overrides: Partial<AiTask> = {}): AiTask => ({
  id: 'task-1',
  userId: 'user-1',
  type: AiTaskType.AGENT_CHAT,
  status: AiTaskStatus.QUEUED,
  progress: 0,
  stage: 'queued',
  payload: { messages: [{ role: 'user', content: 'hello' }] },
  result: null,
  error: null,
  requestId: 'request-123',
  retryCount: 0,
  workerId: null,
  heartbeatAt: null,
  createdAt: new Date('2026-07-20T00:00:00Z'),
  startedAt: null,
  completedAt: null,
  updatedAt: new Date('2026-07-20T00:00:00Z'),
  ...overrides,
});

function taskPrisma(initial?: AiTask) {
  let task = initial ?? null;
  const aiTask = {
    findUnique: async () => task,
    findUniqueOrThrow: async () => {
      if (!task) throw new Error('not found');
      return task;
    },
    findFirst: async (args: { where?: { status?: AiTaskStatus } }) => (
      task && (!args.where?.status || task.status === args.where.status) ? task : null
    ),
    create: async (args: { data: Partial<AiTask> }) => {
      task = makeTask(args.data);
      return task;
    },
    updateMany: async (args: { where: { id?: string; status?: AiTaskStatus; workerId?: string }; data: Partial<AiTask> }) => {
      if (!task
        || args.where.id && task.id !== args.where.id
        || args.where.status && task.status !== args.where.status
        || args.where.workerId && task.workerId !== args.where.workerId) return { count: 0 };
      task = { ...task, ...args.data, updatedAt: new Date() } as AiTask;
      return { count: 1 };
    },
  };
  return {
    prisma: { aiTask } as unknown as PrismaClient,
    current: () => task,
  };
}

describe('PostgreSQL-backed AI tasks', () => {
  it('creates once and returns the same task for a duplicate requestId', async () => {
    const fake = taskPrisma();
    const input = {
      type: 'agent_chat' as const,
      requestId: 'request-123',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    };
    const first = await createAiTask(fake.prisma, 'user-1', input);
    const second = await createAiTask(fake.prisma, 'user-1', input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('allows only one worker to claim a queued task', async () => {
    const fake = taskPrisma(makeTask());
    const [first, second] = await Promise.all([
      claimNextAiTask(fake.prisma, 'worker-a'),
      claimNextAiTask(fake.prisma, 'worker-b'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(fake.current()?.status).toBe(AiTaskStatus.RUNNING);
  });

  it('moves queued to running to succeeded while preserving result JSON', async () => {
    const fake = taskPrisma(makeTask());
    const claimed = await claimNextAiTask(fake.prisma, 'worker-a');
    expect(claimed?.stage).toBe('starting');
    const result = { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
    await completeAiTask(fake.prisma, 'task-1', 'worker-a', result);
    const publicTask = serializeAiTask(fake.current()!);
    expect(publicTask).toMatchObject({ status: 'succeeded', progress: 100, result });
  });

  it('marks a stale running task failed instead of leaving it stuck', async () => {
    const fake = taskPrisma(makeTask({
      status: AiTaskStatus.RUNNING,
      workerId: 'dead-worker',
      heartbeatAt: new Date('2026-07-19T00:00:00Z'),
    }));
    const marked = await markStaleAiTaskFailed(
      fake.prisma,
      'task-1',
      new Date('2026-07-20T00:00:00Z'),
    );
    expect(marked.count).toBe(1);
    expect(fake.current()).toMatchObject({ status: AiTaskStatus.FAILED, stage: 'worker_lost' });
  });

  it('stores a sanitized structured task error', async () => {
    const fake = taskPrisma(makeTask({ status: AiTaskStatus.RUNNING, workerId: 'worker-a' }));
    const error = Object.assign(
      new Error('authorization=sk-secretvalue123456 upstream timed out'),
      { code: 'provider_request_failed' },
    );
    await failAiTask(fake.prisma, 'task-1', 'worker-a', error);
    expect(fake.current()?.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(JSON.stringify(fake.current()?.error)).not.toContain('secretvalue');
    expect(sanitizeTaskError(error).message).toContain('[REDACTED]');
  });

  it('returns 202 with a taskId without running model work in the request', async () => {
    const fake = taskPrisma();
    const app = Fastify();
    app.decorate('prisma', fake.prisma);
    app.decorate('authenticateAccessToken', async (request: { user?: unknown }) => {
      request.user = { sub: 'user-1' };
    });
    await app.register(aiRoutes, { prefix: '/v1/ai' });
    const startedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/tasks',
      payload: {
        type: 'agent_chat',
        requestId: 'request-123',
        payload: { messages: [{ role: 'user', content: 'hello' }] },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ taskId: 'task-1', status: 'queued' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await app.close();
  });
});

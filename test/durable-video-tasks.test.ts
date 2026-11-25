import { readFile, readdir } from 'node:fs/promises';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { aiRoutes } from '../src/modules/ai/routes.js';
import { claimVideoTask, processVideoTask, recoverVideoSettlement } from '../src/modules/ai/video-worker.js';
import { recoverStaleAiRequests } from '../src/modules/ai/request-recovery.js';
import { sealVideoDispatch, settleVideoRequestIfTerminal } from '../src/modules/ai/video-task-service.js';
import { createHash } from 'node:crypto';

const objects = vi.hoisted(() => new Set<string>());
const referenceObjects = vi.hoisted(() => new Map<string, { contentLength: number; contentType: string }>());
const uploads = vi.hoisted(() => vi.fn(async ({ namespace, filename }: { namespace: string; filename: string }) => {
  const key = `${namespace}/${filename}`;
  objects.add(key);
  return key;
}));
const logs = vi.hoisted(() => vi.fn());
vi.mock('../src/config/logger.js', () => ({ serviceLogger: { info: logs } }));
vi.mock('../src/modules/storage/service.js', () => ({
  storageService: {
    providerName: 'tencent-cos',
    uploadMedia: uploads,
    exists: async (key: string) => objects.has(key),
    headObject: async (key: string) => referenceObjects.get(key) ?? null,
    createUploadUrl: (key: string) => ({
      url: `https://cos.example.test/${key}?token=test-upload`, method: 'PUT', headers: {},
    }),
    getDownloadUrl: () => 'https://cos.example.test/private?token=cos-secret',
  },
}));

const db = new PGlite();
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 });
let prisma: PrismaClient;
let app: FastifyInstance;
let providerId: string;
const openConnection = () => new PrismaClient({
  datasourceUrl: `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable&connection_limit=1`,
});
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const signed = 'https://1.1.1.1/private-token-in-path/output.mp4?token=secret-token&sign=secret-sign'
  + '&signature=secret-signature&authorization=secret-auth&X-Amz-Signature=aws-secret&q-signature=cos-secret&q-key-time=cos-time';
const header = (owner: string) => ({ authorization: `Bearer ${owner}` });

beforeAll(async () => {
  const root = new URL('../prisma/migrations/', import.meta.url);
  for (const dir of (await readdir(root, { withFileTypes: true })).filter(dir => dir.isDirectory())) {
    if (dir.name.endsWith('_durable_video_tasks')) {
      await db.exec(`
        INSERT INTO "User" ("id", "updatedAt") VALUES ('migration-video-owner', now());
        INSERT INTO "AiRequest" (id, "userId", "clientRequestId", "capability", "logicalModel", status, "estimatedCredits", result)
        VALUES ('migration-video-request', 'migration-video-owner', 'migration-video-client', 'VIDEO', 'minimax-h3', 'PROCESSING', 42,
          '{"providerChannelId":"old-channel","upstreamTaskIds":["old-1","old-2"],"results":[{"task_id":"old-1","video_url":"https://api.example.test/v1/ai/video-results/${'a'.repeat(64)}.mp4","upstream":{"signature":"sensitive-old-body"}}]}'::jsonb);
        INSERT INTO "AiRequest" (id, "userId", "clientRequestId", "capability", "logicalModel", status, "estimatedCredits")
        VALUES ('migration-video-uncertain', 'migration-video-owner', 'migration-video-no-id', 'VIDEO', 'minimax-h3', 'RESERVED', 10);
        INSERT INTO "AiRequest" (id, "userId", "clientRequestId", "capability", "logicalModel", status, "estimatedCredits", result)
        VALUES ('migration-video-nested', 'migration-video-owner', 'migration-video-nested-client', 'VIDEO', 'minimax-h3', 'PROCESSING', 11,
          '{"results":[{"task_id":"old-nested-task"}]}'::jsonb);
      `);
    }
    await db.exec(await readFile(new URL(`${dir.name}/migration.sql`, root), 'utf8'));
  }
  await server.start();
  prisma = openConnection();
  providerId = (await prisma.aiProviderChannel.create({ data: {
    name: 'native-video-test', kind: 'MINIMAX', baseUrl: 'https://8.8.4.4', defaultModel: 'MiniMax-H3',
    capabilities: ['VIDEO_MINIMAX'], apiKeyLast4: 'test',
    encryptedSecrets: encryptProviderSecrets({ apiKey: 'upstream-test-key', headers: {} }),
  } })).id;
  app = Fastify({ routerOptions: { maxParamLength: 128 } });
  app.decorate('prisma', prisma);
  app.decorate('authenticateAccessToken', async (request, reply) => {
    const sub = request.headers.authorization?.replace(/^Bearer /, '');
    if (!sub) { await reply.code(401).send(); return; }
    request.user = { sub } as typeof request.user;
  });
  await app.register(aiRoutes, { prefix: '/v1/ai' });
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  uploads.mockClear();
  logs.mockClear();
  await prisma.aiVideoTask.updateMany({ data: { nextPollAt: null } });
});
afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await server.stop();
  await db.close();
});

async function makeUser(id: string) {
  return prisma.user.create({ data: { id, wallet: { create: { availableCredits: 100_000 } } } });
}

const payload = (clientRequestId: string, count = 1) => ({
  clientRequestId, count, model: 'minimax-h3', provider: 'minimax', prompt: 'video test', resolution: '2K',
  duration: 5, aspectRatio: '16:9',
});
const submit = (owner: string, id: string, count = 1) => app.inject({
  method: 'POST', url: '/v1/ai/videos', headers: header(owner), payload: payload(id, count),
});
const lookup = (owner: string, id: string) => app.inject({
  method: 'GET', url: `/v1/ai/videos/by-request/${id}`, headers: header(owner),
});
async function next(client = prisma) {
  const task = await claimVideoTask(client);
  expect(task).not.toBeNull();
  if (!task) throw new Error('Expected a queued video task');
  await processVideoTask(client, task);
  return task;
}
const forceDue = (requestId: string) => prisma.aiVideoTask.updateMany({
  where: { requestId, status: { notIn: ['SUCCEEDED', 'FAILED'] } },
  data: { nextPollAt: new Date(0) },
});

describe('durable wallet video workflow', () => {
  it('migrates legacy receipts and preserves an uncertain reservation without replaying it', async () => {
    const history = await prisma.aiRequest.findUniqueOrThrow({
      where: { id: 'migration-video-request' }, include: { videoTasks: { orderBy: { outputIndex: 'asc' } } },
    });
    expect(history.estimatedCredits.toString()).toBe('42');
    expect(history.videoTasks.map(task => [task.upstreamTaskId, task.status])).toEqual([
      ['old-1', 'SUCCEEDED'], ['old-2', 'PROCESSING'],
    ]);
    expect(history.videoTasks[1]?.nextPollAt).toBeInstanceOf(Date);
    expect(JSON.stringify(history.result)).not.toContain('sensitive-old-body');
    const uncertain = await prisma.aiVideoTask.findFirstOrThrow({ where: { requestId: 'migration-video-uncertain' } });
    expect(uncertain).toMatchObject({ status: 'SUBMISSION_PENDING', nextPollAt: null });
    const nested = await prisma.aiVideoTask.findFirstOrThrow({ where: { requestId: 'migration-video-nested' } });
    expect(nested).toMatchObject({ status: 'PROCESSING', upstreamTaskId: 'old-nested-task' });
    expect(await prisma.walletLedger.count()).toBe(0);
  });

  it('uses an owned COS media reference after the desktop request has disconnected', async () => {
    const owner = 'video-reference-owner';
    const anotherUser = 'video-reference-stranger';
    await Promise.all([makeUser(owner), makeUser(anotherUser)]);
    const uploadTicket = await app.inject({
      method: 'POST', url: '/v1/ai/videos/reference-upload-ticket', headers: header(owner),
      payload: { filename: 'reference.mp4', mime: 'video/mp4', sizeBytes: 24 },
    });
    expect(uploadTicket.statusCode).toBe(200);
    const { objectKey } = uploadTicket.json();
    expect(objectKey).toMatch(/^reference-video-inputs\//);
    referenceObjects.set(objectKey, { contentLength: 24, contentType: 'video/mp4' });
    const submitReference = (user: string, id: string) => app.inject({
      method: 'POST', url: '/v1/ai/videos', headers: header(user),
      payload: { ...payload(id), inputVideos: [objectKey] },
    });
    expect((await submitReference(anotherUser, 'video-ref-unauthorized')).statusCode).toBe(422);
    const queued = await submitReference(owner, 'video-ref-owner');
    expect(queued.statusCode).toBe(200);
    const fetchMock = vi.fn(async (_url, request: RequestInit) => {
      const generation = JSON.parse(String(request.body));
      expect(generation.content).toContainEqual({
        type: 'video_url', role: 'reference_video', video_url: { url: 'https://cos.example.test/private?token=cos-secret' },
      });
      return Response.json({ task_id: 'owned-media-upstream' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await next();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps a lost submit response recoverable, processes outputs concurrently and settles exactly once', async () => {
    const owner = 'video-owner-1';
    const requestId = 'video-batch-receipt-lost';
    await Promise.all([makeUser(owner), makeUser('video-other-owner')]);
    let upstreamPosts = 0;
    let pendingPolls = 0;
    const fetchMock = vi.fn(async (resource: URL | string, init?: RequestInit) => {
      const url = new URL(String(resource));
      if (init?.method === 'POST') {
        upstreamPosts += 1;
        return Response.json({ task_id: `ark-video-${upstreamPosts}`, poll_after_ms: 12_000 });
      }
      if (url.hostname === '1.1.1.1') {
        expect(url.toString()).toBe(signed);
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
      }
      const id = url.pathname.split('/').at(-1);
      if (id === 'ark-video-1' && pendingPolls++ === 0) {
        return Response.json({ task: { id, status: 'running' }, poll_after_ms: 20_000 });
      }
      return Response.json({ task: { id, status: 'succeeded', content: { url: signed } } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // One caller drops its response. The second races the same identity.
    const [, replay] = await Promise.all([submit(owner, requestId, 2), submit(owner, requestId, 2)]);
    expect(replay.statusCode).toBe(200);
    const created = replay.json();
    expect(upstreamPosts).toBe(0);
    expect(created.tasks.map((task: { phase: string }) => task.phase)).toEqual(['queued', 'queued']);
    expect((await lookup(owner, requestId)).json()).toEqual(created);
    expect((await lookup('video-other-owner', requestId)).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/ai/videos/by-request/${requestId}` })).statusCode).toBe(401);

    const jobs = (await Promise.all([claimVideoTask(prisma), claimVideoTask(prisma)]))
      .filter((task): task is NonNullable<typeof task> => Boolean(task));
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(task => task.id)).size).toBe(2);
    expect(await claimVideoTask(prisma)).toBeNull();
    await Promise.all(jobs.map(job => processVideoTask(prisma, job)));
    expect(upstreamPosts).toBe(2);
    expect((await submit(owner, requestId, 2)).json().requestId).toBe(created.requestId);

    // No GET from a client triggers either the status poll or the COS mirror.
    const restarted = openConnection();
    try {
      await forceDue(created.requestId);
      await next(restarted);
      await next(restarted);
      const partial = await prisma.aiVideoTask.findMany({ where: { requestId: created.requestId } });
      expect(partial.map(task => task.status).sort()).toEqual(['PROCESSING', 'SUCCEEDED']);
      expect(await claimVideoTask(restarted)).toBeNull();
      await forceDue(created.requestId);
      await next(restarted);
      await Promise.all([settleVideoRequestIfTerminal(prisma, created.requestId), recoverVideoSettlement(restarted)]);
    } finally {
      await restarted.$disconnect();
    }
    const completed = (await lookup(owner, requestId)).json();
    expect(completed.status).toBe('succeeded');
    expect(completed.tasks).toHaveLength(2);
    expect(completed.tasks.every((task: { resultUrl: string }) => /^https:\/\/api\.example\.test\/v1\/ai\/video-results\//.test(task.resultUrl))).toBe(true);
    expect(completed.tasks[0].resultUrl).not.toBe(completed.tasks[1].resultUrl);
    expect(uploads).toHaveBeenCalledTimes(2);
    expect(await prisma.walletLedger.findMany({ where: { requestId: created.requestId }, orderBy: { createdAt: 'asc' } })
      .then(rows => rows.map(row => row.type))).toEqual(['RESERVE', 'CHARGE']);
    expect((await submit(owner, requestId, 2)).json().requestId).toBe(created.requestId);
    expect(upstreamPosts).toBe(2);
    const emitted = JSON.stringify(logs.mock.calls) + JSON.stringify(completed);
    expect(emitted).not.toMatch(/secret-token|secret-sign|secret-auth|aws-secret|cos-secret|cos-time|private-token-in-path/);
    expect(emitted).toContain('1.1.1.1');
  }, 20_000);

  it('backs off on polling errors, holds old reservations, and releases only on a confirmed terminal failure', async () => {
    const owner = 'video-owner-2';
    const requestId = 'video-confirmed-failure';
    await makeUser(owner);
    let statusReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ task_id: 'upstream-confirmed-failure' });
      statusReads += 1;
      if (statusReads === 1) return new Response('gateway unavailable', { status: 503, headers: { 'retry-after': '32' } });
      return Response.json({ task: {
        id: 'upstream-confirmed-failure', status: 'failed',
        error: { message: 'token=private-stack /app/internal/secret https://p.internal/r?signature=signed-upstream' },
      } });
    }));
    const queued = (await submit(owner, requestId)).json();
    await next();
    await forceDue(queued.requestId);
    const startedAt = Date.now();
    await next();
    const pending = await prisma.aiVideoTask.findFirstOrThrow({ where: { requestId: queued.requestId } });
    expect(pending.retryCount).toBe(1);
    expect(pending.nextPollAt!.getTime() - startedAt).toBeGreaterThanOrEqual(30_000);
    expect(await claimVideoTask(prisma)).toBeNull();
    await prisma.aiRequest.update({ where: { id: queued.requestId }, data: { createdAt: new Date(0) } });
    await recoverStaleAiRequests(prisma, new Date());
    expect(await prisma.walletLedger.count({ where: { requestId: queued.requestId, type: 'RELEASE' } })).toBe(0);
    await forceDue(queued.requestId);
    await next();
    await Promise.all([settleVideoRequestIfTerminal(prisma, queued.requestId), settleVideoRequestIfTerminal(prisma, queued.requestId)]);
    const failed = (await lookup(owner, requestId)).json();
    expect(failed).toMatchObject({ status: 'failed', tasks: [{ status: 'failed', isTerminal: true, errorCode: 'GENERATION_FAILED' }] });
    const oldApi = await app.inject({ url: `/v1/ai/videos/${failed.tasks[0].taskId}`, headers: header(owner) });
    expect(JSON.stringify(failed) + oldApi.body).not.toMatch(/p\.internal|signed-upstream|private-stack|\/app\/internal|upstreamPayload/);
    expect(await prisma.walletLedger.count({ where: { requestId: queued.requestId, type: 'RELEASE' } })).toBe(1);
  });

  it('does not replay a POST after a Worker dies with unknown upstream acceptance', async () => {
    const owner = 'video-owner-3';
    await makeUser(owner);
    const queued = (await submit(owner, 'video-crashed-submit')).json();
    const claim = await claimVideoTask(prisma);
    expect(claim).not.toBeNull();
    await prisma.aiVideoTask.update({ where: { id: claim!.id }, data: { status: 'SUBMITTING', leaseUntil: new Date(0) } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await next();
    await recoverStaleAiRequests(prisma, new Date(Date.now() + 60_000));
    expect((await lookup(owner, 'video-crashed-submit')).json()).toMatchObject({
      requestId: queued.requestId, status: 'processing',
      tasks: [{ phase: 'submission_pending', isRecovering: true, retryable: false }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.walletLedger.count({ where: { requestId: queued.requestId, type: { not: 'RESERVE' } } })).toBe(0);
  });

  it('recovers an uncertain managed receipt through its configured provider lookup without a second POST', async () => {
    const owner = 'video-owner-managed';
    await makeUser(owner);
    const input = {
      ...payload('managed-video-lookup'), userId: owner, provider: 'minimax' as const,
      inputImages: [], inputVideos: [], inputAudios: [], inputMode: 'REF' as const,
    };
    const route = await prisma.aiModelRoute.create({ data: {
      provider: 'MINIMAX', channelId: providerId, upstreamModelId: 'generic-video', enabled: true,
      adapterKey: 'GENERIC_ASYNC_VIDEO',
      adapterConfig: {
        taskIdPath: 'task_id',
        submissionLookupEndpointTemplate: '/v1/videos/by-key/{idempotencyKey}',
      },
    } });
    const row = await prisma.aiRequest.create({ data: {
      userId: owner, clientRequestId: input.clientRequestId, capability: 'VIDEO', logicalModel: input.model,
      status: 'RESERVED', videoDispatch: sealVideoDispatch(input, {
        input, normalizedInput: input, providerChannelId: providerId, genericRouteIds: [route.id],
      }),
      videoTasks: { create: { outputIndex: 0, routeId: route.id, status: 'QUEUED', nextPollAt: new Date(0) } },
    } });
    let key = '';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        key = new Headers(init.headers).get('idempotency-key') || '';
        return new Response('Upstream gateway response was lost', { status: 502 });
      }
      expect(url).toContain(`/v1/videos/by-key/${key}`);
      return Response.json({ task_id: 'managed-upstream-restored' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await next();
    expect((await lookup(owner, input.clientRequestId)).json().tasks[0].phase).toBe('submission_pending');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    await forceDue(row.id);
    await next();
    const recovered = (await lookup(owner, input.clientRequestId)).json();
    expect(recovered.tasks[0].phase).toBe('processing');
    expect(JSON.stringify(recovered)).not.toContain('managed-upstream-restored');
    expect(await prisma.aiVideoTask.findFirst({ where: { requestId: row.id } }))
      .toMatchObject({ upstreamTaskId: 'managed-upstream-restored' });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
  });

  it('reuses a COS object after a crash between upload and database completion', async () => {
    const owner = 'video-owner-cos-resume';
    await makeUser(owner);
    const queued = (await submit(owner, 'video-result-already-uploaded')).json();
    const taskId = queued.tasks[0].taskId;
    const hash = createHash('sha256').update(`wallet-video-result:${taskId}`).digest('hex');
    objects.add(`generated-videos/${hash}.mp4`);
    await prisma.aiVideoTask.update({ where: { id: taskId }, data: {
      status: 'PERSISTENCE_PENDING', upstreamTaskId: 'upstream-cos-resume',
      nextPollAt: new Date(0), leaseUntil: new Date(0),
    } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await next();
    expect((await lookup(owner, 'video-result-already-uploaded')).json().status).toBe('succeeded');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploads).not.toHaveBeenCalled();
  });

  it('refunds a previously charged legacy receipt exactly once on confirmed failure', async () => {
    const owner = 'video-owner-legacy';
    await makeUser(owner);
    await prisma.wallet.update({ where: { userId: owner }, data: { lifetimeConsumed: 21 } });
    const record = await prisma.aiRequest.create({ data: {
      userId: owner, clientRequestId: 'video-previously-charged', capability: 'VIDEO',
      logicalModel: 'minimax-h3', status: 'SUCCEEDED', chargedCredits: 21,
      result: { providerChannelId: providerId, upstreamTaskIds: ['legacy-upstream'] },
      videoTasks: { create: {
        id: 'video-legacy-fixture', outputIndex: 0, status: 'FAILED', upstreamTaskId: 'legacy-upstream', completedAt: new Date(),
      } },
    } });
    await Promise.all([recoverVideoSettlement(prisma), settleVideoRequestIfTerminal(prisma, record.id)]);
    expect(await prisma.walletLedger.count({ where: { requestId: record.id, type: 'REFUND' } })).toBe(1);
    expect(await prisma.wallet.findUnique({ where: { userId: owner } }).then(row => row?.lifetimeConsumed.toNumber())).toBe(0);
  });
});

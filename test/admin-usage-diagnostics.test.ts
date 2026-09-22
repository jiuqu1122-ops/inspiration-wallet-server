import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { createUsageTimingCollector, usageDiagnosticsRange, usageDurationMs, encodeUsageCursor, decodeUsageCursor } from '../src/modules/admin/usage-diagnostics-core.js';
import { buildFailureDiagnostic, readFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';
import { getAdminUsageMetrics, listAdminUsageErrors } from '../src/modules/admin/usage-diagnostics.js';

const now = new Date('2026-09-22T04:00:00Z');
const start = new Date('2026-09-22T01:00:00Z');
const end = (ms: number) => new Date(start.getTime() + ms);
const model = { canonicalModelKey: 'nano-banana-pro', displayName: 'Nano Banana Pro' };
const req = (id: string, ms: number | null, capability = 'IMAGE') => ({
  id, status: 'SUCCEEDED', capability, logicalModel: 'upstream-name', canonicalModel: model,
  createdAt: start, completedAt: ms === null ? null : end(ms),
});
const errorRow = () => ({
  id: 'request-1', clientRequestId: 'canvas-request-1', status: 'FAILED', logicalModel: 'nano-banana-pro',
  capability: 'IMAGE', createdAt: start, completedAt: end(1000), failureDiagnostic: null,
  canonicalModel: model, route: { upstreamModelId: 'gemini-native', channel: { name: 'USELG' } },
  user: { id: 'user-1', email: 'a@example.test', displayName: '测试' }, videoTasks: [],
});

test('UTC+8 day range matches the existing usage dashboard', () => {
  const range = usageDiagnosticsRange(1, now);
  assert.equal(range.start.toISOString(), '2026-09-21T16:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-09-22T16:00:00.000Z');
  assert.equal(usageDiagnosticsRange(7, now).start.toISOString(), '2026-09-15T16:00:00.000Z');
});
test('midnight rollover and invalid date window validation', () => {
  assert.equal(usageDiagnosticsRange(1, new Date('2026-09-22T16:00:00Z')).start.toISOString(), '2026-09-22T16:00:00.000Z');
  for (const days of [0, -1, 31, 1.2, NaN]) assert.throws(() => usageDiagnosticsRange(days, now));
});
test('missing, inverted, future and invalid timestamps are excluded', () => {
  assert.equal(usageDurationMs(start, null, now), null);
  assert.equal(usageDurationMs(undefined, end(100), now), null);
  assert.equal(usageDurationMs(start, new Date(start.getTime() - 1), now), null);
  assert.equal(usageDurationMs(start, new Date(now.getTime() + 1), now), null);
  assert.equal(usageDurationMs(new Date('invalid'), end(1), now), null);
});
test('real zero milliseconds is a valid sample', () => assert.equal(usageDurationMs(start, start, now), 0));
test('average is weighted across actual requests, never model averages', () => {
  const acc = createUsageTimingCollector(now);
  for (const [name, ms] of [['A', 1000], ['A', 1000], ['B', 10000]] as const) acc.add({
    status: 'SUCCEEDED', modality: 'image', modelKey: name, displayName: name, createdAt: start, completedAt: end(ms),
  });
  assert.deepEqual(acc.result().image, { samples: 3, missingSamples: 0, averageMs: 4000 });
});
test('pending/failed requests never enter success averages, missing samples stay visible', () => {
  const acc = createUsageTimingCollector(now);
  for (const status of ['FAILED', 'PROCESSING', 'SUCCEEDED']) acc.add({ status, modality: 'image', modelKey: 'A', displayName: 'A', createdAt: start, completedAt: null });
  assert.deepEqual(acc.result().image, { samples: 0, missingSamples: 1, averageMs: null });
});
test('image, text and per-output video metrics are not combined', () => {
  const acc = createUsageTimingCollector(now);
  acc.add({ status: 'SUCCEEDED', modality: 'text', modelKey: 'same', displayName: 'same', createdAt: start, completedAt: end(200) });
  acc.add({ status: 'SUCCEEDED', modality: 'video', modelKey: 'same', displayName: 'same', createdAt: start, completedAt: end(60000) });
  assert.equal(acc.result().models.length, 2);
  assert.equal(acc.result().image.averageMs, null);
  assert.equal(acc.result().video.averageMs, 60000);
});
test('cursor roundtrip and malformed cursors', () => {
  assert.deepEqual(decodeUsageCursor(encodeUsageCursor({ id: 'abc123', createdAt: start })), { id: 'abc123', createdAt: start });
  for (const cursor of ['!!', 'a'.repeat(513), Buffer.from('{"id":"../x","at":"oops"}').toString('base64url')]) assert.throws(() => decodeUsageCursor(cursor));
});
test('nested persistence error captures size limit without discarding the cause', () => {
  const error = Object.assign(new Error('Generated image result could not be persisted to object storage', { cause: new Error('reference image is too large') }), { code: 'IMAGE_RESULT_PERSISTENCE_FAILED' });
  const result = buildFailureDiagnostic(error, { stage: 'image_generation', resolution: '4k' }, now);
  assert.equal(result.code, 'IMAGE_SIZE_LIMIT'); assert.equal(result.stage, 'result_persistence'); assert.equal(result.resolution, '4k');
});
test('raw secrets, signed URLs, prompts, base64 and stack never leave classification', () => {
  const secret = 'sk-super-private-123456';
  const error = Object.assign(new Error(`HTTP 403 https://host/image?signature=${secret} prompt=private ${'A'.repeat(2000)}`), { status: 403 });
  const result = JSON.stringify(buildFailureDiagnostic(error, { stage: 'image_generation' }, now));
  assert.ok(!result.includes(secret)); assert.ok(!result.includes('https://')); assert.ok(!result.includes('prompt='));
  assert.match(result, /PROVIDER_AUTH_FAILED/);
});
test('circular causes and throwing error getters cannot break failure handling', () => {
  const cyclic: Record<string, unknown> = { message: 'fetch failed' }; cyclic.cause = cyclic;
  assert.equal(buildFailureDiagnostic(cyclic, { stage: 'text_request' }, now).code, 'NETWORK_ERROR');
  assert.doesNotThrow(() => buildFailureDiagnostic({ get message() { throw new Error('bad getter'); } }, { stage: 'text_request' }, now));
});
test('HTTP 429, server failures, timeouts and cancellations have separate codes', () => {
  assert.equal(buildFailureDiagnostic({ status: 429 }, { stage: 'text_request' }, now).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(buildFailureDiagnostic({ status: 503 }, { stage: 'text_request' }, now).code, 'PROVIDER_SERVER_ERROR');
  assert.equal(buildFailureDiagnostic(new Error('timeout'), { stage: 'text_request' }, now).code, 'PROVIDER_TIMEOUT');
  assert.equal(buildFailureDiagnostic(new Error('Task cancelled'), { stage: 'text_request' }, now).code, 'REQUEST_CANCELLED');
});
test('stored diagnostics are re-whitelisted; arbitrary messages and causes are not returned', () => {
  const valid = buildFailureDiagnostic(new Error('timeout'), { stage: 'text_request' }, now);
  assert.equal(readFailureDiagnostic({ ...valid, message: 'private prompt', causeCode: 'secret' })?.message, '等待上游响应或读取响应超时');
  assert.equal(readFailureDiagnostic({ ...valid, code: '__proto__' }), null);
  assert.equal(readFailureDiagnostic(null), null);
});
test('metrics queries only bounded metadata, and measure video outputs separately', async () => {
  const queries: unknown[] = [];
  const db = {
    aiRequest: { findMany: async (q: unknown) => { queries.push(q); return [req('a', 1000), req('b', 3000), req('c', null, 'LLM')]; } },
    aiVideoTask: { findMany: async (q: unknown) => { queries.push(q); return [{ id: 'v1', status: 'SUCCEEDED', createdAt: start, completedAt: end(20000), request: { logicalModel: 'video', canonicalModel: null } }]; } },
  } as unknown as PrismaClient;
  const result = await getAdminUsageMetrics(db, 1, now);
  assert.equal(result.image.averageMs, 2000); assert.equal(result.image.samples, 2);
  assert.equal(result.text.averageMs, null); assert.equal(result.video.averageMs, 20000);
  for (const q of queries as Array<{ take: number; select: Record<string, unknown> }>) {
    assert.equal(q.take, 500); assert.ok(!('result' in q.select)); assert.ok(!('upstreamPayload' in q.select));
  }
});
test('metrics read the next metadata page instead of truncating at 500', async () => {
  let calls = 0;
  const db = {
    aiRequest: { findMany: async (q: unknown) => {
      calls += 1;
      if (calls === 1) return Array.from({ length: 500 }, (_, i) => req(`id${i}`, 100));
      assert.ok(JSON.stringify(q).includes('id499'));
      return [req('last', 601)];
    } }, aiVideoTask: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const result = await getAdminUsageMetrics(db, 7, now);
  assert.equal(result.image.samples, 501); assert.equal(result.image.averageMs, 101); assert.equal(calls, 2);
});
test('error list includes failed-only users and gives historical unknown reasons honestly', async () => {
  const db = { aiRequest: { count: async () => 1, findMany: async () => [errorRow()] } } as unknown as PrismaClient;
  const result = await listAdminUsageErrors(db, { days: 1, limit: 25 }, now);
  assert.equal(result.total, 1); assert.equal(result.items[0]?.diagnostic, null);
  assert.equal(result.items[0]?.durationMs, 1000); assert.equal(result.nextCursor, null);
});
test('error pagination fetches one extra row; count has no cursor and search stays parameterized', async () => {
  const qs: unknown[] = [];
  const db = { aiRequest: {
    count: async (q: unknown) => { qs.push(q); return 30; },
    findMany: async (q: unknown) => { qs.push(q); return Array.from({ length: 3 }, (_, i) => ({ ...errorRow(), id: `id${i}` })); },
  } } as unknown as PrismaClient;
  const cursor = encodeUsageCursor({ id: 'cursor-1', createdAt: start });
  const result = await listAdminUsageErrors(db, { days: 7, limit: 2, cursor, query: "' OR 1=1 --", kind: 'image' }, now);
  assert.equal(result.items.length, 2); assert.equal(decodeUsageCursor(result.nextCursor!)?.id, 'id1');
  assert.ok(!JSON.stringify(qs[0]).includes('cursor-1')); assert.ok(JSON.stringify(qs[1]).includes('cursor-1'));
  assert.equal((qs[1] as { take: number }).take, 3);
});
test('partial video failures remain visible without relabelling the request failed', async () => {
  const row = { ...errorRow(), status: 'SUCCEEDED', capability: 'VIDEO', videoTasks: [{ id: 'v1', lastError: 'HTTP 503 secret prompt', completedAt: end(1000) }] };
  const db = { aiRequest: { count: async () => 1, findMany: async () => [row] } } as unknown as PrismaClient;
  const result = await listAdminUsageErrors(db, { days: 1, limit: 25, kind: 'video' }, now);
  assert.equal(result.items[0]?.status, 'SUCCEEDED'); assert.equal(result.items[0]?.failedOutputCount, 1);
  assert.equal(result.items[0]?.durationMs, null); assert.equal(result.items[0]?.diagnostic?.code, 'PROVIDER_SERVER_ERROR');
  assert.ok(!JSON.stringify(result).includes('secret prompt'));
});
test('invalid pagination/range/snapshot is rejected before database access', async () => {
  const db = {} as PrismaClient;
  for (const input of [
    { days: 31, limit: 25 }, { days: 1, limit: 101 }, { days: 1, limit: 0 },
    { days: 1, limit: 25, cursor: '!!' }, { days: 1, limit: 25, snapshotAt: '2028-01-01T00:00:00Z' },
  ]) await assert.rejects(() => listAdminUsageErrors(db, input, now));
});
test('stored failure summaries are returned without selecting heavy result payloads', async () => {
  let query: { select?: Record<string, unknown> } = {};
  const diagnostic = buildFailureDiagnostic(new Error('fetch failed'), { stage: 'image_generation', resolution: '4k' }, now);
  const db = { aiRequest: {
    count: async () => 1,
    findMany: async (q: unknown) => { query = q as typeof query; return [{ ...errorRow(), failureDiagnostic: diagnostic }]; },
  } } as unknown as PrismaClient;
  const result = await listAdminUsageErrors(db, { days: 1, limit: 25 }, now);
  assert.equal(result.items[0]?.diagnostic?.resolution, '4k');
  assert.ok(query.select?.failureDiagnostic); assert.ok(!query.select?.result); assert.ok(!query.select?.pricingSnapshot);
});


test('partial success uses the current output failure rather than an old request diagnostic', async () => {
  const row = {
    ...errorRow(), status: 'SUCCEEDED', capability: 'VIDEO',
    failureDiagnostic: buildFailureDiagnostic(new Error('timeout'), { stage: 'video_task' }, now),
    videoTasks: [{ id: 'current-output', lastError: 'HTTP 429', completedAt: end(1000) }],
  };
  const db = { aiRequest: { count: async () => 1, findMany: async () => [row] } } as unknown as PrismaClient;
  const result = await listAdminUsageErrors(db, { days: 1, limit: 25, kind: 'video' }, now);
  assert.equal(result.items[0]?.diagnostic?.code, 'PROVIDER_RATE_LIMITED');
});

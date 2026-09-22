import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAdminUsageMetrics, listAdminUsageErrors, UsageDiagnosticsError } from './usage-diagnostics.js';

const days = z.coerce.number().int().min(1).max(30).default(1);
const metricsQuery = z.object({ days }).strict();
const errorsQuery = z.object({
  days,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  kind: z.enum(['all', 'image', 'text', 'video']).default('all'),
  query: z.string().trim().max(128).optional(),
  cursor: z.string().min(1).max(512).optional(),
  snapshotAt: z.string().datetime({ offset: true }).optional(),
}).strict();

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof UsageDiagnosticsError) return reply.code(error.statusCode).send({
    error: error.code,
    message: error.code === 'usage_range_too_large' ? '统计样本过多，请缩短时间范围后重试（未返回截断统计）' : '统计查询参数无效，请刷新后重试',
  });
  throw error;
}

/** Registered under adminRoutes, inheriting its authenticateAdmin preHandler. */
export const usageDiagnosticsRoutes: FastifyPluginAsync = async app => {
  app.get('/usage/metrics', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = metricsQuery.safeParse(request.query);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request', message: '统计查询参数无效' });
    try { return await getAdminUsageMetrics(app.prisma, input.data.days); }
    catch (error) { return handleError(reply, error); }
  });
  app.get('/usage/errors', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = errorsQuery.safeParse(request.query);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request', message: '错误记录查询参数无效' });
    try { return await listAdminUsageErrors(app.prisma, input.data); }
    catch (error) { return handleError(reply, error); }
  });
};

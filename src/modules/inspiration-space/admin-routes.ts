import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  INSPIRATION_SHARE_STATUSES,
  deleteInspirationShare,
  listAdminInspirationShares,
  updateInspirationShareStatus,
} from './service.js';

const idSchema = z.string().uuid();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

export const inspirationSpaceAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const parsed = z.object({
      status: z.enum(INSPIRATION_SHARE_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(request.query);
    if (!parsed.success) return invalid(reply, '灵感空间审核查询无效');
    return listAdminInspirationShares(app.prisma, parsed.data);
  });

  app.patch(
    '/:shareId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z.object({ shareId: idSchema }).safeParse(request.params);
      const body = z.object({ status: z.enum(INSPIRATION_SHARE_STATUSES) }).strict()
        .safeParse(request.body);
      if (!params.success || !body.success) return invalid(reply, '审核操作无效');
      try {
        return await updateInspirationShareStatus(app.prisma, params.data.shareId, body.data.status);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          return reply.code(404).send({ error: 'not_found', message: '分享不存在' });
        }
        throw error;
      }
    },
  );

  app.delete(
    '/:shareId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({ shareId: idSchema }).safeParse(request.params);
      if (!parsed.success) return invalid(reply, '分享 ID 无效');
      const deleted = await deleteInspirationShare(app.prisma, parsed.data.shareId);
      if (!deleted) return reply.code(404).send({ error: 'not_found', message: '分享不存在' });
      return reply.code(204).send();
    },
  );
};

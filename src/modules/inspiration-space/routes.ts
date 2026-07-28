import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  INSPIRATION_SHARE_KINDS,
  createInspirationShare,
  getInspirationPreviewRedirect,
  getInspirationShareDownload,
  getPublishedInspirationShare,
  listPublishedInspirationShares,
} from './service.js';

const idSchema = z.string().uuid();
const listSchema = z.object({
  kind: z.enum(INSPIRATION_SHARE_KINDS).optional(),
  query: z.string().trim().max(100).optional(),
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
const submissionSchema = z.object({
  kind: z.enum(INSPIRATION_SHARE_KINDS),
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1_000).nullable().optional(),
  authorName: z.string().trim().min(2).max(32),
  tags: z.array(z.string().trim().min(1).max(20)).max(8).default([]),
  fileName: z.string().trim().min(1).max(160).regex(/\.json$/i),
  payload: z.unknown(),
  previews: z.array(z.object({
    dataUrl: z.string().max(1_300_000),
    width: z.number().int().min(1).max(8_192),
    height: z.number().int().min(1).max(8_192),
  }).strict()).max(6).default([]),
}).strict();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

function attachmentName(fileName: string) {
  return encodeURIComponent(fileName).replace(/['()*]/g, (value) => (
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export const inspirationSpaceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, '灵感空间查询条件无效');
    return listPublishedInspirationShares(app.prisma, parsed.data);
  });

  app.post(
    '/',
    { config: { rateLimit: { max: 6, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = submissionSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalid(reply, parsed.error.issues[0]?.message ?? '投稿内容无效');
      }
      try {
        const share = await createInspirationShare(app.prisma, {
          ...parsed.data,
          description: parsed.data.description ?? null,
        });
        return reply.code(201).send({
          id: share.id,
          status: share.status,
          message: '投稿已提交，审核通过后会出现在灵感空间',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '投稿处理失败';
        if (/JSON|image|Preview|preset|workflow|预览|图片/i.test(message)) {
          return invalid(reply, message);
        }
        request.log.error({ requestId: request.id }, 'Inspiration space submission failed');
        return reply.code(503).send({
          error: 'inspiration_space_unavailable',
          message: '灵感空间暂时无法接收投稿，请稍后重试',
        });
      }
    },
  );

  app.get('/assets/:assetId', async (request, reply) => {
    const parsed = z.object({ assetId: idSchema }).safeParse(request.params);
    if (!parsed.success) return invalid(reply, '预览图 ID 无效');
    const url = await getInspirationPreviewRedirect(app.prisma, parsed.data.assetId);
    if (!url) return reply.code(404).send({ error: 'not_found', message: '预览图不存在' });
    return reply
      .header('cross-origin-resource-policy', 'cross-origin')
      .redirect(url);
  });

  app.get('/:shareId/download', async (request, reply) => {
    const parsed = z.object({ shareId: idSchema }).safeParse(request.params);
    if (!parsed.success) return invalid(reply, '分享 ID 无效');
    const share = await getInspirationShareDownload(app.prisma, parsed.data.shareId);
    if (!share) return reply.code(404).send({ error: 'not_found', message: '分享不存在' });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${attachmentName(share.fileName)}`)
      .send(`${JSON.stringify(share.jsonPayload, null, 2)}\n`);
  });

  app.get('/:shareId', async (request, reply) => {
    const parsed = z.object({ shareId: idSchema }).safeParse(request.params);
    if (!parsed.success) return invalid(reply, '分享 ID 无效');
    const share = await getPublishedInspirationShare(app.prisma, parsed.data.shareId);
    if (!share) return reply.code(404).send({ error: 'not_found', message: '分享不存在' });
    return share;
  });
};

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CloudAiError, listWalletAgentModels } from './service.js';
import { executeWalletImageGeneration, listWalletImageModels } from './image-service.js';
import { executeWalletVideoGeneration, executeWalletVideoStatus } from './image-service.js';
import { getImageReference } from './reference-store.js';
import { createAiTaskSchema } from './task-schema.js';
import {
  cancelUserAiTask,
  createAiTask,
  findUserAiTask,
  publicTaskStatus,
  serializeAiTask,
} from './task-service.js';

const chatSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  messages: z.array(z.unknown()).min(1).max(200),
  tools: z.array(z.unknown()).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();

const inspirationAnalysisSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128).optional(),
  itemId: z.string().trim().min(1).max(256),
  imageSource: z.string().min(1).max(12_000_000),
  userTags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  userNotes: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  existingProfile: z.unknown().optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();

const taskParamsSchema = z.object({ taskId: z.string().trim().min(1).max(128) }).strict();
const taskRequestParamsSchema = z.object({
  type: z.enum(['agent_chat', 'inspiration_analysis']),
  requestId: z.string().trim().min(8).max(128),
}).strict();

const optionalString = (max: number) => z.string().trim().max(max).nullish()
  .transform((value) => value ?? undefined);

const imageSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  provider: z.enum(['new-api', 'xais-chat', 'openai-compatible', 'custom']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(50_000),
  negativePrompt: optionalString(20_000),
  inputImages: z.array(z.string().min(1).max(12_000_000)).max(8).default([]),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
  resolution: optionalString(20),
  outputFormat: z.enum(['jpg', 'jpeg', 'png', 'webp']).default('jpg'),
  count: z.number().int().min(1).max(4).default(1),
}).strict();

const videoSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  provider: z.enum(['new-api', 'xais-chat']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(50_000),
  inputImages: z.array(z.string().min(1).max(12_000_000)).max(13).default([]),
  aspectRatio: z.string().trim().max(20).default('16:9'),
  resolution: optionalString(20),
  duration: z.number().positive().max(120).nullish().transform((value) => value ?? undefined),
  inputMode: z.enum(['REF', 'FLF']).nullish().transform((value) => value ?? undefined),
  count: z.number().int().min(1).max(4).default(1),
}).strict();

const videoStatusSchema = z.object({
  provider: z.enum(['new-api', 'xais-chat']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  taskId: z.string().trim().min(1).max(256),
  clientRequestId: z.string().trim().min(8).max(128).nullish()
    .transform((value) => value ?? undefined),
}).strict();

const imageModelsQuerySchema = z.object({
  provider: z.enum(['new-api', 'xais-chat', 'openai-compatible', 'custom']).nullish()
    .transform((value) => value ?? undefined),
}).strict();

export const normalizeImageRequestBody = (body: unknown) => imageSchema.parse(body);
export const normalizeVideoRequestBody = (body: unknown) => videoSchema.parse(body);

function knownError(reply: FastifyReply, error: unknown) {
  if (error instanceof CloudAiError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/tasks',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = createAiTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '异步任务请求格式无效' });
      }
      const { task } = await createAiTask(app.prisma, request.user.sub, parsed.data);
      return reply.code(202).send({ taskId: task.id, status: publicTaskStatus(task.status) });
    },
  );

  app.get(
    '/tasks/by-request/:type/:requestId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = taskRequestParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '任务查询参数无效' });
      }
      const task = await app.prisma.aiTask.findFirst({
        where: {
          userId: request.user.sub,
          requestId: parsed.data.requestId,
          type: parsed.data.type === 'agent_chat' ? 'AGENT_CHAT' : 'INSPIRATION_ANALYSIS',
        },
      });
      if (!task) return reply.code(404).send({ error: 'not_found', message: '任务不存在或已过期' });
      return serializeAiTask(task);
    },
  );

  app.get(
    '/tasks/:taskId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = taskParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '任务 ID 无效' });
      }
      const task = await findUserAiTask(app.prisma, request.user.sub, parsed.data.taskId);
      if (!task) return reply.code(404).send({ error: 'not_found', message: '任务不存在或已过期' });
      return serializeAiTask(task);
    },
  );

  app.delete(
    '/tasks/:taskId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = taskParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '任务 ID 无效' });
      }
      const task = await cancelUserAiTask(app.prisma, request.user.sub, parsed.data.taskId);
      if (!task) return reply.code(404).send({ error: 'not_found', message: '任务不存在或已过期' });
      return serializeAiTask(task);
    },
  );

  app.get(
    '/models',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (_request, reply) => {
      try {
        return await listWalletAgentModels(app.prisma);
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

  app.get(
    '/references/:key',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const rawKey = (request.params as { key?: unknown }).key;
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(key)) {
        return reply.code(404).send({ error: 'not_found', message: 'Image reference not found' });
      }
      const reference = getImageReference(key);
      if (!reference) {
        return reply.code(404).send({ error: 'not_found', message: 'Image reference expired' });
      }
      return reply
        .header('content-type', reference.mime)
        .header('content-length', String(reference.bytes.byteLength))
        .header('cache-control', 'public, max-age=900, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(reference.bytes);
    },
  );

  app.get(
    '/images/models',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = imageModelsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '生图模型请求格式无效' });
      }
      try {
        return await listWalletImageModels(app.prisma);
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

  app.post(
    '/inspirations/analyze',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = inspirationAnalysisSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '灵感自动分析请求格式无效' });
      }
      const { clientRequestId, ...payload } = parsed.data;
      const { task } = await createAiTask(app.prisma, request.user.sub, {
        type: 'inspiration_analysis',
        requestId: clientRequestId ?? `inspiration-${request.id}`,
        payload,
      });
      return reply.code(202).send({ taskId: task.id, status: publicTaskStatus(task.status) });
    },
  );

  app.post(
    '/chat/completions',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = chatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Agent 请求格式无效' });
      }
      const { clientRequestId, ...payload } = parsed.data;
      const { task } = await createAiTask(app.prisma, request.user.sub, {
        type: 'agent_chat',
        requestId: clientRequestId,
        payload,
      });
      return reply.code(202).send({ taskId: task.id, status: publicTaskStatus(task.status) });
    },
  );

  app.post(
    '/images/generations',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = imageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '生图请求格式无效' });
      }
      try {
        return await executeWalletImageGeneration(app.prisma, {
          userId: request.user.sub,
          ...parsed.data,
        });
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

  app.post(
    '/videos',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = videoSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: '视频请求格式无效' });
      try {
        return await executeWalletVideoGeneration(app.prisma, { userId: request.user.sub, ...parsed.data });
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

  app.get(
    '/videos/:taskId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const parsed = videoStatusSchema.safeParse({
        ...(request.query as Record<string, unknown>),
        taskId: (request.params as { taskId?: unknown }).taskId,
      });
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: '视频任务 ID 无效' });
      try {
        return await executeWalletVideoStatus(app.prisma, {
          userId: request.user.sub,
          ...parsed.data,
        });
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

};

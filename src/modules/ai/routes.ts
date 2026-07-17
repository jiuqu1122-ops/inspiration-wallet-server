import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CloudAiError, executeWalletAgentChat } from './service.js';
import { executeWalletImageGeneration } from './image-service.js';
import { executeWalletVideoGeneration, executeWalletVideoStatus } from './image-service.js';

const chatSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  messages: z.array(z.unknown()).min(1).max(200),
  tools: z.array(z.unknown()).max(100).optional(),
}).strict();

const optionalString = (max: number) => z.string().trim().max(max).nullish()
  .transform((value) => value ?? undefined);

const imageSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  provider: z.enum(['new-api', 'xais-chat', 'openai-compatible', 'custom']).nullish()
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
  taskId: z.string().trim().min(1).max(256),
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
      try {
        return await executeWalletAgentChat(app.prisma, {
          userId: request.user.sub,
          ...parsed.data,
        });
      } catch (error) {
        return knownError(reply, error);
      }
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
        return await executeWalletVideoStatus(app.prisma, parsed.data);
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );

};

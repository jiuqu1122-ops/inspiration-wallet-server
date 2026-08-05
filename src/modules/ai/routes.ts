import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CloudAiError, listWalletAgentModels } from './service.js';
import {
  executeWalletImageGeneration,
  executeWalletVideoGeneration,
  executeWalletVideoStatus,
  getWalletImageGenerationByRequest,
  listWalletImageModels,
} from './image-service.js';
import { getImageResult } from './image-result-store.js';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { ossUploadService } from './oss-uploader.js';
import { getClientEngineAsset } from './client-assets.js';
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
  provider: z.enum(['new-api', 'xais-chat', 'openai-compatible', 'custom', 'mikoto', 'bigmodel']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(50_000),
  negativePrompt: optionalString(20_000),
  inputImages: z.array(z.string().min(1).max(12_000_000)).max(9).default([]),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
  resolution: optionalString(20),
  outputFormat: z.enum(['jpg', 'jpeg', 'png', 'webp']).default('jpg'),
  background: z.enum(['transparent']).nullish()
    .transform((value) => value ?? undefined),
  count: z.number().int().min(1).max(4).default(1),
}).strict();

const videoSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'bigmodel']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(50_000),
  inputImages: z.array(z.string().min(1).max(12_000_000)).max(13).default([]),
  inputVideos: z.array(z.string().min(1).max(12_000_000)).max(3).default([]),
  inputAudios: z.array(z.string().min(1).max(12_000_000)).max(3).default([]),
  aspectRatio: z.string().trim().max(20).default('16:9'),
  resolution: optionalString(20),
  duration: z.number().positive().max(120).nullish().transform((value) => value ?? undefined),
  inputMode: z.enum(['REF', 'FLF']).nullish().transform((value) => value ?? undefined),
  count: z.number().int().min(1).max(4).default(1),
}).strict();

const videoStatusSchema = z.object({
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'bigmodel']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  taskId: z.string().trim().min(1).max(256),
  clientRequestId: z.string().trim().min(8).max(128).nullish()
    .transform((value) => value ?? undefined),
}).strict();

const imageModelsQuerySchema = z.object({
  provider: z.enum(['new-api', 'xais-chat', 'openai-compatible', 'custom', 'mikoto', 'bigmodel']).nullish()
    .transform((value) => value ?? undefined),
}).strict();

const imageGenerationRequestParamsSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
}).strict();

const imageResultQuerySchema = z.object({
  redirect: z.enum(['0', '1']).optional(),
}).passthrough();

const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BASE64_LENGTH = 16_000_000;
const REFERENCE_IMAGE_TOO_LARGE_RESPONSE = {
  error: 'reference_image_too_large',
  message: '单张参考图不能超过 10 MB',
  maxBytes: MAX_REFERENCE_IMAGE_BYTES,
} as const;

const referenceUploadSchema = z.object({
  images: z.array(z.object({
    filename: z.string().trim().min(1).max(255),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1).max(MAX_REFERENCE_IMAGE_BASE64_LENGTH),
  }).strict()).min(1).max(13),
}).strict();

const referenceShares = new Map<string, string[]>();

async function pruneReferenceCache(directory: string) {
  const expiresBefore = Date.now() - env.IMAGE_RESULT_TTL_MINUTES * 60_000;
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    const path = join(directory, entry);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.mtimeMs < expiresBefore) await unlink(path).catch(() => {});
  }
}

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
    '/client-assets/:asset',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const rawAsset = (request.params as { asset?: unknown }).asset;
      const asset = getClientEngineAsset(typeof rawAsset === 'string' ? rawAsset.trim() : '');
      if (!asset) {
        return reply.code(404).send({ error: 'not_found', message: 'Client asset not found' });
      }
      try {
        if (!await ossUploadService.exists(asset.objectName)) {
          return reply.code(404).send({ error: 'not_found', message: 'Client asset is not available' });
        }
        const url = ossUploadService.getPublicUrl(asset.objectName, { filename: asset.name });
        return reply
          .header('Cache-Control', 'public, max-age=300')
          .redirect(url);
      } catch (error) {
        request.log.error(
          { asset: asset.name, errorName: error instanceof Error ? error.name : 'unknown' },
          'client asset signing failed',
        );
        return reply.code(503).send({
          error: 'oss_signing_failed',
          message: 'Client asset temporary URL could not be created',
        });
      }
    },
  );

  app.get(
    '/image-results/:key',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = imageResultQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Invalid image result query' });
      }
      const rawKey = (request.params as { key?: unknown }).key;
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      const result = await getImageResult(key);
      if (!result) {
        return reply.code(404).send({ error: 'not_found', message: 'Image result not found or expired' });
      }
      let objectName = `generated-images/${key}`;
      try {
        if (!await ossUploadService.exists(objectName)) {
          objectName = await ossUploadService.upload({
            namespace: 'generated-images',
            source: result.path,
            filename: key,
            mime: result.mime,
          });
        }
      } catch (error) {
        request.log.error({ key, errorName: error instanceof Error ? error.name : 'unknown' }, 'temporary OSS image ensure failed');
        return reply.code(503).send({
          error: 'oss_upload_failed',
          message: 'Generated image could not be uploaded to the temporary download bridge',
        });
      }
      try {
        if (!await ossUploadService.exists(objectName)) {
          return reply.code(502).send({
            error: 'oss_object_missing',
            message: 'Generated image was uploaded but could not be verified',
          });
        }
      } catch (error) {
        request.log.error({ key, errorName: error instanceof Error ? error.name : 'unknown' }, 'temporary OSS image verification failed');
        return reply.code(503).send({
          error: 'oss_verification_failed',
          message: 'Generated image upload could not be verified',
        });
      }
      try {
        const url = ossUploadService.getPublicUrl(objectName, {
          mime: result.mime,
          filename: key,
          download: false,
        });
        if (query.data.redirect === '0') {
          return {
            url,
            expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
          };
        }
        return reply.redirect(url);
      } catch (error) {
        request.log.error({ key, errorName: error instanceof Error ? error.name : 'unknown' }, 'temporary OSS image signing failed');
        return reply.code(503).send({
          error: 'oss_signing_failed',
          message: 'Generated image temporary URL could not be created',
        });
      }
    },
  );

  app.get(
    '/video-results/:key',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = imageResultQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Invalid video result query' });
      }
      const rawKey = (request.params as { key?: unknown }).key;
      const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : '';
      if (!/^[a-f0-9]{64}\.(?:mp4|webm|mov)$/.test(key)) {
        return reply.code(404).send({ error: 'not_found', message: 'Video result not found' });
      }
      const objectName = `generated-videos/${key}`;
      try {
        if (!await ossUploadService.exists(objectName)) {
          return reply.code(404).send({ error: 'not_found', message: 'Video result not found or expired' });
        }
        const url = ossUploadService.getPublicUrl(objectName, { filename: key });
        if (query.data.redirect === '0') {
          return { url, expiresAt: Date.now() + 24 * 60 * 60 * 1_000 };
        }
        return reply.redirect(url);
      } catch (error) {
        request.log.error({ key, errorName: error instanceof Error ? error.name : 'unknown' }, 'video result signing failed');
        return reply.code(503).send({
          error: 'oss_signing_failed',
          message: 'Generated video temporary URL could not be created',
        });
      }
    },
  );

  app.post(
    '/reference-images',
    {
      preHandler: app.authenticateAccessToken,
      bodyLimit: 64 * 1024 * 1024,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = referenceUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        const encodedImageTooLarge = parsed.error.issues.some(issue => (
          issue.code === 'too_big'
          && issue.path[0] === 'images'
          && issue.path[issue.path.length - 1] === 'data'
        ));
        if (encodedImageTooLarge) {
          return reply.code(413).send(REFERENCE_IMAGE_TOO_LARGE_RESPONSE);
        }
        return reply.code(400).send({ error: 'invalid_request', message: 'Reference image upload is invalid' });
      }
      const cacheDir = join(env.IMAGE_RESULT_STORE_DIR, 'reference-images');
      await mkdir(cacheDir, { recursive: true });
      void pruneReferenceCache(cacheDir);
      const shareId = randomUUID();
      const names: string[] = [];
      const urls: string[] = [];
      try {
        for (const [index, image] of parsed.data.images.entries()) {
          const bytes = Buffer.from(image.data, 'base64');
          if (bytes.byteLength === 0) {
            throw new Error('reference image is empty');
          }
          if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
            throw new Error('reference image exceeds the size limit');
          }
          const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length);
          const filename = `${shareId}-${index}.${extension}`;
          const localPath = join(cacheDir, filename);
          await writeFile(localPath, bytes, { flag: 'wx' });
          const name = await ossUploadService.upload({
            namespace: 'reference-images',
            filename,
            source: localPath,
            mime: image.mime,
          });
          names.push(name);
          const url = ossUploadService.getPublicUrl(name, { mime: image.mime, filename });
          await ossUploadService.verifyPublicImageUrl(name, url);
          urls.push(url);
        }
        referenceShares.set(shareId, names);
        return { shareId, urls };
      } catch (error) {
        await Promise.all(names.map(name => ossUploadService.delete(name).catch(() => false)));
        if (error instanceof Error && error.message === 'reference image exceeds the size limit') {
          request.log.warn({ err: error }, 'Reference image exceeds the upload size limit');
          return reply.code(413).send(REFERENCE_IMAGE_TOO_LARGE_RESPONSE);
        }
        request.log.error({ err: error }, 'OSS reference image upload failed');
        return reply.code(503).send({ error: 'image_delivery_unavailable', message: 'Reference image upload is temporarily unavailable' });
      }
    },
  );

  app.delete(
    '/reference-images/:shareId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const shareId = String((request.params as { shareId?: unknown }).shareId || '');
      const names = referenceShares.get(shareId) || [];
      referenceShares.delete(shareId);
      await Promise.all(names.map(name => ossUploadService.delete(name).catch(() => false)));
      return reply.code(204).send();
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

  app.get(
    '/images/generations/by-request/:clientRequestId',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = imageGenerationRequestParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: '生图请求 ID 无效' });
      }
      const result = await getWalletImageGenerationByRequest(
        app.prisma,
        request.user.sub,
        parsed.data.clientRequestId,
      );
      if (!result) {
        return reply.code(404).send({ error: 'image_request_not_found', message: '没有找到对应的生图任务' });
      }
      return result;
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

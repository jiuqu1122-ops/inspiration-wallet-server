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
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { getClientEngineAsset } from './client-assets.js';
import { storageService } from '../storage/service.js';
import { getImageReference } from './reference-store.js';
import { isVideoResultKey } from './video-result-store.js';
import { getImageResult, imageResultMimeForKey } from './image-result-store.js';
import { agentToolChoiceSchema, createAiTaskSchema } from './task-schema.js';
import { ensureAiCatalogSeeded } from './catalog-seed.js';
import { getPublicAiCatalog, ModelCatalogError } from './model-catalog.js';
import {
  ReferenceUploadError,
  getReferenceImageContent,
  issueReferenceUploadTicket,
  recordLegacyReferenceUpload,
  referenceUploadInputSchema,
} from './reference-upload-service.js';
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
  toolChoice: agentToolChoiceSchema.optional(),
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

const isSeedance20VideoModel = (model: string) => {
  const token = model.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return token === 'seedance2'
    || token === 'seedance20'
    || token === 'seedance2fast'
    || token === 'seedance20fast'
    || token === 'sourcemix20'
    || token === 'sourcemix20fast';
};

const isMiniMaxH3VideoModel = (model: string) => (
  model.trim().toLowerCase().replace(/[\s_.-]+/g, '') === 'minimaxh3'
);

const imageSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  clientPlatform: z.literal('tablet').optional(),
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'bigmodel', 'uselg', 'openai-compatible', 'custom']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(50_000),
  negativePrompt: optionalString(20_000),
  preserveReferenceIdentity: z.boolean().default(false),
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
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'minimax']).nullish()
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
}).strict().superRefine((value, context) => {
  const isSeedance = isSeedance20VideoModel(value.model);
  const isMinimax = isMiniMaxH3VideoModel(value.model);
  if (!isSeedance && !isMinimax) return;
  const label = isSeedance ? 'Seedance 2.0' : 'MiniMax H3';
  if (value.inputImages.length > 9) {
    context.addIssue({ code: z.ZodIssueCode.too_big, origin: 'array', maximum: 9, inclusive: true, path: ['inputImages'], message: `${label} supports at most 9 reference images` });
  }
  if (value.inputVideos.length > 3) {
    context.addIssue({ code: z.ZodIssueCode.too_big, origin: 'array', maximum: 3, inclusive: true, path: ['inputVideos'], message: `${label} supports at most 3 reference videos` });
  }
  if (value.inputAudios.length > 3) {
    context.addIssue({ code: z.ZodIssueCode.too_big, origin: 'array', maximum: 3, inclusive: true, path: ['inputAudios'], message: `${label} supports at most 3 reference audios` });
  }
});

const videoStatusSchema = z.object({
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'minimax']).nullish()
    .transform((value) => value ?? undefined),
  providerChannelId: z.string().trim().min(1).max(128).nullish()
    .transform((value) => value ?? undefined),
  taskId: z.string().trim().min(1).max(256),
  clientRequestId: z.string().trim().min(8).max(128).nullish()
    .transform((value) => value ?? undefined),
}).strict();

const imageModelsQuerySchema = z.object({
  provider: z.enum(['new-api', 'xais-chat', 'mikoto', 'bigmodel', 'uselg', 'openai-compatible', 'custom']).nullish()
    .transform((value) => value ?? undefined),
}).strict();

const imageGenerationRequestParamsSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
}).strict();

const imageResultQuerySchema = z.object({
  redirect: z.enum(['0', '1']).optional(),
}).passthrough();

const referenceUploadSchema = z.object({
  images: z.array(z.object({
    filename: z.string().trim().min(1).max(255),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1).max(16_000_000),
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
  if (error instanceof ModelCatalogError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  if (error instanceof CloudAiError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  if (error instanceof ReferenceUploadError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/catalog',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (_request, reply) => {
      try {
        await ensureAiCatalogSeeded(app.prisma);
        return await getPublicAiCatalog(app.prisma);
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );
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
        if (!await storageService.exists(asset.objectName)) {
          return reply.code(404).send({ error: 'not_found', message: 'Client asset is not available' });
        }
        const url = storageService.getDownloadUrl(asset.objectName);
        return reply
          .header('Cache-Control', 'public, max-age=300')
          .header('X-Asset-SHA256', asset.sha256)
          .header('X-Asset-Size', String(asset.size))
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
      const resultMime = result?.mime || imageResultMimeForKey(key);
      if (!resultMime) {
        return reply.code(404).send({ error: 'not_found', message: 'Image result not found or expired' });
      }
      let objectName = `generated-images/${key}`;
      try {
        if (!await storageService.exists(objectName)) {
          if (!result) {
            return reply.code(404).send({ error: 'not_found', message: 'Image result not found or expired' });
          }
          objectName = await storageService.uploadMedia({
            namespace: 'generated-images',
            source: result.path,
            filename: key,
            mime: resultMime,
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
        if (!await storageService.exists(objectName)) {
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
        const url = storageService.getDownloadUrl(objectName);
        if (query.data.redirect === '0') {
          return {
            url,
            expiresAt: Date.now() + env.STORAGE_SIGNED_URL_EXPIRES_SECONDS * 1_000,
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
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = imageResultQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Invalid video result query' });
      }
      const rawKey = (request.params as { key?: unknown }).key;
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!isVideoResultKey(key)) {
        return reply.code(404).send({ error: 'not_found', message: 'Video result not found or expired' });
      }
      const objectName = `generated-videos/${key}`;
      try {
        if (!await storageService.exists(objectName)) {
          return reply.code(404).send({ error: 'not_found', message: 'Video result not found or expired' });
        }
        const url = storageService.getDownloadUrl(objectName);
        if (query.data.redirect === '0') {
          return { url, expiresAt: Date.now() + env.STORAGE_SIGNED_URL_EXPIRES_SECONDS * 1_000 };
        }
        return reply.redirect(url);
      } catch (error) {
        request.log.error({ key, errorName: error instanceof Error ? error.name : 'unknown' }, 'video OSS result signing failed');
        return reply.code(503).send({
          error: 'oss_signing_failed',
          message: 'Generated video temporary URL could not be created',
        });
      }
    },
  );

  app.post(
    '/reference-images/upload-ticket',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = referenceUploadInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Reference image upload ticket is invalid' });
      }
      try {
        return await issueReferenceUploadTicket(app.prisma, request.user.sub, parsed.data);
      } catch (error) {
        if (error instanceof ReferenceUploadError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        request.log.error({ err: error }, 'reference image upload ticket failed');
        return reply.code(503).send({ error: 'image_delivery_unavailable', message: 'Reference image upload is temporarily unavailable' });
      }
    },
  );

  app.get(
    '/reference-images/content/:filename',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const rawFilename = (request.params as { filename?: unknown }).filename;
      const filename = typeof rawFilename === 'string' ? rawFilename.trim() : '';
      try {
        const image = await getReferenceImageContent(app.prisma, filename);
        return reply
          .header('content-type', image.contentType)
          .header('content-length', String(image.contentLength))
          .header('cache-control', 'public, max-age=120, immutable')
          .header('cross-origin-resource-policy', 'cross-origin')
          .header('x-content-type-options', 'nosniff')
          .send(image.response.stream);
      } catch (error) {
        if (error instanceof ReferenceUploadError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        request.log.error({ err: error }, 'reference image proxy failed');
        return reply.code(503).send({
          error: 'image_delivery_unavailable',
          message: 'Reference image is temporarily unavailable',
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
          if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) {
            throw new Error('reference image exceeds the size limit');
          }
          const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length);
          const filename = `${shareId}-${index}.${extension}`;
          const localPath = join(cacheDir, filename);
          await writeFile(localPath, bytes, { flag: 'wx' });
          const name = await storageService.uploadMedia({
            namespace: 'reference-images',
            filename,
            source: localPath,
            mime: image.mime,
          });
          names.push(name);
          const url = storageService.getDownloadUrl(name);
          await storageService.verifyImageUrl(name, url);
          const referenceUploadDelegate = (app.prisma as typeof app.prisma & { referenceUpload?: unknown }).referenceUpload;
          if (referenceUploadDelegate) {
            await recordLegacyReferenceUpload(app.prisma, request.user.sub, name, image.mime, bytes.byteLength);
          }
          urls.push(url);
        }
        referenceShares.set(shareId, names);
        return { shareId, urls };
      } catch (error) {
        await Promise.all(names.map(name => storageService.delete(name).catch(() => false)));
        request.log.error({ err: error }, 'OSS reference image upload failed');
        return reply.code(503).send({ error: 'image_delivery_unavailable', message: 'Reference image upload is temporarily unavailable' });
      }
    },
  );

  app.delete(
    '/reference-images/:shareId',
    { preHandler: app.authenticateAccessToken },
    async (request, reply) => {
      const rawShareId = (request.params as { shareId?: unknown }).shareId;
      const shareId = typeof rawShareId === 'string' ? rawShareId : '';
      const names = referenceShares.get(shareId) || [];
      referenceShares.delete(shareId);
      await Promise.all(names.map(name => storageService.delete(name).catch(() => false)));
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

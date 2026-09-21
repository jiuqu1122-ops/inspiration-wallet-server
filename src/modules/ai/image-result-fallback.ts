import { createReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { storageService } from '../storage/service.js';
import { getImageResult, imageResultMimeForKey } from './image-result-store.js';
import {
  createImageResultFallbackStore,
  ImageDeliveryError,
  IMAGE_RESULT_KEY_PATTERN,
} from './image-result-fallback-core.js';

export const imageResultFallbackStore = createImageResultFallbackStore({
  directory: env.IMAGE_RESULT_STORE_DIR,
  appBaseUrl: env.APP_BASE_URL,
  ttlMs: env.IMAGE_RESULT_TTL_MINUTES * 60_000,
  encryptionKey: () => Buffer.from(env.PROVIDER_SECRETS_ENCRYPTION_KEY || '', 'base64'),
  assertPublicUrl: assertPublicProviderUrl,
});

export function safeImageDeliveryError(error: unknown) {
  const candidate = error as { name?: unknown; code?: unknown; cause?: { code?: unknown }; maximumBytes?: unknown; downloadedBytes?: unknown; declaredLength?: unknown } | undefined;
  const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    maximumBytes: finite(candidate?.maximumBytes),
    downloadedBytes: finite(candidate?.downloadedBytes),
    declaredLength: finite(candidate?.declaredLength),
    errorName: safe(candidate?.name) || 'Error',
    errorCode: safe(candidate?.code),
    causeCode: safe(candidate?.cause?.code),
  };
}

function temporaryUrl(key: string, reply: FastifyReply) {
  return reply.header('Cache-Control', 'private, no-store').send({
    // Preserve redirect=0's JSON contract without returning the upstream URL.
    // GET of this URL sends bytes, not another redirect=0 response.
    url: imageResultFallbackStore.resultUrl(key),
    expiresAt: Date.now() + Math.min(env.IMAGE_RESULT_TTL_MINUTES * 60, 300) * 1_000,
  });
}

async function boundedStorageLookup<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ImageDeliveryError('IMAGE_STORAGE_LOOKUP_TIMEOUT')), 5_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Same URL and response shape as existing clients. Only COS URLs may be
 * redirected; upstream fallback URLs are always proxied as image bytes. */
export async function serveImageResultWithFallback(
  key: string,
  redirect: '0' | '1' | undefined,
  reply: FastifyReply,
) {
  if (!IMAGE_RESULT_KEY_PATTERN.test(key)) {
    return reply.code(404).send({ error: 'not_found', message: 'Image result not found' });
  }
  const objectName = `generated-images/${key}`;
  // Do not require a successful COS write simply to read an already generated
  // image. A read must not start another generation or repeatedly upload it.
  try {
    if (await boundedStorageLookup(storageService.exists(objectName))) {
      const url = storageService.getDownloadUrl(objectName);
      if (redirect === '0') return reply.header('Cache-Control', 'private, no-store').send({
        url, expiresAt: Date.now() + env.STORAGE_SIGNED_URL_EXPIRES_SECONDS * 1_000,
      });
      return reply.header('Cache-Control', 'private, no-store').redirect(url);
    }
  } catch (error) {
    console.warn('[image_result_storage_read_fallback]', { key, ...safeImageDeliveryError(error) });
  }

  try {
    const local = await getImageResult(key);
    if (local) {
      if (redirect === '0') return temporaryUrl(key, reply);
      const stream = createReadStream(local.path);
      if (reply.raw.destroyed) { stream.destroy(); return reply; }
      reply.raw.once('close', () => stream.destroy());
      return reply
        .header('Content-Type', local.mime)
        .header('Content-Length', String(local.size))
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .send(stream);
    }
  } catch (error) {
    console.warn('[image_result_local_read_fallback]', { key, ...safeImageDeliveryError(error) });
  }

  try {
    const receipt = await imageResultFallbackStore.getReceipt(key);
    if (!receipt) return reply.code(410).send({
      error: 'image_result_unavailable',
      message: '图片已生成，但临时结果不存在或已过期，请联系平台恢复结果。',
    });
    if (redirect === '0') return temporaryUrl(key, reply);
    const image = await imageResultFallbackStore.openSource(receipt.source);
    if (reply.raw.destroyed) { image.body.destroy(); image.close(); return reply; }
    reply.raw.once('close', () => { image.body.destroy(); image.close(); });
    reply.header('Content-Type', image.mime || imageResultMimeForKey(key) || 'application/octet-stream')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    if (image.contentLength !== undefined) reply.header('Content-Length', String(image.contentLength));
    return reply.send(image.body);
  } catch (error) {
    console.warn('[image_result_upstream_fallback_failed]', { key, ...safeImageDeliveryError(error) });
    const status = error instanceof ImageDeliveryError ? error.statusCode : 503;
    if (status === 429) reply.header('Retry-After', '3');
    return reply.code(status).send({
      error: error instanceof ImageDeliveryError ? error.code : 'image_download_temporarily_unavailable',
      message: status === 410
        ? '图片已生成，但临时下载地址已过期或不可访问，请联系平台恢复结果。'
        : '图片已生成，下载暂时不可用，请稍后重试。',
    });
  }
}

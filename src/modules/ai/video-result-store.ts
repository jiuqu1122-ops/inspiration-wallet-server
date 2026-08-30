import { createHash, randomBytes } from 'node:crypto';
import { open, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { storageService } from '../storage/service.js';

const VIDEO_RESULT_KEY_PATTERN = /^[a-f0-9]{64}\.(?:mp4|webm|mov|m4v|avi)$/;
const MAX_VIDEO_RESULT_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_RESULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const VIDEO_RESULT_MIRROR_CACHE_TTL_MS = 30 * 60_000;
const VIDEO_RESULT_MIRROR_CACHE_MAX_ENTRIES = 128;
const completedVideoMirrors = new Map<string, { url: string; expiresAt: number }>();
const pendingVideoMirrors = new Map<string, Promise<string>>();

function videoResultUrl(key: string) {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/video-results/${key}`;
}

export function isStoredVideoResultUrl(value: string) {
  const prefix = `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/video-results/`;
  return value.startsWith(prefix) && VIDEO_RESULT_KEY_PATTERN.test(value.slice(prefix.length));
}

export function isVideoResultKey(value: string) {
  return VIDEO_RESULT_KEY_PATTERN.test(value);
}

function videoTypeFromPrefix(prefix: Buffer) {
  if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = prefix.subarray(8, 12).toString('ascii').toLowerCase();
    return brand.startsWith('qt')
      ? { mime: 'video/quicktime', extension: 'mov' }
      : { mime: 'video/mp4', extension: 'mp4' };
  }
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { mime: 'video/webm', extension: 'webm' };
  }
  if (prefix.length >= 12
    && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'AVI ') {
    return { mime: 'video/x-msvideo', extension: 'avi' };
  }
  return null;
}

function videoTypeFromMime(mime: string) {
  const normalized = mime.split(';')[0]?.trim().toLowerCase() || '';
  if (normalized === 'video/webm') return { mime: normalized, extension: 'webm' };
  if (normalized === 'video/quicktime') return { mime: normalized, extension: 'mov' };
  if (normalized === 'video/x-m4v') return { mime: normalized, extension: 'm4v' };
  if (normalized === 'video/x-msvideo') return { mime: normalized, extension: 'avi' };
  if (normalized.startsWith('video/')) return { mime: normalized, extension: 'mp4' };
  return null;
}

async function writeVideoResponseToFile(response: Response, path: string) {
  if (!response.body) throw new Error('generated video response has no body');
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_RESULT_BYTES) {
    throw new Error('generated video is too large');
  }
  const file = await open(path, 'w');
  const reader = response.body.getReader();
  const prefixChunks: Buffer[] = [];
  let prefixLength = 0;
  let total = 0;
  let streamError: unknown = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_RESULT_BYTES) {
        await reader.cancel();
        throw new Error('generated video is too large');
      }
      if (prefixLength < 32) {
        const prefix = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, 32 - prefixLength));
        prefixChunks.push(Buffer.from(prefix));
        prefixLength += prefix.byteLength;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('generated video temporary file write failed');
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    streamError = error;
  } finally {
    await file.close();
  }
  if (streamError) {
    throw streamError instanceof Error
      ? streamError
      : new Error(typeof streamError === 'string' ? streamError : 'generated video stream failed');
  }
  if (!total) throw new Error('generated video response returned no bytes');
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase() || '';
  if (Number.isFinite(declaredLength)
    && declaredLength > 0
    && (!contentEncoding || contentEncoding === 'identity')
    && total !== declaredLength) {
    throw new Error(`generated video content-length mismatch: expected ${declaredLength}, received ${total}`);
  }
  const detected = videoTypeFromPrefix(Buffer.concat(prefixChunks));
  const declared = videoTypeFromMime(response.headers.get('content-type') || '');
  const type = detected || declared;
  if (!type) throw new Error('generated video response did not contain valid video bytes');
  return { ...type, size: total };
}

async function stagePublicVideo(source: string, requestHeaders?: HeadersInit) {
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-video-result-'));
  const path = join(directory, 'result.bin');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIDEO_RESULT_DOWNLOAD_TIMEOUT_MS);
  try {
    let current = new URL(source);
    const authenticatedOrigin = requestHeaders ? current.origin : null;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      await assertPublicProviderUrl(current.toString());
      const headers = new Headers(current.origin === authenticatedOrigin ? requestHeaders : undefined);
      headers.set('accept', 'video/mp4,video/webm,video/quicktime,video/*;q=0.9,*/*;q=0.1');
      const response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount >= 3) throw new Error('generated video redirect is invalid');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`generated video HTTP ${response.status}`);
      const staged = await writeVideoResponseToFile(response, path);
      const fileSize = (await stat(path)).size;
      if (fileSize !== staged.size) throw new Error('generated video temporary file size mismatch');
      return {
        path,
        ...staged,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    }
    throw new Error('generated video redirect limit exceeded');
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function stageInlineVideo(source: string) {
  const match = source.trim().match(/^data:(video\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('generated video is not a supported data URL');
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (!bytes.length || bytes.byteLength > MAX_VIDEO_RESULT_BYTES) throw new Error('generated video size is invalid');
  const detected = videoTypeFromPrefix(bytes.subarray(0, 32));
  const declared = videoTypeFromMime(match[1]!);
  const type = detected || declared;
  if (!type) throw new Error('generated video data URL did not contain valid video bytes');
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-video-result-'));
  const path = join(directory, `result.${type.extension}`);
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return {
      path,
      ...type,
      size: bytes.byteLength,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function performGeneratedVideoResultMirror(source: string, requestHeaders?: HeadersInit) {
  const trimmed = source.trim();
  if (isStoredVideoResultUrl(trimmed)) {
    const key = new URL(trimmed).pathname.split('/').filter(Boolean).pop();
    if (!key || !isVideoResultKey(key) || !await storageService.exists(`generated-videos/${key}`)) {
      throw new Error('stored generated video is missing from object storage');
    }
    storageService.getDownloadUrl(`generated-videos/${key}`);
    return trimmed;
  }
  const staged = /^data:video\//i.test(trimmed)
    ? await stageInlineVideo(trimmed)
    : await stagePublicVideo(trimmed, requestHeaders);
  try {
    const key = `${randomBytes(32).toString('hex')}.${staged.extension}`;
    const objectName = await storageService.uploadMedia({
      namespace: 'generated-videos',
      filename: key,
      source: staged.path,
      mime: staged.mime,
    });
    if (!await storageService.exists(objectName)) {
      throw new Error('generated video mirror object is missing after upload');
    }
    storageService.getDownloadUrl(objectName);
    return videoResultUrl(key);
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

export async function mirrorGeneratedVideoResultToStorage(
  source: string,
  requestHeaders?: HeadersInit,
  cacheScope?: string,
) {
  const trimmed = source.trim();
  if (isStoredVideoResultUrl(trimmed)) return performGeneratedVideoResultMirror(trimmed, requestHeaders);
  const normalizedHeaders = requestHeaders
    ? Array.from(new Headers(requestHeaders).entries()).sort(([left], [right]) => left.localeCompare(right))
    : [];
  // Some video providers return a shared download endpoint whose response is
  // bound to the generation task. Keep those task responses from sharing a
  // cached mirror even when the upstream URL text is identical.
  const normalizedScope = cacheScope?.trim() || '';
  const cacheKey = createHash('sha256')
    .update(trimmed)
    .update(JSON.stringify(normalizedHeaders))
    .update(normalizedScope)
    .digest('hex');
  const cached = completedVideoMirrors.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  if (cached) completedVideoMirrors.delete(cacheKey);
  const pending = pendingVideoMirrors.get(cacheKey);
  if (pending) return pending;
  const mirror = performGeneratedVideoResultMirror(trimmed, requestHeaders)
    .then((url) => {
      completedVideoMirrors.set(cacheKey, {
        url,
        expiresAt: Date.now() + VIDEO_RESULT_MIRROR_CACHE_TTL_MS,
      });
      while (completedVideoMirrors.size > VIDEO_RESULT_MIRROR_CACHE_MAX_ENTRIES) {
        const oldest = completedVideoMirrors.keys().next().value;
        if (!oldest) break;
        completedVideoMirrors.delete(oldest);
      }
      return url;
    })
    .finally(() => pendingVideoMirrors.delete(cacheKey));
  pendingVideoMirrors.set(cacheKey, mirror);
  return mirror;
}

/** Compatibility export retained for external callers during the provider migration. */
export const mirrorGeneratedVideoResultToOss = mirrorGeneratedVideoResultToStorage;

import { randomBytes } from 'node:crypto';
import { copyFile, open, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env.js';

const RESULT_KEY_PATTERN = /^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|avif)$/;
const MAX_SINGLE_IMAGE_BYTES = 64 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60_000;
let lastPrunedAt = 0;
let pendingPrune: Promise<void> | null = null;

function extensionForMime(mime: string) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/avif') return 'avif';
  return 'jpg';
}

function mimeForExtension(extension: string) {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'avif') return 'image/avif';
  return 'image/jpeg';
}

export function isImageResultKey(value: string) {
  return RESULT_KEY_PATTERN.test(value);
}

export function imageResultMimeForKey(value: string) {
  if (!isImageResultKey(value)) return null;
  return mimeForExtension(value.split('.').pop()?.toLowerCase() || 'jpg');
}

function imageMimeFromPrefix(prefix: Buffer) {
  if (prefix.length >= 8
    && prefix[0] === 0x89 && prefix[1] === 0x50 && prefix[2] === 0x4e && prefix[3] === 0x47) return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 12
    && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (prefix.length >= 6 && /^GIF8[79]a$/.test(prefix.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (prefix.length >= 12 && prefix.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  return '';
}

function imageResultUrl(key: string) {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/image-results/${key}`;
}

export function isStoredImageResultUrl(value: string) {
  const prefix = `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/image-results/`;
  return value.startsWith(prefix) && RESULT_KEY_PATTERN.test(value.slice(prefix.length));
}

async function pruneImageResults(force = false) {
  const now = Date.now();
  if (!force && now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  if (pendingPrune) return pendingPrune;
  pendingPrune = (async () => {
    await mkdir(env.IMAGE_RESULT_STORE_DIR, { recursive: true });
    const entries = await readdir(env.IMAGE_RESULT_STORE_DIR, { withFileTypes: true });
    const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !RESULT_KEY_PATTERN.test(entry.name)) continue;
      const path = join(env.IMAGE_RESULT_STORE_DIR, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.mtimeMs + env.IMAGE_RESULT_TTL_MINUTES * 60_000 <= now) {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      files.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const maximum = env.IMAGE_RESULT_STORE_MAX_MB * 1024 * 1024;
    for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= maximum) break;
      await rm(join(env.IMAGE_RESULT_STORE_DIR, file.name), { force: true }).catch(() => {});
      total -= file.size;
    }
    lastPrunedAt = now;
  })().finally(() => {
    pendingPrune = null;
  });
  return pendingPrune;
}

export async function createImageResultFromResponse(response: Response) {
  if (!response.body) throw new Error('generated image response has no body');
  await mkdir(env.IMAGE_RESULT_STORE_DIR, { recursive: true });
  await pruneImageResults();

  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SINGLE_IMAGE_BYTES) {
    throw new Error('generated image is too large');
  }

  const temporaryName = `.pending-${randomBytes(32).toString('hex')}`;
  const temporaryPath = join(env.IMAGE_RESULT_STORE_DIR, temporaryName);
  const file = await open(temporaryPath, 'w');
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
      if (total > MAX_SINGLE_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('generated image is too large');
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
        if (bytesWritten <= 0) throw new Error('generated image temporary file write failed');
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
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw streamError instanceof Error
      ? streamError
      : new Error(typeof streamError === 'string' ? streamError : 'generated image stream failed');
  }

  try {
    if (!total) throw new Error('generated image response returned no bytes');
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase() || '';
    if (Number.isFinite(declaredLength)
      && declaredLength > 0
      && (!contentEncoding || contentEncoding === 'identity')
      && total !== declaredLength) {
      throw new Error(`generated image content-length mismatch: expected ${declaredLength}, received ${total}`);
    }
    const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
    const detectedMime = imageMimeFromPrefix(Buffer.concat(prefixChunks));
    const mime = detectedMime || (headerMime.startsWith('image/') ? headerMime : '');
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) {
      throw new Error('generated image response did not contain valid image bytes');
    }
    const key = `${randomBytes(32).toString('hex')}.${extensionForMime(mime)}`;
    await rename(temporaryPath, join(env.IMAGE_RESULT_STORE_DIR, key));
    void pruneImageResults(true).catch(() => {});
    return imageResultUrl(key);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createImageResultFromFile(sourcePath: string, mime: string) {
  await mkdir(env.IMAGE_RESULT_STORE_DIR, { recursive: true });
  await pruneImageResults();
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size <= 0) throw new Error('generated image temporary file is empty');
  if (source.size > MAX_SINGLE_IMAGE_BYTES) throw new Error('generated image is too large');
  const key = `${randomBytes(32).toString('hex')}.${extensionForMime(mime)}`;
  const destination = join(env.IMAGE_RESULT_STORE_DIR, key);
  const temporaryPath = `${destination}.pending`;
  try {
    await copyFile(sourcePath, temporaryPath);
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  void pruneImageResults(true).catch(() => {});
  return imageResultUrl(key);
}

export async function getImageResult(key: string) {
  if (!isImageResultKey(key)) return null;
  const path = join(env.IMAGE_RESULT_STORE_DIR, key);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.mtimeMs + env.IMAGE_RESULT_TTL_MINUTES * 60_000 <= Date.now()) {
    await rm(path, { force: true }).catch(() => {});
    return null;
  }
  const extension = key.split('.').pop()?.toLowerCase() || 'jpg';
  return { path, mime: mimeForExtension(extension), size: info.size };
}

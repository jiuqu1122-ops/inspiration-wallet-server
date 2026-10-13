import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { ReferenceUploadError } from './reference-upload-service.js';

// API and worker mount the same IMAGE_RESULT_STORE_DIR. In-memory references
// cannot be served by the API when they were created by the worker.
export const PROVIDER_REFERENCE_TTL_MS = 30 * 60_000;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/;
const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
const storeDir = () => join(env.IMAGE_RESULT_STORE_DIR, 'provider-references');

export function providerReferenceKey(source: string) {
  const prefix = `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/provider-references/`;
  const key = source.startsWith(prefix) ? source.slice(prefix.length) : '';
  return KEY_PATTERN.test(key) ? key : null;
}

export async function getProviderReference(key: string, now = Date.now()) {
  if (!KEY_PATTERN.test(key)) return null;
  const path = join(storeDir(), key);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.mtimeMs + PROVIDER_REFERENCE_TTL_MS <= now) {
    await unlink(path).catch(() => {});
    return null;
  }
  const extension = key.split('.').at(-1);
  const mime = Object.entries(mimeExtensions).find(([, value]) => value === extension)![0];
  return { path, mime, size: info.size };
}

export async function removeProviderReference(source: string) {
  const key = providerReferenceKey(source);
  if (key) await unlink(join(storeDir(), key)).catch(() => {});
}

export async function createProviderReference(bytes: Buffer, mime: string) {
  const extension = mimeExtensions[mime as keyof typeof mimeExtensions];
  if (!extension) throw new ReferenceUploadError('Unsupported reference image format');
  await mkdir(storeDir(), { recursive: true });
  let usedBytes = 0;
  for (const entry of await readdir(storeDir(), { withFileTypes: true })) {
    if (!entry.isFile() || !KEY_PATTERN.test(entry.name)) continue;
    const reference = await getProviderReference(entry.name);
    if (reference) usedBytes += reference.size;
  }
  // Do not evict references that an accepted task may still be reading.
  if (usedBytes + bytes.length > MAX_STORE_BYTES) {
    throw new ReferenceUploadError('Temporary reference storage is full', 'reference_storage_full', 503);
  }
  const key = `${randomBytes(32).toString('hex')}.${extension}`;
  await writeFile(join(storeDir(), key), bytes, { flag: 'wx', mode: 0o600 });
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/provider-references/${key}`;
}

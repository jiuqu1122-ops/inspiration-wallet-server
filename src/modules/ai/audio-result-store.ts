import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { storageService } from '../storage/service.js';

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' } as const;
type AudioExtension = keyof typeof AUDIO_TYPES;
const KEY_PATTERN = /^[a-f0-9]{64}\.(?:mp3|wav|ogg|m4a|aac|flac|opus)$/;
const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 4 * 60_000;
const pendingMirrors = new Map<string, Promise<StoredAudioAsset>>();

export type StoredAudioAsset = { assetType: 'audio'; url: string; objectKey: string; mime: string; size: number; name: string };
export const createAudioStorageToken = () => randomBytes(32).toString('hex');
export const isAudioResultKey = (key: string) => KEY_PATTERN.test(key);

export function assertAudioResultStorageConfigured() {
  if (!storageService.configured) throw new Error('Audio object storage is not configured');
}

function storedAsset(key: string, extension: AudioExtension, size: number): StoredAudioAsset {
  return {
    assetType: 'audio', objectKey: `generated-audios/${key}`, mime: AUDIO_TYPES[extension], size,
    url: `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/audio-results/${key}`,
    name: `music.${extension}`,
  };
}

function detectAudioType(prefix: Buffer, contentType: string): AudioExtension | null {
  if (prefix.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (prefix.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (prefix.subarray(0, 4).toString('ascii') === 'OggS') return prefix.includes(Buffer.from('OpusHead')) ? 'opus' : 'ogg';
  if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  if (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0) {
    return (prefix[1]! & 0xf6) === 0xf0 ? 'aac' : 'mp3';
  }
  // Never accept an HTML/JSON error page merely because it claims an audio MIME.
  if (/^\s*(?:<|\{|\[)/.test(prefix.toString('utf8'))) return null;
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'wav';
  if (mime === 'audio/x-flac') return 'flac';
  if (mime === 'audio/mp3') return 'mp3';
  return (Object.entries(AUDIO_TYPES).find(([, value]) => value === mime)?.[0] as AudioExtension | undefined) || null;
}

async function stageAudio(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'inspiration-audio-result-'));
  const path = join(directory, 'audio.bin');
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    let current = new URL(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (current.protocol !== 'https:' || current.username || current.password) throw new Error('Audio result URL must use public HTTPS without credentials');
      await assertPublicProviderUrl(current.toString());
      const response = await fetch(current, { redirect: 'manual', signal, headers: { accept: 'audio/*,application/octet-stream;q=0.5' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects >= 3) throw new Error('Audio redirect limit exceeded');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Audio result download failed');
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_BYTES) { await response.body.cancel(); throw new Error('Audio result is too large'); }
      const file = await open(path, 'wx');
      const reader = response.body.getReader();
      let size = 0;
      let prefix = Buffer.alloc(0);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error('Audio result is too large');
          if (prefix.length < 128) prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 128 - prefix.length)]);
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
            if (!bytesWritten) throw new Error('Audio temporary file write failed');
            offset += bytesWritten;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await file.close();
      }
      if (!size) throw new Error('Audio result is empty');
      const encoding = response.headers.get('content-encoding');
      if (declared > 0 && (!encoding || encoding === 'identity') && size !== declared) throw new Error('Audio content length mismatch');
      const extension = detectAudioType(prefix, response.headers.get('content-type') || '');
      if (!extension) throw new Error('Audio result format is unsupported');
      return { path, extension, size, cleanup: () => rm(directory, { recursive: true, force: true }) };
    }
    throw new Error('Audio redirect limit exceeded');
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function performMirror(source: string, token: string) {
  assertAudioResultStorageConfigured();
  // Recover an upload whose DB acknowledgement was lost, even if the vendor URL expired.
  for (const extension of Object.keys(AUDIO_TYPES) as AudioExtension[]) {
    const key = `${token}.${extension}`;
    const head = await storageService.headObject(`generated-audios/${key}`);
    if (head && head.contentLength && head.contentLength > 0) return storedAsset(key, extension, head.contentLength);
  }
  const staged = await stageAudio(source);
  try {
    const key = `${token}.${staged.extension}`;
    const asset = storedAsset(key, staged.extension, staged.size);
    await storageService.uploadMedia({ namespace: 'generated-audios', filename: key, source: staged.path, mime: asset.mime });
    if (!await storageService.exists(asset.objectKey)) throw new Error('Audio object is missing after upload');
    return asset;
  } finally {
    await staged.cleanup().catch(() => {});
  }
}

export function mirrorGeneratedAudioResultToStorage(source: string, token = createAudioStorageToken()) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid audio storage token');
  const pending = pendingMirrors.get(token);
  if (pending) return pending;
  const promise = performMirror(source, token).finally(() => pendingMirrors.delete(token));
  pendingMirrors.set(token, promise);
  return promise;
}

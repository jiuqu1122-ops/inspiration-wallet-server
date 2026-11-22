import { createHash } from 'node:crypto';
import { ReferenceUploadError } from './reference-upload-service.js';

type PartialAsset = { target: string; etag: string; bytes: Buffer; filled: number };
type Parked = { asset: PartialAsset; timer: NodeJS.Timeout };

// Only interrupted downloads occupy this cache between GETs or worker passes.
// A worker restart or eviction falls back to a full GET of the same asset.
const parked = new Map<string, Parked>();
const maxParkedBytes = 40 * 1024 * 1024;
const maxParkedAssets = 32;
let parkedBytes = 0;

function take(key: string) {
  const entry = parked.get(key);
  if (!entry) return;
  parked.delete(key);
  clearTimeout(entry.timer);
  parkedBytes -= entry.asset.bytes.length;
  return entry.asset;
}

export class ArkResultRange {
  private readonly key?: string;
  private asset: PartialAsset | undefined;
  resumedFrom = 0;

  constructor(source: string, private readonly checkpoint?: { requestId: string; expiresAt: number }) {
    if (checkpoint) {
      this.key = createHash('sha256').update(JSON.stringify([checkpoint.requestId, source])).digest('hex');
      this.asset = take(this.key);
    }
  }

  park() {
    const asset = this.asset;
    const key = this.key;
    if (!this.checkpoint || !key) return;
    const ttl = this.checkpoint.expiresAt - Date.now();
    if (!asset || !asset.filled || asset.filled >= asset.bytes.length || ttl <= 0) return;
    take(key);
    while (parked.size >= maxParkedAssets || parkedBytes + asset.bytes.length > maxParkedBytes) {
      const oldest = parked.keys().next().value;
      if (oldest === undefined) return;
      take(oldest);
    }
    const timer = setTimeout(() => take(key), ttl).unref();
    parked.set(key, { asset, timer });
    parkedBytes += asset.bytes.length;
    this.asset = undefined;
  }

  headers(target: string): Record<string, string> {
    const asset = this.asset;
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (asset && asset.target === target && asset.filled > 0) {
      headers.range = 'bytes=' + asset.filled + '-';
      headers['if-range'] = asset.etag;
    }
    return headers;
  }

  invalidRange() {
    this.asset = undefined;
    return new ReferenceUploadError('Ark result byte range was incomplete or changed', 'ark_result_incomplete', 502);
  }

  async read(response: Response, target: string, maximumBytes: number, signal: AbortSignal, onBytes: (size: number) => void) {
    signal.throwIfAborted();
    const etag = response.headers.get('etag') ?? '';
    const length = Number(response.headers.get('content-length'));
    const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
    let asset = this.asset;
    if (response.status === 206) {
      if (!asset || !asset.filled || target !== asset.target || etag !== asset.etag || encoding !== 'identity'
        || response.headers.get('content-range') !== `bytes ${asset.filled}-${asset.bytes.length - 1}/${asset.bytes.length}`
        || (response.headers.has('content-length') && length !== asset.bytes.length - asset.filled)) {
        const error = this.invalidRange();
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      this.resumedFrom = asset.filled;
    } else {
      // A 200 after If-Range is a replacement representation, starting at byte zero.
      this.asset = undefined;
      if (response.status !== 200 || !/^"[!#-~]*"$/.test(etag) || encoding !== 'identity'
        || !Number.isSafeInteger(length) || length < 1 || length > maximumBytes) return;
      asset = { target, etag, bytes: Buffer.allocUnsafe(length), filled: 0 };
      this.asset = asset;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ReferenceUploadError('Ark result download was empty', 'ark_result_incomplete', 502);
    let ended = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) { ended = true; break; }
        if (!value.byteLength) continue;
        if (asset.filled + value.byteLength > asset.bytes.length) throw this.invalidRange();
        asset.bytes.set(value, asset.filled);
        asset.filled += value.byteLength;
        onBytes(asset.filled);
      }
      if (asset.filled !== asset.bytes.length) {
        throw new ReferenceUploadError('Ark result download ended early', 'ark_result_incomplete', 502);
      }
      this.asset = undefined;
      return asset.bytes;
    } finally {
      if (!ended) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

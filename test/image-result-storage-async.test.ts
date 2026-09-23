import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  persistGeneratedImageResultLocally,
  persistGeneratedImageResultsAndScheduleMirrors,
  scheduleGeneratedImageResultStorageMirror,
} from '../src/modules/ai/image-service.js';
import {
  getImageResult,
  isImageResultStorageMirrorPending,
} from '../src/modules/ai/image-result-store.js';
import { storageService } from '../src/modules/storage/service.js';

const context = {
  clientRequestId: 'async-storage-test',
  canonicalModel: 'test-image-model',
  routeId: 'test-route',
  providerId: 'test-provider',
  adapterKey: 'TEST_ADAPTER',
};

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

async function removeStoredResult(stableUrl: string) {
  const key = new URL(stableUrl).pathname.split('/').filter(Boolean).pop();
  if (!key) return;
  const stored = await getImageResult(key);
  if (stored) await rm(stored.path, { force: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('foreground image persistence and background COS mirroring', () => {
  it('returns a stable local URL before a slow COS mirror completes', async () => {
    let releaseUpload!: (value: string) => void;
    const uploadPromise = new Promise<string>(resolve => { releaseUpload = resolve; });
    const uploadMedia = vi.spyOn(storageService, 'uploadMedia').mockReturnValue(uploadPromise as never);
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(
      'https://storage.example/generated-images/async.png?signature=redacted',
    );

    const [stableUrl] = await persistGeneratedImageResultsAndScheduleMirrors(
      [pngDataUrl],
      'test-provider',
      context,
    );
    expect(stableUrl).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);
    const key = new URL(stableUrl).pathname.split('/').filter(Boolean).pop()!;
    expect(await getImageResult(key)).not.toBeNull();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(isImageResultStorageMirrorPending(key)).toBe(true);

    releaseUpload(`generated-images/${key}`);
    await vi.waitFor(() => expect(isImageResultStorageMirrorPending(key)).toBe(false));
    await removeStoredResult(stableUrl);
  });

  it('deduplicates concurrent mirrors by stable result key', async () => {
    let releaseUpload!: (value: string) => void;
    const uploadPromise = new Promise<string>(resolve => { releaseUpload = resolve; });
    const uploadMedia = vi.spyOn(storageService, 'uploadMedia').mockReturnValue(uploadPromise as never);
    vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue('https://storage.example/generated-images/one.png');
    const stableUrl = await persistGeneratedImageResultLocally(pngDataUrl, 0, context);
    const key = new URL(stableUrl).pathname.split('/').filter(Boolean).pop()!;

    const first = scheduleGeneratedImageResultStorageMirror(stableUrl, 0, context);
    const second = scheduleGeneratedImageResultStorageMirror(stableUrl, 1, context);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    releaseUpload(`generated-images/${key}`);
    await first;
    expect(isImageResultStorageMirrorPending(key)).toBe(false);
    await removeStoredResult(stableUrl);
  });

  it('does not reject local delivery when every background COS attempt fails', async () => {
    const uploadMedia = vi.spyOn(storageService, 'uploadMedia').mockRejectedValue(new Error('COS unavailable'));
    const [stableUrl] = await persistGeneratedImageResultsAndScheduleMirrors(
      [pngDataUrl],
      'test-provider',
      context,
    );
    expect(stableUrl).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);
    const key = new URL(stableUrl).pathname.split('/').filter(Boolean).pop()!;
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(3), { timeout: 6_000 });
    await vi.waitFor(() => expect(isImageResultStorageMirrorPending(key)).toBe(false), { timeout: 6_000 });
    expect(await getImageResult(key)).not.toBeNull();
    await removeStoredResult(stableUrl);
  });
});

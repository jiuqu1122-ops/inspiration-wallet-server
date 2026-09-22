/** Run inside inspiration-wallet-server with its normal Vitest setup.
 * This file was supplied for integration validation; it is NOT included in the
 * patch package's isolated-core pass count. No paid provider is contacted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectImageStrings, uniqueImages, resolveImageAdapterResponse,
  resolveUselgImageResponse, mirrorGeneratedImageResults,
} from '../src/modules/ai/image-service.js';
import {
  ImageTaskRecoveryRequiredError, ImageTaskTerminalFailureError,
} from '../src/modules/ai/image-task-retry.js';

const provider = { id: 'fixture-provider', kind: 'USELG', baseUrl: 'https://provider.example', name: 'fixture' } as never;
const secrets = { apiKey: 'test-only-not-a-real-key', headers: {} } as never;
const receipt = {
  task_id: 'fixture-task', status: 'queued',
  status_url: 'https://provider.example/v1/images/tasks/fixture-task?view=summary',
  result_url: 'https://provider.example/v1/images/tasks/fixture-task/result',
};
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const noWait = async (_milliseconds: number) => {};
const transient = (status: number) => Object.assign(new Error('fixture HTTP error'), { status });
const done = () => ({ task_id: 'fixture-task', status: 'success', data: [{ url: 'https://images.example/final.png' }] });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('image retry integration with image-service entry points', () => {
  it('does not treat task controls as an immediate generated image', () => {
    expect(uniqueImages(receipt, [], 1)).toEqual([]);
    expect(collectImageStrings({ ...receipt, error: { message: 'see https://docs.example/error' },
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.split(',')[1] } }] } }] })).toEqual([png]);
  });

  it('retries the same status GET after a temporary 502, with no generation body', async () => {
    const request = vi.fn(async (_url: string, body?: unknown, _timeout?: number): Promise<unknown> => {
      expect(body).toBeUndefined();
      if (request.mock.calls.length === 1) throw transient(502);
      return done();
    });
    const images = await resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request);
    expect(images).toEqual(['https://images.example/final.png']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(call => call[0] === receipt.status_url)).toBe(true);
  });

  it('honors a two-minute 429 hint rather than polling after ten seconds', async () => {
    const waits: number[] = [];
    let count = 0;
    const request = async (_url: string): Promise<unknown> => {
      if (++count === 1) throw Object.assign(transient(429), { retryAfterMs: 120_000 });
      return done();
    };
    expect(await resolveImageAdapterResponse(provider, secrets, receipt, [], 1,
      async ms => { waits.push(ms); }, request)).toHaveLength(1);
    expect(waits).toContain(120_000);
  });

  it('does not convert one permanent 401 read error into a new generation', async () => {
    const request = vi.fn(async () => { throw transient(401); });
    await expect(resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .rejects.toBeInstanceOf(ImageTaskRecoveryRequiredError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops after five failed read attempts and retains the original identity in the error', async () => {
    const request = vi.fn(async () => { throw transient(502); });
    await expect(resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED', identity: { taskId: 'fixture-task' } });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('allows a completed task result to become readable on a later read', async () => {
    let calls = 0;
    const request = vi.fn(async (_url: string, body?: unknown): Promise<unknown> => {
      expect(body).toBeUndefined();
      calls += 1;
      if (calls === 2) return { task_id: 'fixture-task', status: 'processing' };
      if (calls === 4) return done();
      return { task_id: 'fixture-task', status: 'success', result_url: receipt.result_url };
    });
    expect(await resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .toEqual(['https://images.example/final.png']);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not poll the result endpoint while generation is queued', async () => {
    let calls = 0;
    const request = vi.fn(async (_url: string): Promise<unknown> => ++calls < 3
      ? { task_id: 'fixture-task', status: 'queued' } : done());
    expect(await resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request)).toHaveLength(1);
    expect(request.mock.calls.every(call => call[0] === receipt.status_url)).toBe(true);
  });

  it('uses a terminal task error that cannot match the old UpstreamImageError failover branch', async () => {
    const request = vi.fn(async () => ({ task_id: 'fixture-task', status: 'failed' }));
    await expect(resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .rejects.toBeInstanceOf(ImageTaskTerminalFailureError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not use a different task result', async () => {
    const request = vi.fn(async () => ({ ...done(), task_id: 'different-task' }));
    await expect(resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .rejects.toMatchObject({ reason: 'task_identity_mismatch' });
  });

  it('does not mistake a final asset id for a mismatched task id', async () => {
    const request = vi.fn(async () => ({ status: 'success', data: [{ id: 'image-asset-id', url: 'https://images.example/final.png' }] }));
    expect(await resolveImageAdapterResponse(provider, secrets, receipt, [], 1, noWait, request))
      .toEqual(['https://images.example/final.png']);
  });

  it('keeps direct inline images compatible without polling', async () => {
    const request = vi.fn(async () => { throw new Error('must not poll'); });
    const direct = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.split(',')[1] } }] } }] };
    expect(await resolveImageAdapterResponse(provider, secrets, direct, [], 1, noWait, request)).toEqual([png]);
    expect(request).not.toHaveBeenCalled();
  });

  it('also retries in the USELG resolver without posting another task', async () => {
    let count = 0;
    const request = vi.fn(async (_url: string, body?: unknown): Promise<unknown> => {
      expect(body).toBeUndefined();
      if (++count === 1) throw transient(503);
      return done();
    });
    expect(await resolveUselgImageResponse(provider, secrets, receipt, [], 1, noWait, undefined, request)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves delivered images and their order when one transfer fails', async () => {
    const mirror = vi.fn(async (source: string) => {
      if (source === 'b') throw new Error('no permitted delivery method available');
      return `https://ours.example/${source}.png`;
    });
    expect(await mirrorGeneratedImageResults(['a', 'b', 'c'], 'fixture', mirror))
      .toEqual(['https://ours.example/a.png', 'https://ours.example/c.png']);
    expect(mirror).toHaveBeenCalledTimes(3);
  });

  it('does not fabricate success when all image transfers fail', async () => {
    await expect(mirrorGeneratedImageResults(['a'], 'fixture', async () => { throw new Error('unavailable'); }))
      .rejects.toMatchObject({ code: 'IMAGE_RESULT_PERSISTENCE_FAILED' });
  });
});

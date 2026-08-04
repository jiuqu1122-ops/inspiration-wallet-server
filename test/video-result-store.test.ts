import { access, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  upload: vi.fn(async (input: { namespace: string; filename: string }) => `${input.namespace}/${input.filename}`),
  exists: vi.fn(async () => true),
  getPublicUrl: vi.fn((name: string) => `https://oss.example/${name}?token=1`),
}));

vi.mock('../src/modules/ai/oss-uploader.js', () => ({
  ossUploadService: bridgeMocks,
}));

import { mirrorGeneratedVideoResultToOss } from '../src/modules/ai/video-result-store.js';

afterEach(() => {
  vi.unstubAllGlobals();
  bridgeMocks.upload.mockClear();
  bridgeMocks.exists.mockClear();
  bridgeMocks.getPublicUrl.mockClear();
});

describe('generated video OSS mirroring', () => {
  it('streams a public MP4 into OSS and returns a stable API URL', async () => {
    const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
    const fetchMock = vi.fn(async () => new Response(mp4, {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(mp4.byteLength),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    let stagedPath = '';
    bridgeMocks.upload.mockImplementationOnce(async (input: {
      namespace: string;
      filename: string;
      source: string;
      mime: string;
    }) => {
      stagedPath = input.source;
      expect(input.namespace).toBe('generated-videos');
      expect(input.filename).toMatch(/^[a-f0-9]{64}\.mp4$/);
      expect(input.mime).toBe('video/mp4');
      expect(await readFile(input.source)).toEqual(mp4);
      return `${input.namespace}/${input.filename}`;
    });

    const result = await mirrorGeneratedVideoResultToOss('https://1.1.1.1/output.mp4');
    expect(result).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/video-results\/[a-f0-9]{64}\.mp4$/);
    expect(bridgeMocks.exists).toHaveBeenCalledWith(expect.stringMatching(/^generated-videos\//));
    expect(bridgeMocks.getPublicUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^generated-videos\//),
      expect.objectContaining({ mime: 'video/mp4' }),
    );
    await expect(access(stagedPath)).rejects.toThrow();
    await expect(mirrorGeneratedVideoResultToOss('https://1.1.1.1/output.mp4')).resolves.toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.upload).toHaveBeenCalledTimes(1);
  });
});

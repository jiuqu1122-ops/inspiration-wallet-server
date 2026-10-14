import { access, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  configured: true,
  headObject: vi.fn(async () => null as null | { contentLength: number }),
  uploadMedia: vi.fn(async (input: { namespace: string; filename: string; source: string; mime: string }) => `${input.namespace}/${input.filename}`),
  exists: vi.fn(async () => true),
}));
vi.mock('../src/modules/storage/service.js', () => ({ storageService: storage }));
import { mirrorGeneratedAudioResultToStorage } from '../src/modules/ai/audio-result-store.js';

const bytes = Buffer.from('ID3generated-audio');
const token = 'a'.repeat(64);
describe('audio object storage', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.configured = true; });
  afterEach(() => vi.unstubAllGlobals());
  it('streams the audio to disk, uploads all bytes and keeps a stable address without upstream URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) } })));
    let path = '';
    storage.uploadMedia.mockImplementationOnce(async input => {
      path = input.source;
      expect(await readFile(path)).toEqual(bytes);
      expect(input).toMatchObject({ namespace: 'generated-audios', filename: `${token}.mp3`, mime: 'audio/mpeg' });
      return `${input.namespace}/${input.filename}`;
    });
    const asset = await mirrorGeneratedAudioResultToStorage('https://1.1.1.1/song.mp3?temporary=secret', token);
    expect(asset).toMatchObject({ url: `https://api.example.test/v1/ai/audio-results/${token}.mp3`, objectKey: `generated-audios/${token}.mp3`, size: bytes.length, mime: 'audio/mpeg' });
    expect(JSON.stringify(asset)).not.toContain('temporary');
    await expect(access(path)).rejects.toThrow();
  });
  it('recovers an acknowledged COS object without downloading an expired vendor URL', async () => {
    storage.headObject.mockResolvedValueOnce({ contentLength: bytes.length });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const asset = await mirrorGeneratedAudioResultToStorage('https://1.1.1.1/expired.mp3', token);
    expect(asset.objectKey).toBe(`generated-audios/${token}.mp3`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.uploadMedia).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent recovery for the same receipt', async () => {
    const fetchMock = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([mirrorGeneratedAudioResultToStorage('https://1.1.1.1/a.mp3', token), mirrorGeneratedAudioResultToStorage('https://1.1.1.1/a.mp3', token)]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.uploadMedia).toHaveBeenCalledTimes(1);
  });
  it.each(['http://1.1.1.1/a.mp3', 'https://user:password@1.1.1.1/a.mp3', 'https://127.0.0.1/a.mp3'])('rejects an unsafe audio source %s', async source => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(mirrorGeneratedAudioResultToStorage(source, token)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.uploadMedia).not.toHaveBeenCalled();
  });
  it('validates redirect targets before fetching them', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private.mp3' } })); vi.stubGlobal('fetch', fetchMock);
    await expect(mirrorGeneratedAudioResultToStorage('https://1.1.1.1/redirect.mp3', token)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    [Buffer.from('RIFF0000WAVEdata'), 'audio/wav', 'wav'],
    [Buffer.from('fLaCaudio'), 'audio/flac', 'flac'],
    [Buffer.from('OggS0000OpusHead'), 'audio/ogg', 'opus'],
    [Buffer.from('0000ftypM4A '), 'audio/mp4', 'm4a'],
  ])('preserves the format of %s', async (body, mime, extension) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': mime } })));
    const asset = await mirrorGeneratedAudioResultToStorage('https://1.1.1.1/audio', token);
    expect(asset.objectKey).toBe(`generated-audios/${token}.${extension}`);
  });
  it.each([
    ['<html>provider failed</html>', { 'content-type': 'audio/mpeg' }],
    ['', { 'content-type': 'audio/mpeg' }],
    ['ID3audio', { 'content-length': '268435457' }],
    ['ID3audio', { 'content-length': '900' }],
  ])('rejects invalid, oversized or truncated audio', async (body, headers) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers })));
    await expect(mirrorGeneratedAudioResultToStorage('https://1.1.1.1/audio', token)).rejects.toThrow();
    expect(storage.uploadMedia).not.toHaveBeenCalled();
  });
  it('cleans up staging files after an upload failure and never returns the vendor URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    let path = '';
    storage.uploadMedia.mockImplementationOnce(async input => { path = input.source; throw new Error('COS failure'); });
    await expect(mirrorGeneratedAudioResultToStorage('https://1.1.1.1/audio', token)).rejects.toThrow('COS failure');
    await expect(access(path)).rejects.toThrow();
  });
});

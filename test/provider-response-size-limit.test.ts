import { afterEach, expect, it, vi } from 'vitest';
import { buildFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';
import { providerRequest } from '../src/modules/ai/image-service.js';

const provider = { baseUrl: 'https://provider.example' } as never;
const secrets = { apiKey: 'test-key', headers: {} };
const encoder = new TextEncoder();

function request(maxResponseBytes?: number, onResponseStatus?: (status: number, headers: Headers) => void) {
  return providerRequest(provider, secrets, '/images/generations', {}, 1_000,
    undefined, onResponseStatus, undefined, undefined,
    maxResponseBytes === undefined ? undefined : { maxResponseBytes });
}

afterEach(() => vi.restoreAllMocks());

it('rejects an oversized uncompressed Content-Length before reading the body', async () => {
  const pull = vi.fn();
  const cancel = vi.fn();
  const onStatus = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-length': '513' } }));

  const error = await request(512, onStatus).catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    message: 'Provider response exceeds the byte limit',
    cause: { code: 'IMAGE_PROVIDER_RESPONSE_SIZE_LIMIT' },
    responseValue: undefined,
  });
  expect(buildFailureDiagnostic(error, { stage: 'canvas_layer_submit' })).toMatchObject({ code: 'IMAGE_SIZE_LIMIT' });
  expect(onStatus).toHaveBeenCalledWith(200, expect.any(Headers));
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('counts decoded bytes cumulatively and cancels at the first over-limit chunk', async () => {
  const bytes = encoder.encode('{"text":"产物"}');
  const chunks = [bytes.subarray(0, 10), bytes.subarray(10)];
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(chunks.shift()!));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
    headers: { 'content-encoding': 'gzip', 'content-length': '1' },
  }));

  await expect(request(bytes.byteLength - 1)).rejects.toMatchObject({
    message: 'Provider response exceeds the byte limit', cause: { code: 'IMAGE_PROVIDER_RESPONSE_SIZE_LIMIT' },
  });
  expect(pull).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  { 'content-encoding': 'gzip', 'content-length': '1000' },
  { 'content-length': '1000, 1000' },
])('uses the stream limit instead of prechecking ineligible Content-Length headers', async headers => {
  const text = '{"text":"产物"}';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(text, { headers }));
  await expect(request(encoder.encode(text).byteLength)).resolves.toEqual({ text: '产物' });
});

it('preserves ordinary upstream HTTP error details within the byte limit and with no limit', async () => {
  const text = '{"error":{"code":"InvalidParameter","message":"unsupported model"}}';
  const responseValue = JSON.parse(text) as unknown;
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(text, { status: 400 }))
    .mockResolvedValueOnce(new Response(text, { status: 400, headers: { 'content-length': '1000' } }));

  for (const limit of [encoder.encode(text).byteLength, undefined]) {
    await expect(request(limit)).rejects.toMatchObject({
      status: 400, message: 'HTTP 400: unsupported model', responseValue,
    });
  }
});

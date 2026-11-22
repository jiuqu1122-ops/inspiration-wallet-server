import { afterEach, expect, it, vi } from 'vitest';
import { buildFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';
import { providerRequest } from '../src/modules/ai/image-service.js';

const provider = { baseUrl: 'https://provider.example' } as never;
const secrets = { apiKey: 'test-key', headers: {} };
const encoder = new TextEncoder();

function request(timeoutMs: number, options: Parameters<typeof providerRequest>[9]) {
  return providerRequest(provider, secrets, '/images/generations', {}, timeoutMs,
    undefined, undefined, undefined, undefined, options);
}

function delayedResponse(chunks: Array<[delayMs: number, text: string]>, { status = 200, ends = true } = {}) {
  let cancelled = false;
  const cancel = vi.fn(() => { cancelled = true; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks.shift();
      if (!chunk) return;
      const [delayMs, text] = chunk;
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      if (cancelled) return;
      controller.enqueue(encoder.encode(text));
      if (ends && !chunks.length) controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status }), cancel };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('allows a successful response that keeps progressing past the original deadline', async () => {
  vi.useFakeTimers();
  const chunks: Array<[number, string]> = [[25, '{"text":'], [25, '"产物"'], [25, '}']];
  const byteLimit = encoder.encode(chunks.map(([, text]) => text).join('')).byteLength;
  const { response, cancel } = delayedResponse(chunks);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    return response;
  });
  const onProgress = vi.fn();
  const pending = request(50, { responseBodyTimeoutMs: 100, responseBodyIdleTimeoutMs: 35,
    maxResponseBytes: byteLimit, onResponseBodyProgress: onProgress });
  const result = expect(pending).resolves.toEqual({ text: '产物' });

  await vi.advanceTimersByTimeAsync(95);
  await result;
  expect(onProgress.mock.calls).toEqual([[encoder.encode('{"text":').byteLength], [byteLimit - 1], [byteLimit]]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it('aborts an idle successful body even when an empty chunk arrived', async () => {
  vi.useFakeTimers();
  const { response, cancel } = delayedResponse([[1, '{"data":'], [24, '']], { ends: false });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  const onProgress = vi.fn();
  const pending = request(50, { responseBodyTimeoutMs: 100, responseBodyIdleTimeoutMs: 30,
    onResponseBodyProgress: onProgress }).catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(31);
  const error = await pending;
  expect(error).toMatchObject({ cause: { code: 'IMAGE_PROVIDER_RESPONSE_TIMEOUT', phase: 'response_body_idle' } });
  expect(buildFailureDiagnostic(error, { stage: 'canvas_layer_submit' })).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  expect(onProgress.mock.calls).toEqual([[8]]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it('caps total successful body time even when chunks arrive before the idle deadline', async () => {
  vi.useFakeTimers();
  const { response, cancel } = delayedResponse([[15, 'a'], [15, 'b'], [15, 'c'], [15, 'd']]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  const onProgress = vi.fn();
  const pending = request(25, { responseBodyTimeoutMs: 50, responseBodyIdleTimeoutMs: 20,
    onResponseBodyProgress: onProgress });
  const result = expect(pending).rejects.toMatchObject({
    cause: { code: 'IMAGE_PROVIDER_RESPONSE_TIMEOUT', phase: 'response_body' },
  });

  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(onProgress.mock.calls).toEqual([[1], [2], [3]]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps the original deadline and skips progress for a non-OK response', async () => {
  vi.useFakeTimers();
  const { response, cancel } = delayedResponse([[1, '{"error":']], { status: 400, ends: false });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  const onProgress = vi.fn();
  const result = expect(request(30, { responseBodyTimeoutMs: 10, responseBodyIdleTimeoutMs: 5,
    onResponseBodyProgress: onProgress })).rejects.toMatchObject({
    message: 'Provider response exceeded the 30ms deadline',
    cause: { code: 'IMAGE_PROVIDER_RESPONSE_TIMEOUT', phase: undefined },
  });

  await vi.advanceTimersByTimeAsync(30);
  await result;
  expect(onProgress).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it('retains the response byte cap while recording the over-limit chunk', async () => {
  vi.useFakeTimers();
  const { response, cancel } = delayedResponse([[5, 'abc'], [5, 'de']], { ends: false });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  const onProgress = vi.fn();
  const result = expect(request(50, { responseBodyTimeoutMs: 100, responseBodyIdleTimeoutMs: 30,
    maxResponseBytes: 4, onResponseBodyProgress: onProgress })).rejects.toMatchObject({
    cause: { code: 'IMAGE_PROVIDER_RESPONSE_SIZE_LIMIT' },
  });

  await vi.advanceTimersByTimeAsync(10);
  await result;
  expect(onProgress.mock.calls).toEqual([[3], [5]]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

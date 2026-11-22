import { once } from 'node:events';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { expect, it } from 'vitest';
import { createArkSubmitDiagnostics } from '../src/modules/ai/ark-submit-diagnostics.js';

it('tracks one POST waiting for headers independently of concurrent submissions', async () => {
  let heldRequests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      if (request.url === '/held') {
        heldRequests++;
        server.emit('held-body-arrived');
      } else {
        response.end('complete');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a test server port');
  const origin = `http://127.0.0.1:${address.port}`;
  const dispatcher = new Agent();
  const abort = new AbortController();

  try {
    const held = createArkSubmitDiagnostics();
    const completed = createArkSubmitDiagnostics();
    const options = { method: 'POST', body: 'a'.repeat(695_559), dispatcher, signal: abort.signal };
    const heldBodyArrived = once(server, 'held-body-arrived');
    const heldResponse = held.run(() => fetch(`${origin}/held`, options)).catch((error: unknown) => error);
    const completedResponse = completed.run(() => fetch(`${origin}/completed`, options));
    const untrackedResponse = fetch(`${origin}/untracked`, options);

    await heldBodyArrived;
    expect(await (await completedResponse).text()).toBe('complete');
    expect(await (await untrackedResponse).text()).toBe('complete');
    expect(completed.snapshot()).toMatchObject({
      arkSubmitPhase: 'response_headers_received', arkResponseHeadersMs: expect.any(Number),
    });
    expect(held.snapshot()).toMatchObject({
      arkSubmitPhase: 'awaiting_response_headers', arkRequestWriteStartedMs: expect.any(Number),
      arkRequestBodySentMs: expect.any(Number), arkResponseHeadersMs: undefined,
    });
    abort.abort();
    expect(await heldResponse).toMatchObject({ name: 'AbortError' });
    expect(heldRequests).toBe(1);
  } finally {
    abort.abort();
    await dispatcher.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

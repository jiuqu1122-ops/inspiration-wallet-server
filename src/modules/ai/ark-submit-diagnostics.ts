import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

type Trace = {
  startedAt: number;
  createdMs?: number;
  writeStartedMs?: number;
  bodySentMs?: number;
  responseHeadersMs?: number;
  transportErrorCode?: string;
};

type UndiciRequestEvent = {
  request: { method: string };
  response?: { statusCode: number };
  error?: { code?: unknown };
};

const activeTrace = new AsyncLocalStorage<Trace>();
const requestTraces = new WeakMap<object, Trace>();
let subscribed = false;

function elapsed(trace: Trace) {
  return Math.round(performance.now() - trace.startedAt);
}

function subscribeToRequests() {
  if (subscribed) return;
  subscribed = true;

  subscribe('undici:request:create', (message) => {
    const trace = activeTrace.getStore();
    if (!trace || trace.createdMs !== undefined) return;
    const { request } = message as UndiciRequestEvent;
    if (request.method !== 'POST') return;
    trace.createdMs = elapsed(trace);
    requestTraces.set(request, trace);
  });

  subscribe('undici:client:sendHeaders', (message) => {
    const { request } = message as UndiciRequestEvent;
    const trace = requestTraces.get(request);
    if (trace) trace.writeStartedMs ??= elapsed(trace);
  });

  subscribe('undici:request:bodySent', (message) => {
    const { request } = message as UndiciRequestEvent;
    const trace = requestTraces.get(request);
    if (trace) trace.bodySentMs ??= elapsed(trace);
  });

  subscribe('undici:request:headers', (message) => {
    const { request, response } = message as UndiciRequestEvent;
    const trace = requestTraces.get(request);
    if (trace && response && response.statusCode >= 200) {
      trace.responseHeadersMs ??= elapsed(trace);
    }
  });

  subscribe('undici:request:error', (message) => {
    const { request, error } = message as UndiciRequestEvent;
    const trace = requestTraces.get(request);
    const code = error?.code;
    if (trace && typeof code === 'string' && /^(?:UND_ERR_|E)[A-Z0-9_]{2,52}$/.test(code)) {
      trace.transportErrorCode = code;
    }
  });
}

type ArkSubmitPhase = 'not_observed' | 'before_request_headers' | 'sending_request_body'
  | 'awaiting_response_headers' | 'response_headers_received';

export function createArkSubmitDiagnostics() {
  subscribeToRequests();
  const trace: Trace = { startedAt: performance.now() };

  return {
    run<T>(submit: () => T): T {
      trace.startedAt = performance.now();
      return activeTrace.run(trace, submit);
    },
    snapshot() {
      let arkSubmitPhase: ArkSubmitPhase = 'not_observed';
      if (trace.responseHeadersMs !== undefined) arkSubmitPhase = 'response_headers_received';
      else if (trace.bodySentMs !== undefined) arkSubmitPhase = 'awaiting_response_headers';
      else if (trace.writeStartedMs !== undefined) arkSubmitPhase = 'sending_request_body';
      else if (trace.createdMs !== undefined) arkSubmitPhase = 'before_request_headers';

      // These are local socket milestones. Writing the body does not prove remote receipt.
      return {
        arkSubmitPhase,
        arkRequestWriteStartedMs: trace.writeStartedMs,
        arkRequestBodySentMs: trace.bodySentMs,
        arkResponseHeadersMs: trace.responseHeadersMs,
        arkTransportErrorCode: trace.transportErrorCode,
      };
    },
  };
}

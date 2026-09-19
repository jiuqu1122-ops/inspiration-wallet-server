import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { env } from '../../config/env.js';

export type ImageResponsePhase = 'generate' | 'status' | 'result';

export type ImageResponseDiagnosticIdentity = {
  clientRequestId: string;
  taskId?: string | undefined;
  providerId: string;
  routeId?: string | undefined;
  adapterKey?: string | undefined;
  phase: ImageResponsePhase;
  attempt?: number | undefined;
  addressSource: 'legacy_default' | 'adapter' | 'execution_config' | 'upstream' | 'upstream_updated' | 'default';
};

export type ImageResponseDiagnosticScope = {
  readonly identity: ImageResponseDiagnosticIdentity;
  readonly callId: string;
  readonly timeoutMs: number;
  readonly method: 'GET' | 'POST';
  readonly startedAt: number;
  readonly enabled: boolean;
  readonly detailed: boolean;
  fetchStartedAt?: number | undefined;
  stage: 'waiting_headers' | 'reading_body' | 'parsing' | 'complete';
  timeoutTriggered: boolean;
  headersLogged: boolean;
  bodyLogged: boolean;
  parseLogged: boolean;
  failureLogged: boolean;
};

export type ParsedProviderValue = {
  value: unknown;
  parseType: 'json' | 'sse' | 'text' | 'empty' | 'unknown';
};

type ImageCandidateDiagnostic = {
  kind: 'url' | 'inline';
  length: number;
  fieldPath?: string | null | undefined;
};

const diagnosticsEnabled = env.IMAGE_RESPONSE_DIAGNOSTICS !== 'off';
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
if (diagnosticsEnabled) eventLoopHistogram.enable();
let eventLoopWindowStartedAt = new Date().toISOString();
let lastEventLoopSample = {
  windowStartedAt: eventLoopWindowStartedAt,
  windowEndedAt: eventLoopWindowStartedAt,
  meanMs: null as number | null,
  maxMs: null as number | null,
  p99Ms: null as number | null,
};

function nanosecondsToMilliseconds(value: number) {
  return Number.isFinite(value) ? Number((value / 1_000_000).toFixed(3)) : null;
}

function sampleEventLoopDelay() {
  const windowEndedAt = new Date().toISOString();
  lastEventLoopSample = {
    windowStartedAt: eventLoopWindowStartedAt,
    windowEndedAt,
    meanMs: nanosecondsToMilliseconds(eventLoopHistogram.mean),
    maxMs: nanosecondsToMilliseconds(eventLoopHistogram.max),
    p99Ms: nanosecondsToMilliseconds(eventLoopHistogram.percentile(99)),
  };
  eventLoopHistogram.reset();
  eventLoopWindowStartedAt = windowEndedAt;
}

const eventLoopSampleTimer = diagnosticsEnabled
  ? setInterval(sampleEventLoopDelay, 10_000)
  : null;
eventLoopSampleTimer?.unref();
process.once('beforeExit', () => {
  if (eventLoopSampleTimer) clearInterval(eventLoopSampleTimer);
  if (diagnosticsEnabled) eventLoopHistogram.disable();
});

function runtimeSourceRevision() {
  const environmentRevision = process.env.SOURCE_REVISION?.trim();
  if (environmentRevision) return environmentRevision;
  try {
    const revision = readFileSync('/app/source-revision', 'utf8').trim();
    return revision || 'unknown';
  } catch {
    return 'unknown';
  }
}

const runtimeIdentity = {
  sourceRevision: runtimeSourceRevision(),
  nodeVersion: process.version,
};

export function imageDiagnosticRuntimeIdentity() {
  return runtimeIdentity;
}

function processDiagnosticSnapshot() {
  const memory = process.memoryUsage();
  return {
    eventLoopDelay: lastEventLoopSample,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    uptimeSeconds: Number(process.uptime().toFixed(3)),
  };
}

function safeTarget(targetUrl: string) {
  try {
    const parsed = new URL(targetUrl);
    const queryKeys = Array.from(new Set(parsed.searchParams.keys())).slice(0, 12);
    const pathSegments = parsed.pathname.split('/').map((segment, index, segments) => {
      if (!segment) return segment;
      const previous = segments[index - 1]?.toLowerCase();
      if (previous === 'models') return ':model';
      if (['tasks', 'generations', 'results', 'assets'].includes(previous ?? '')) return ':id';
      if (/^[a-f0-9-]{24,}$/i.test(segment) || segment.length > 80) return ':id';
      return segment;
    });
    return {
      targetHost: parsed.host,
      targetPathTemplate: `${pathSegments.join('/')}${queryKeys.length
        ? `?${queryKeys.map(key => `${key}=<redacted>`).join('&')}`
        : ''}`,
    };
  } catch {
    return { targetHost: 'unknown', targetPathTemplate: 'unknown' };
  }
}

function baseFields(scope: ImageResponseDiagnosticScope) {
  const identity = scope.identity;
  return {
    callId: scope.callId,
    clientRequestId: identity.clientRequestId,
    taskId: identity.taskId ?? null,
    providerId: identity.providerId,
    routeId: identity.routeId ?? null,
    adapterKey: identity.adapterKey ?? null,
    phase: identity.phase,
    attempt: identity.attempt ?? null,
    addressSource: identity.addressSource,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
}

function elapsedMs(scope: ImageResponseDiagnosticScope) {
  return Number((performance.now() - scope.startedAt).toFixed(3));
}

function durationMs(startedAt: number, completedAt: number) {
  return Number((completedAt - startedAt).toFixed(3));
}

function shouldIncludeProcessSnapshot(scope: ImageResponseDiagnosticScope) {
  return scope.detailed || elapsedMs(scope) >= env.IMAGE_RESPONSE_DIAGNOSTICS_SLOW_MS;
}

function logInfo(event: string, scope: ImageResponseDiagnosticScope, fields: Record<string, unknown>) {
  if (!scope.enabled) return;
  console.info('[image_response_diagnostic]', {
    event,
    ...baseFields(scope),
    ...fields,
  });
}

function logWarning(event: string, scope: ImageResponseDiagnosticScope, fields: Record<string, unknown>) {
  if (!scope.enabled) return;
  console.warn('[image_response_diagnostic]', {
    event,
    ...baseFields(scope),
    ...fields,
  });
}

export function startImageResponseDiagnostic(input: ImageResponseDiagnosticIdentity & {
  targetUrl: string;
  timeoutMs: number;
  method: 'GET' | 'POST';
  detailedOverride?: boolean | undefined;
}) {
  const enabled = diagnosticsEnabled;
  const scope: ImageResponseDiagnosticScope = {
    identity: input,
    callId: enabled ? randomUUID() : '',
    timeoutMs: input.timeoutMs,
    method: input.method,
    startedAt: performance.now(),
    enabled,
    detailed: input.detailedOverride ?? env.IMAGE_RESPONSE_DIAGNOSTICS === 'detailed',
    stage: 'waiting_headers',
    timeoutTriggered: false,
    headersLogged: false,
    bodyLogged: false,
    parseLogged: false,
    failureLogged: false,
  };
  if (!enabled) return scope;
  const target = safeTarget(input.targetUrl);
  logInfo('request_started', scope, {
    timeoutMs: input.timeoutMs,
    method: input.method,
    addressSource: input.addressSource,
    ...target,
    ...runtimeIdentity,
  });
  return scope;
}

export function markImageResponseHeaders(scope: ImageResponseDiagnosticScope, response: Response) {
  const responseHeadersAt = performance.now();
  scope.stage = 'reading_body';
  scope.headersLogged = true;
  if (!scope.enabled) return;
  logInfo('response_headers', scope, {
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    contentEncoding: response.headers.get('content-encoding'),
    declaredContentLength: response.headers.get('content-length'),
    headersWaitMs: durationMs(scope.startedAt, responseHeadersAt),
    ...(scope.fetchStartedAt === undefined
      ? {}
      : { fetchToHeadersMs: durationMs(scope.fetchStartedAt, responseHeadersAt) }),
  });
}

export function markImageRequestPayloadReady(
  scope: ImageResponseDiagnosticScope,
  requestBodyBytes: number,
  serializeStartedAt: number,
  serializeCompletedAt: number,
) {
  if (!scope.enabled) return;
  logInfo('request_payload_ready', scope, {
    requestBodyBytes,
    jsonSerializeMs: durationMs(serializeStartedAt, serializeCompletedAt),
  });
}

export function markImageFetchStarted(scope: ImageResponseDiagnosticScope) {
  const fetchStartedAt = performance.now();
  scope.fetchStartedAt = fetchStartedAt;
  if (!scope.enabled) return;
  logInfo('fetch_started', scope, {
    preFetchMs: durationMs(scope.startedAt, fetchStartedAt),
  });
}

export function markImageResponseBodyComplete(
  scope: ImageResponseDiagnosticScope,
  text: string,
  bodyStartedAt: number,
) {
  scope.stage = 'parsing';
  scope.bodyLogged = true;
  if (!scope.enabled) return;
  logInfo('response_body_complete', scope, {
    bodyReadMs: Number((performance.now() - bodyStartedAt).toFixed(3)),
    decodedBodyBytes: Buffer.byteLength(text, 'utf8'),
    bodyStringLength: text.length,
    wireBodyBytes: null,
  });
}

function parsedValueSummary(value: unknown, detailed: boolean) {
  if (Array.isArray(value)) {
    return {
      topLevelType: 'array',
      topLevelCount: value.length,
      topLevelKeys: null,
    };
  }
  if (value && typeof value === 'object') {
    return {
      topLevelType: 'object',
      topLevelCount: Object.keys(value).length,
      topLevelKeys: detailed
        ? Object.keys(value).slice(0, 16)
        : null,
    };
  }
  return {
    topLevelType: value === null ? 'null' : typeof value,
    topLevelCount: null,
    topLevelKeys: null,
  };
}

export function markImageResponseParseComplete(
  scope: ImageResponseDiagnosticScope,
  parsed: ParsedProviderValue,
  parseStartedAt: number | null,
) {
  scope.stage = 'complete';
  scope.parseLogged = true;
  if (!scope.enabled) return;
  logInfo('response_parse_complete', scope, {
    parseMs: parseStartedAt === null
      ? null
      : Number((performance.now() - parseStartedAt).toFixed(3)),
    parseType: parsed.parseType,
    ...parsedValueSummary(parsed.value, scope.detailed),
    totalObservedMs: elapsedMs(scope),
    ...(shouldIncludeProcessSnapshot(scope) ? { processSnapshot: processDiagnosticSnapshot() } : {}),
  });
}

export function completeOpaqueImageResponse(
  scope: ImageResponseDiagnosticScope,
  value: unknown,
) {
  if (!scope.enabled) {
    scope.stage = 'complete';
    scope.headersLogged = true;
    scope.bodyLogged = true;
    scope.parseLogged = true;
    return;
  }
  if (!scope.headersLogged) {
    scope.headersLogged = true;
    logInfo('response_headers', scope, {
      httpStatus: null,
      contentType: null,
      contentEncoding: null,
      declaredContentLength: null,
      headersWaitMs: null,
      observer: 'injected_request',
    });
  }
  if (!scope.bodyLogged) {
    scope.bodyLogged = true;
    logInfo('response_body_complete', scope, {
      bodyReadMs: null,
      decodedBodyBytes: null,
      bodyStringLength: null,
      wireBodyBytes: null,
      observer: 'injected_request',
    });
  }
  if (!scope.parseLogged) {
    markImageResponseParseComplete(scope, {
      value,
      parseType: 'unknown',
    }, null);
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

export function markImageResponseFailure(scope: ImageResponseDiagnosticScope, error: unknown) {
  if (scope.failureLogged) return;
  scope.failureLogged = true;
  if (!scope.enabled) return;
  const cause = error instanceof Error ? error.cause : undefined;
  const errorCode = safeErrorCode(error);
  const causeCode = safeErrorCode(cause);
  const isTimeout = scope.timeoutTriggered
    || error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && /timeout/i.test(error.name)
    || /timeout/i.test(errorCode ?? '')
    || /timeout/i.test(causeCode ?? '');
  logWarning(isTimeout ? 'request_timeout' : 'request_failed', scope, {
    failedStage: scope.stage,
    elapsedMs: elapsedMs(scope),
    timeoutMs: scope.timeoutMs,
    timeoutTriggered: scope.timeoutTriggered,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode,
    causeCode,
    processSnapshot: processDiagnosticSnapshot(),
  });
}

export async function runImageResponseDiagnosticRequest<T>(
  scope: ImageResponseDiagnosticScope,
  request: (scope: ImageResponseDiagnosticScope) => Promise<T>,
) {
  try {
    const value = await request(scope);
    completeOpaqueImageResponse(scope, value);
    return { value, scope };
  } catch (error) {
    markImageResponseFailure(scope, error);
    throw error;
  }
}

export function imageKind(value: string): 'url' | 'inline' {
  return /^https?:\/\//i.test(value) ? 'url' : 'inline';
}

export function markImageExtractComplete(input: {
  scope: ImageResponseDiagnosticScope;
  extractStartedAt: number;
  state: string;
  images: string[];
  assetCount: number | null;
  hasResultUrl: boolean;
  candidates?: ImageCandidateDiagnostic[] | undefined;
}) {
  if (!input.scope.enabled) return;
  const kinds = new Set(input.images.map(imageKind));
  const imageKindValue = kinds.size === 0 ? 'none'
    : kinds.size > 1 ? 'mixed'
      : kinds.has('url') ? 'url' : 'inline';
  logInfo('image_extract_complete', input.scope, {
    extractMs: Number((performance.now() - input.extractStartedAt).toFixed(3)),
    state: input.state || null,
    imageCount: input.images.length,
    imageKind: imageKindValue,
    assetCount: input.assetCount,
    hasResultUrl: input.hasResultUrl,
    totalObservedMs: elapsedMs(input.scope),
    candidates: input.scope.detailed
      ? (input.candidates ?? input.images.slice(0, 12).map(value => ({
        kind: imageKind(value),
        length: value.length,
        fieldPath: null,
      })))
      : null,
    ...(shouldIncludeProcessSnapshot(input.scope) ? { processSnapshot: processDiagnosticSnapshot() } : {}),
  });
}

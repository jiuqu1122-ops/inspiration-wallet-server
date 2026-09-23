/** Read-side image recovery. Never invokes a generation POST or wallet mutation. */
export type ImageReadStage = 'status' | 'result' | 'asset';
export type ImageTaskIdentity = { taskId: string; statusUrl: string; resultUrl: string };
export type ImageRetryEvent = {
  stage: ImageReadStage; attempt: number; maxAttempts: number;
  delayMs: number; httpStatus: number | null; reason: string;
};

export class ImageTaskRecoveryRequiredError extends Error {
  readonly code = 'IMAGE_TASK_RECOVERY_REQUIRED';
  constructor(
    readonly identity: ImageTaskIdentity,
    readonly stage: ImageReadStage,
    readonly reason: string,
    cause?: unknown,
  ) {
    super('图片请求结果尚未确认；请勿重复提交生成。', { cause });
    this.name = 'ImageTaskRecoveryRequiredError';
  }
}

/** Deliberately NOT an UpstreamImageError: a failed task must not trigger POST failover. */
export class ImageTaskTerminalFailureError extends Error {
  readonly code = 'IMAGE_TASK_FAILED';
  constructor(readonly taskId: string, readonly taskState: string, cause?: unknown) {
    super(`上游图片任务明确失败（${taskState}）`, { cause });
    this.name = 'ImageTaskTerminalFailureError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function imageReadHttpStatus(error: unknown): number | null {
  const row = record(error);
  for (const candidate of [row?.status, row?.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= 599) return candidate;
  }
  return null;
}

export function parseImageRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1_000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  // Do not interpret signed/fractional numbers as dates.
  if (!/[a-z]/i.test(text)) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : undefined;
}

export function imagePollDelayMs(value: unknown, fallback = 2_000): number {
  const row = record(value);
  const raw = row?.poll_after_ms ?? row?.pollAfterMs;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(10_000, Math.max(1_000, parsed));
}

/** HTTP Retry-After is a transport/backoff hint, not a task poll interval. */
export function imageRetryAfterMs(value: unknown): number | undefined {
  const row = record(value);
  const raw = row?.retry_after_ms ?? row?.retryAfterMs;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function withImagePollHint(value: unknown, header: string | null): unknown {
  const row = record(value);
  const hint = parseImageRetryAfter(header);
  if (!row || hint === undefined) return value;
  return { ...row, retry_after_ms: hint };
}

export function isTransientImageReadError(error: unknown, allowNotReady = false): boolean {
  if (error instanceof ImageTaskTerminalFailureError || error instanceof ImageTaskRecoveryRequiredError) return false;
  const status = imageReadHttpStatus(error);
  if (status !== null) {
    return status === 0 || [408, 425, 429, 500, 502, 503, 504].includes(status)
      || (allowNotReady && [404, 409].includes(status));
  }
  const row = record(error);
  const scalarText = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const code = scalarText(row?.code) || scalarText(record(row?.cause)?.code);
  const name = scalarText(row?.name);
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|IMAGE_PROVIDER_RESPONSE_TIMEOUT)$/.test(code)
    || /^(?:AbortError|TimeoutError|ProviderResponseTimeoutError)$/.test(name);
}

export type ImageRetryOptions = {
  identity: ImageTaskIdentity; stage: ImageReadStage; deadline: number;
  timeoutMs?: number; maxAttempts?: number; allowNotReady?: boolean;
  wait?: (ms: number) => Promise<unknown>; now?: () => number;
  random?: () => number; onRetry?: ((event: ImageRetryEvent) => void) | undefined;
};

export async function retryImageRead<T>(
  operation: (timeoutMs: number) => Promise<T>, options: ImageRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const attempts = Math.max(1, Math.min(8, options.maxAttempts ?? 5));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = options.deadline - now();
    if (remaining <= 0) break;
    try {
      // The HTTP operation MUST apply this timeout to headers and body reads.
      return await operation(Math.max(1, Math.min(options.timeoutMs ?? 45_000, remaining)));
    } catch (error) {
      if (error instanceof ImageTaskTerminalFailureError || error instanceof ImageTaskRecoveryRequiredError) throw error;
      last = error;
      if (!isTransientImageReadError(error, options.allowNotReady)) {
        throw new ImageTaskRecoveryRequiredError(options.identity, options.stage, 'read_not_retryable', error);
      }
      if (attempt === attempts) break;
      const hint = record(error)?.retryAfterMs;
      const delayMs = Math.max(
        Math.min(8_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.max(0, Math.min(1, random())) * 250),
        typeof hint === 'number' && Number.isSafeInteger(hint) && hint >= 0 ? hint : 0,
      );
      if (delayMs >= options.deadline - now()) {
        throw new ImageTaskRecoveryRequiredError(options.identity, options.stage, 'retry_hint_exceeds_budget', error);
      }
      options.onRetry?.({ stage: options.stage, attempt, maxAttempts: attempts,
        delayMs, httpStatus: imageReadHttpStatus(error), reason: 'transient_read_error' });
      await wait(delayMs);
    }
  }
  throw new ImageTaskRecoveryRequiredError(options.identity, options.stage, 'read_budget_exhausted', last);
}

export type ImageTaskSnapshot = ImageTaskIdentity & {
  state: string; pollAfterMs: number; images: string[]; failure?: string; retryAfterMs?: number | undefined;
  assets: Array<{ key: 'signed_url' | 'download_url' | 'url'; value: string }>;
};
export type ImageTaskPollOptions = {
  initial: unknown; summarize: (value: unknown) => ImageTaskSnapshot;
  read: (url: string, stage: ImageReadStage, timeoutMs: number) => Promise<unknown>;
  acquire: (snapshot: ImageTaskSnapshot, timeoutMs: number) => Promise<string[]>;
  defaultStatusUrl?: (taskId: string) => string;
  normalizeStatusUrl?: (url: string, taskId: string) => string;
  deadline: number; statusTimeoutMs?: number; resultGraceMs?: number;
  wait?: (ms: number) => Promise<unknown>; now?: () => number;
  onRetry?: ((event: ImageRetryEvent) => void) | undefined;
  onObserved?: (snapshot: ImageTaskSnapshot) => void;
};

export async function pollAcceptedImageTask(options: ImageTaskPollOptions): Promise<string[]> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const initialSnapshot = options.summarize(options.initial);
  const initialRetryAfterMs = imageRetryAfterMs(options.initial) ?? initialSnapshot.retryAfterMs;
  let snapshot = {
    ...initialSnapshot,
    ...(initialRetryAfterMs === undefined ? {} : { retryAfterMs: initialRetryAfterMs }),
  };
  const identity: ImageTaskIdentity = {
    taskId: snapshot.taskId, statusUrl: snapshot.statusUrl, resultUrl: snapshot.resultUrl,
  };
  if (!identity.statusUrl && identity.taskId) identity.statusUrl = options.defaultStatusUrl?.(identity.taskId) ?? '';
  let completedAt: number | undefined;
  let missingTaskCount = 0;
  const terminal = (state: string) => /^(?:failed|failure|error|cancelled|canceled|rejected)$/.test(state);
  const completed = (state: string) => /^(?:completed|complete|succeeded|success|finished|done)$/.test(state);
  const observe = (next: ImageTaskSnapshot) => {
    if (identity.taskId && next.taskId && next.taskId !== identity.taskId && (next.state || next.statusUrl)) {
      throw new ImageTaskRecoveryRequiredError(identity, 'status', 'task_identity_mismatch');
    }
    identity.taskId ||= next.taskId;
    identity.statusUrl = next.statusUrl || identity.statusUrl;
    identity.resultUrl = next.resultUrl || identity.resultUrl;
    if (options.normalizeStatusUrl && identity.statusUrl) {
      identity.statusUrl = options.normalizeStatusUrl(identity.statusUrl, identity.taskId);
    }
    const nextRetryAfterMs = next.retryAfterMs;
    snapshot = {
      ...next,
      ...identity,
      pollAfterMs: imagePollDelayMs({ poll_after_ms: next.pollAfterMs }),
      ...(nextRetryAfterMs === undefined ? {} : { retryAfterMs: nextRetryAfterMs }),
    };
    if (terminal(snapshot.state)) throw new ImageTaskTerminalFailureError(identity.taskId, snapshot.state,
      snapshot.failure ? new Error(snapshot.failure) : undefined);
    if (!snapshot.state && snapshot.failure && !snapshot.images.length && !snapshot.assets.length) {
      throw new ImageTaskRecoveryRequiredError(identity, 'status', 'invalid_task_read_response', new Error(snapshot.failure));
    }
    if (/^(?:uncertain|pending_confirmation|client_disconnected)$/.test(snapshot.state)) {
      throw new ImageTaskRecoveryRequiredError(identity, 'status', snapshot.state);
    }
    if (completed(snapshot.state)) completedAt ??= now();
    options.onObserved?.(snapshot);
  };
  observe(snapshot);
  const effectiveDeadline = () => Math.min(options.deadline,
    completedAt === undefined ? Infinity : completedAt + (options.resultGraceMs ?? 60_000));
  const acquire = async (): Promise<string[]> => {
    if (!snapshot.images.length && !snapshot.assets.length) return [];
    return retryImageRead(timeout => options.acquire(snapshot, timeout), {
      identity, stage: 'asset', deadline: effectiveDeadline(), timeoutMs: 45_000,
      allowNotReady: true, wait, now, onRetry: options.onRetry,
    });
  };
  const immediate = await acquire();
  if (immediate.length) return immediate;
  if (!identity.taskId && !identity.statusUrl) {
    throw new ImageTaskRecoveryRequiredError(identity, 'status', 'missing_task_receipt');
  }
  if (!identity.statusUrl) throw new ImageTaskRecoveryRequiredError(identity, 'status', 'missing_status_url');
  // One polling session, finite retries, no POST. No phase can extend the deadline.
  for (let poll = 0; poll < 500; poll += 1) {
    const delayMs = Math.max(snapshot.pollAfterMs || 2_000, snapshot.retryAfterMs ?? 0);
    if (delayMs >= effectiveDeadline() - now()) break;
    await wait(delayMs);
    const value = await retryImageRead(timeout => options.read(identity.statusUrl, 'status', timeout), {
      identity, stage: 'status', deadline: effectiveDeadline(),
      timeoutMs: options.statusTimeoutMs ?? 45_000,
      // Allow only a short replica-visibility grace after acceptance.
      allowNotReady: missingTaskCount++ < 2,
      wait, now, onRetry: options.onRetry,
    });
    const nextStatus = options.summarize(value);
    observe({ ...nextStatus, ...(imageRetryAfterMs(value) === undefined
      ? {} : { retryAfterMs: imageRetryAfterMs(value) }) });
    const images = await acquire();
    if (images.length) return images;
    // Never probe result on every queued/processing status; this used to add 45s stalls.
    if (!completed(snapshot.state) || !identity.resultUrl) continue;
    const result = await retryImageRead(timeout => options.read(identity.resultUrl, 'result', timeout), {
      identity, stage: 'result', deadline: effectiveDeadline(), timeoutMs: 45_000,
      allowNotReady: true, wait, now, onRetry: options.onRetry,
    });
    const resultSnapshot = options.summarize(result);
    const resultRetryAfterMs = imageRetryAfterMs(result) ?? resultSnapshot.retryAfterMs;
    observe({ ...resultSnapshot, state: resultSnapshot.state || snapshot.state,
      pollAfterMs: Math.max(snapshot.pollAfterMs, resultSnapshot.pollAfterMs),
      ...(resultRetryAfterMs === undefined ? {} : { retryAfterMs: resultRetryAfterMs }) });
    const resultImages = await acquire();
    if (resultImages.length) return resultImages;
    // completed without readable assets is delivery-pending, not a generation failure.
  }
  throw new ImageTaskRecoveryRequiredError(identity, completedAt === undefined ? 'status' : 'result',
    completedAt === undefined ? 'task_wait_exhausted' : 'result_not_ready');
}

/** A non-mutating scrub before a legacy image collector scans arbitrary strings. */
export function withoutImageControlFields(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (++nodes > 20_000 || depth > 64) throw new Error('Image response structure exceeds safe traversal limits');
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const out: unknown[] = []; seen.set(item, out);
      for (const child of item) out.push(walk(child, depth + 1));
      return out;
    }
    const out: Record<string, unknown> = {}; seen.set(item, out);
    const row = item as Record<string, unknown>;
    const taskEnvelope = ['task_id', 'taskId', 'status_url', 'poll_url', 'result_url'].some(key => key in row);
    for (const [key, child] of Object.entries(item)) {
      if (taskEnvelope && /^(?:message|msg|detail)$/i.test(key)) continue;
      if (/^(?:status_url|statusUrl|poll_url|pollUrl|result_url|resultUrl|error|err|errors|fail_reason|failure_reason|error_message|errorMessage|request|input|input_images|reference_images|referenceImages|prompt|negative_prompt|metadata|debug|trace|stack)$/i.test(key)) continue;
      out[key] = walk(child, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** Generic asset `id` values inside data must not be mistaken for a task ID. */
export function imageExplicitTaskId(value: unknown): string {
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number, taskContainer = false): string => {
    if (!item || typeof item !== 'object' || depth > 8 || seen.has(item)) return '';
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) { const id = walk(child, depth + 1, taskContainer); if (id) return id; }
      return '';
    }
    const row = item as Record<string, unknown>;
    const idText = (candidate: unknown): string => {
      if (typeof candidate !== 'string' && typeof candidate !== 'number') return '';
      const text = String(candidate).trim();
      return text && text.length <= 512 && !/^(?:https?:|data:)/i.test(text) ? text : '';
    };
    for (const key of ['task_id', 'taskId', 'taskid']) {
      const id = idText(row[key]); if (id) return id;
    }
    if (taskContainer || typeof row.status === 'string' || typeof row.state === 'string'
      || typeof row.status_url === 'string' || typeof row.poll_url === 'string') {
      const id = idText(row.id); if (id) return id;
    }
    for (const key of ['data', 'result', 'results', 'task', 'tasks', 'image_task', 'response', 'raw']) {
      const id = walk(row[key], depth + 1, ['task', 'tasks', 'image_task'].includes(key));
      if (id) return id;
    }
    return '';
  };
  return walk(value, 0);
}

export function isTransientImageTransferError(error: unknown): boolean {
  if (isTransientImageReadError(error)) return true;
  const row = record(error);
  if (row?.code === 'IMAGE_DOWNLOAD_TOO_LARGE' || row?.code === 'GENERATED_IMAGE_TOO_LARGE') return false;
  const message = error instanceof Error ? error.message : '';
  const status = message.match(/(?:reference image HTTP|HTTP)\s+(\d{3})/i)?.[1];
  if (status) return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
  return /(?:fetch failed|socket|connection reset|terminated|content-length mismatch)/i.test(message);
}


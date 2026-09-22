/** Safe failure summaries only. Never persist an upstream response, prompt, URL or stack. */
const KNOWN_MESSAGES: Record<string, string> = {
  IMAGE_SIZE_LIMIT: '图片字节数超过当前处理步骤允许的上限',
  IMAGE_INVALID_CONTENT: '图片结果为空、格式无效或内容不完整',
  IMAGE_RESULT_PERSISTENCE_FAILED: '图片已返回，但结果下载或持久化失败',
  PROVIDER_TIMEOUT: '等待上游响应或读取响应超时',
  NETWORK_ERROR: '访问上游或存储服务时发生网络错误',
  STORAGE_WRITE_FAILED: '本地文件或对象存储写入失败',
  PROVIDER_AUTH_FAILED: '上游鉴权失败，请检查渠道权限和密钥',
  PROVIDER_RATE_LIMITED: '上游限流或额度不足',
  PROVIDER_INVALID_REQUEST: '上游拒绝请求参数，请核对模型规格及素材要求',
  PROVIDER_SERVER_ERROR: '上游服务返回错误',
  PROVIDER_HTTP_ERROR: '上游 HTTP 请求失败',
  REQUEST_CANCELLED: '请求已取消',
  GENERATION_FAILED: '请求执行失败，未记录可安全展示的详细原因',
};
const SAFE_STAGES = new Set(['image_generation', 'text_request', 'video_task', 'result_persistence']);
const SAFE_CAUSE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENOSPC', 'EACCES', 'ENOENT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'IMAGE_PROVIDER_RESPONSE_TIMEOUT', 'IMAGE_RESULT_PERSISTENCE_FAILED',
]);

export type FailureDiagnostic = {
  version: 1;
  code: string;
  message: string;
  stage: string;
  httpStatus: number | null;
  causeCode: string | null;
  recordedAt: string;
  resolution: string | null;
};

export function buildFailureDiagnostic(
  error: unknown,
  context: { stage: string; resolution?: string | undefined },
  now = new Date(),
): FailureDiagnostic {
  // Error payloads are untrusted. Classification reads bounded text, but never returns it.
  let code = 'GENERATION_FAILED';
  let httpStatus: number | null = null;
  let causeCode: string | null = null;
  let persistence = false;
  const texts: string[] = [];
  const visited = new Set<object>();
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (typeof current === 'string') { texts.push(current.slice(0, 2_000)); break; }
      if (typeof current !== 'object' || visited.has(current)) break;
      visited.add(current);
      const value = current as Record<string, unknown>;
      if (typeof value.message === 'string') texts.push(value.message.slice(0, 2_000));
      if (typeof value.name === 'string') texts.push(value.name.slice(0, 80));
      if (typeof value.code === 'string' && SAFE_CAUSE_CODES.has(value.code)) causeCode = value.code;
      if (value.code === 'IMAGE_RESULT_PERSISTENCE_FAILED') persistence = true;
      const status = Number(value.status ?? value.statusCode);
      if (Number.isInteger(status) && status >= 400 && status <= 599) httpStatus = status;
      current = value.cause;
    }
  } catch { /* A hostile getter must not break the original release/settlement path. */ }
  const text = texts.join('\n');
  if (httpStatus === null) {
    const match = text.match(/\bHTTP\s+(4\d\d|5\d\d)\b/i);
    if (match) httpStatus = Number(match[1]);
  }
  if (/too large|size is invalid|exceeds? (?:the )?(?:size|byte)|大小超|超出.{0,8}限制/i.test(text)) code = 'IMAGE_SIZE_LIMIT';
  else if (/valid image bytes|empty image bytes|content-length mismatch|no bytes|没有返回图片数据/i.test(text)) code = 'IMAGE_INVALID_CONTENT';
  else if (/cancelled|canceled|已取消/i.test(text)) code = 'REQUEST_CANCELLED';
  else if (/timeout|timed\s*out|exceeded.{0,30}deadline|AbortError|超时/i.test(`${text} ${causeCode || ''}`)) code = 'PROVIDER_TIMEOUT';
  else if (/ENOSPC|EACCES|temporary file|file write|磁盘/i.test(`${text} ${causeCode || ''}`)) code = 'STORAGE_WRITE_FAILED';
  else if (httpStatus === 401 || httpStatus === 403) code = 'PROVIDER_AUTH_FAILED';
  else if (httpStatus === 429) code = 'PROVIDER_RATE_LIMITED';
  else if (httpStatus === 400 || httpStatus === 422) code = 'PROVIDER_INVALID_REQUEST';
  else if (httpStatus !== null && httpStatus >= 500) code = 'PROVIDER_SERVER_ERROR';
  else if (httpStatus !== null) code = 'PROVIDER_HTTP_ERROR';
  else if (/fetch failed|ECONN|EAI_AGAIN|ENOTFOUND|socket|network|网络/i.test(`${text} ${causeCode || ''}`)) code = 'NETWORK_ERROR';
  else if (persistence || /could not be persisted to object storage/i.test(text)) code = 'IMAGE_RESULT_PERSISTENCE_FAILED';
  const resolution = typeof context.resolution === 'string' && /^(?:\d{1,4}[kp]|\d{1,5}x\d{1,5})$/i.test(context.resolution.trim())
    ? context.resolution.trim() : null;
  return {
    version: 1, code, message: KNOWN_MESSAGES[code]!,
    stage: persistence ? 'result_persistence' : SAFE_STAGES.has(context.stage) ? context.stage : 'image_generation',
    httpStatus, causeCode, recordedAt: now.toISOString(), resolution,
  };
}

/** Re-validate stored JSON before returning it to an administrator. */
export function readFailureDiagnostic(value: unknown): FailureDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.code !== 'string' || !Object.hasOwn(KNOWN_MESSAGES, record.code)) return null;
  if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) return null;
  return {
    version: 1, code: record.code, message: KNOWN_MESSAGES[record.code]!,
    stage: typeof record.stage === 'string' && SAFE_STAGES.has(record.stage) ? record.stage : 'image_generation',
    recordedAt: new Date(record.recordedAt).toISOString(),
    httpStatus: typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
      && record.httpStatus >= 400 && record.httpStatus <= 599 ? record.httpStatus : null,
    causeCode: typeof record.causeCode === 'string' && SAFE_CAUSE_CODES.has(record.causeCode) ? record.causeCode : null,
    resolution: typeof record.resolution === 'string' && /^(?:\d{1,4}[kp]|\d{1,5}x\d{1,5})$/i.test(record.resolution)
      ? record.resolution : null,
  };
}

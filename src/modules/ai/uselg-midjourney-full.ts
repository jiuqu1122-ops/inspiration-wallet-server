import { genericImageRequestHeaders } from './image-adapters/generic-request-headers.js';
import { ImageAdapterError } from './image-adapters/types.js';

type Provider = { id: string; baseUrl: string };
type Route = { routeId: string; adapterKey?: string | null | undefined; upstreamModel?: string | undefined };

/** This is the supplied V8.2-full Images API contract, not the operation API.
 * Do not change another vendor, ordinary V8.2, V7, or Niji by model-family inference. */
export function isUselgMidjourneyFull(provider: Provider, route: Route | undefined): boolean {
  if (route?.adapterKey !== 'GENERIC_OPENAI_IMAGE' || route.upstreamModel?.trim() !== 'midjourney-v8.2-full') return false;
  try { return new URL(provider.baseUrl).origin === 'https://api.uselg.top'; }
  catch { return false; }
}

function invalid(message: string, endpoint?: string): never {
  throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', message, endpoint);
}

/** Unicode code points, not UTF-16 units. The upstream reserves " --v 8.2"
 * when no explicit version is supplied; never truncate a user's prompt. */
export function uselgMidjourneyFullPrompt(value: string): string {
  const prompt = value.trim();
  const versions = [...prompt.matchAll(/(?:^|\s)--(version|niji|v)(?=\s|$)(?:\s+(\S+))?/g)];
  if (versions.length > 1 || versions.some(match => match[1] === 'niji' || match[2] !== '8.2')) {
    invalid('Midjourney V8.2-full 的版本已由模型固定；提示词只允许一个一致的 --v 8.2 或 --version 8.2，不可混用 Niji 或其他版本。');
  }
  const maximum = versions.length ? 1010 : 1002;
  if (!prompt || Array.from(prompt).length > maximum) {
    invalid(`Midjourney V8.2-full 提示词最多 ${maximum} 个 Unicode 字符；请缩短提示词，不会自动截断或提交。`);
  }
  return prompt;
}

export function uselgMidjourneyFullHeaders(
  provider: Provider, input: { userId: string; clientRequestId: string }, route: Route | undefined,
) {
  if (!route || !isUselgMidjourneyFull(provider, route)) return undefined;
  return genericImageRequestHeaders(provider, input, { routeId: route.routeId, adapterKey: route.adapterKey,
    adapterConfig: { idempotencyHeader: 'Idempotency-Key' } });
}

const fields = new Set(['model', 'prompt', 'size', 'n', 'async', 'response_format', 'images', 'mj_version']);
// Compare reduced fractions; the documented 21:9 ratio reduces to 7:3.
const ratios = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '7:3']);
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

/** Validate the already-prepared JSON before the only paid POST. No endpoint,
 * version, operation, image transport, or output count is guessed or retried. */
export function validateUselgMidjourneyFullSubmission(
  provider: Provider, route: Route | undefined, endpoint: string, body: Record<string, unknown>,
) {
  if (!isUselgMidjourneyFull(provider, route)) return;
  const fail = (message: string): never => invalid(message, endpoint);
  if (body.model !== 'midjourney-v8.2-full' || body.n !== 1 || body.async !== true) {
    fail('Midjourney V8.2-full 需要 model=midjourney-v8.2-full、n=1 和 async=true，请核对模型及异步配置。');
  }
  for (const field of Object.keys(body)) {
    if (!fields.has(field)) fail(`Midjourney V8.2-full 不支持字段 ${field}；请移除旧版 operation/speed 等配置，比例通过 size 传递。`);
  }
  if (typeof body.prompt !== 'string') fail('Midjourney V8.2-full 需要文字提示词。');
  uselgMidjourneyFullPrompt(body.prompt as string);
  if (body.mj_version !== undefined && body.mj_version !== '8.2') fail('mj_version 必须为字符串 "8.2"，建议留空并直接使用固定模型版本。');
  if (body.response_format !== undefined
    && (typeof body.response_format !== 'string' || !['b64_json', 'url'].includes(body.response_format))) {
    fail('Midjourney V8.2-full response_format 只支持 b64_json 或 url。');
  }
  if (body.size !== undefined && body.size !== 'auto') {
    const match = typeof body.size === 'string' ? /^(\d{1,5})x(\d{1,5})$/.exec(body.size) : null;
    const width = Number(match?.[1]), height = Number(match?.[2]);
    if (!match || !width || !height || !ratios.has(`${width / gcd(width, height)}:${height / gcd(width, height)}`)) {
      fail('Midjourney V8.2-full size 应为 auto 或受支持比例的宽x高；不要发送 1K/2K/4K，请配置 size 的 exact 映射。');
    }
  }
  let references = 0;
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || !body.images.length || body.images.length > 5) fail('Midjourney V8.2-full 参考图数量必须为 1–5 张。');
    references = (body.images as unknown[]).length;
    for (const image of body.images as unknown[]) {
      if (!image || typeof image !== 'object' || Array.isArray(image)
        || typeof (image as Record<string, unknown>).image_url !== 'string'
        || !/^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(String((image as Record<string, unknown>).image_url))) {
        fail('Midjourney V8.2-full 参考图必须使用 images[].image_url 的完整 PNG/JPEG Data URL，不能直接发送 WebP 或素材地址。');
      }
    }
  }
  if (endpoint !== `/v1/images/${references ? 'edits' : 'generations'}`) {
    fail('Midjourney V8.2-full 文生图使用 /v1/images/generations，参考图生成使用 /v1/images/edits，请分别配置。');
  }
}

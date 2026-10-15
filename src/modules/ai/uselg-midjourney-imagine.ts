import { genericImageRequestHeaders } from './image-adapters/generic-request-headers.js';
import { ImageAdapterError, imageAdapterConfig } from './image-adapters/types.js';

type Provider = { id: string; baseUrl: string };
type Route = { routeId: string; adapterKey?: string | null | undefined; upstreamModel?: string | undefined; adapterConfig?: unknown };

/** The supplied 2026-10-13 contract is specific to this upstream, model and operation.
 * Never infer this contract for V7, another vendor, or follow-up operations. */
export function isUselgMidjourneyImagine(provider: Provider, route: Route | undefined): boolean {
  if (route?.adapterKey !== 'GENERIC_OPENAI_IMAGE' || route.upstreamModel?.trim() !== 'midjourney-v8.2') return false;
  try {
    const url = new URL(provider.baseUrl);
    if (url.origin !== 'https://api.uselg.top') return false;
  } catch { return false; }
  return imageAdapterConfig(route.adapterConfig).requestParameters?.operation === 'imagine';
}

export function uselgMidjourneyImagineHeaders(
  provider: Provider, input: { userId: string; clientRequestId: string }, route: Route | undefined,
) {
  if (!isUselgMidjourneyImagine(provider, route) || !route) return undefined;
  // This confirmed contract requires a receipt, regardless of the channel kind.
  // Reuse the existing owner/provider/route/logical-request scope, not signed URLs.
  return genericImageRequestHeaders(provider, input, {
    routeId: route.routeId, adapterKey: route.adapterKey,
    adapterConfig: { idempotencyHeader: 'Idempotency-Key' },
  });
}

const imagineFields = new Set(['model', 'operation', 'prompt', 'aspect_ratio', 'speed', 'n', 'images']);

/** Fail before the paid POST rather than guessing an alternate endpoint or serializer. */
export function validateUselgMidjourneyImagineSubmission(
  provider: Provider, route: Route | undefined, endpoint: string, body: Record<string, unknown>,
) {
  if (!isUselgMidjourneyImagine(provider, route)) return;
  const invalid = (message: string): never => { throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', message, endpoint); };
  if (endpoint !== '/v1/images/generations') {
    invalid('Midjourney V8.2 text and reference Imagine both require /v1/images/generations (not /v1/images/edits).');
  }
  if (body.model !== 'midjourney-v8.2' || body.operation !== 'imagine' || body.speed !== 'fast' || body.n !== 1) {
    invalid('Midjourney V8.2 Imagine requires model=midjourney-v8.2, operation=imagine, speed=fast and n=1.');
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) invalid('Midjourney V8.2 Imagine requires a prompt.');
  for (const key of Object.keys(body)) {
    if (!imagineFields.has(key)) invalid(`Midjourney V8.2 Imagine does not accept the configured JSON field: ${key}`);
  }
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 5) {
      invalid('Midjourney V8.2 Imagine accepts 1 to 5 reference images, or no images for text generation.');
    }
    for (const image of body.images as unknown[]) {
      if (!image || typeof image !== 'object' || Array.isArray(image)
        || typeof (image as Record<string, unknown>).image_url !== 'string'
        || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(String((image as Record<string, unknown>).image_url))) {
        invalid('Midjourney V8.2 references require images[].image_url containing a complete PNG/JPEG/WebP Data URL.');
      }
    }
  }
}

import { createHash } from 'node:crypto';

type ProviderIdentity = { id: string; baseUrl: string };
type RequestIdentity = { userId: string; clientRequestId: string };
type RouteIdentity = {
  adapterKey?: string | null | undefined;
  canonicalModelKey?: string | undefined;
  upstreamModel?: string | undefined;
};

function isAffectedRoute(provider: ProviderIdentity, route: RouteIdentity | undefined) {
  if (route?.adapterKey !== 'GENERIC_OPENAI_IMAGE') return false;
  try {
    if (new URL(provider.baseUrl).hostname.toLowerCase() !== 'api.ai-media.vip') return false;
  } catch { return false; }
  // This gateway caches completed Midjourney POST bodies. Keep the workaround
  // scoped to that confirmed provider/adapter/model family, independent of V7/V8.
  return [route.canonicalModelKey, route.upstreamModel].some(model => (
    typeof model === 'string' && /^midjourney(?:$|[\s_./:(（-])/i.test(model.trim())
  ));
}

function requestFingerprint(provider: ProviderIdentity, input: RequestIdentity) {
  return createHash('sha256').update(JSON.stringify([
    input.userId, provider.id, input.clientRequestId,
  ]), 'utf8').digest();
}

export function aiMediaMidjourneyPrompt(
  prompt: string, provider: ProviderIdentity, input: RequestIdentity, route: RouteIdentity | undefined,
) {
  if (!isAffectedRoute(provider, route) || /(?:^|\s)--seed(?:\s|=|$)/i.test(prompt)) return prompt;
  // Midjourney accepts a uint32 seed at the end of the prompt. A logical retry
  // keeps this seed; a new receipt gets a fresh body without changing user text.
  // https://docs.midjourney.com/hc/en-us/articles/32604356340877-Seeds
  return `${prompt}\n\n--seed ${requestFingerprint(provider, input).readUInt32BE(0)}`;
}

export function aiMediaMidjourneyRequestHeaders(
  provider: ProviderIdentity, input: RequestIdentity, route: RouteIdentity | undefined,
) {
  if (!isAffectedRoute(provider, route)) return undefined;
  const fingerprint = requestFingerprint(provider, input).toString('hex');
  return {
    'Idempotency-Key': fingerprint,
    'X-Request-Id': fingerprint,
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  };
}

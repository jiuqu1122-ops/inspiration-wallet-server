import { createHash } from 'node:crypto';
import { imageAdapterConfig } from './types.js';

type ProviderIdentity = { id: string };
type RequestIdentity = { userId: string; clientRequestId: string };
type RouteIdentity = {
  routeId: string;
  adapterKey?: string | null | undefined;
  adapterConfig?: unknown;
};

/** A route must explicitly confirm its upstream's idempotency header contract.
 * Reference URL signatures and request-body changes do not create a new receipt. */
export function genericImageRequestHeaders(
  provider: ProviderIdentity,
  input: RequestIdentity,
  route: RouteIdentity | undefined,
) {
  if (route?.adapterKey !== 'GENERIC_OPENAI_IMAGE'
    || imageAdapterConfig(route.adapterConfig).idempotencyHeader !== 'Idempotency-Key') return undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'generic-image-idempotency-v1', input.userId, provider.id, route.routeId, input.clientRequestId,
  ]), 'utf8').digest('hex');
  return { 'Idempotency-Key': fingerprint };
}

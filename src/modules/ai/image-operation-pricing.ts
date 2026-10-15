import { ModelCatalogError } from './model-catalog.js';

export const IMAGE_OPERATIONS = [
  'imagine', 'blend', 'describe', 'shorten', 'uploads', 'upscale', 'upscale_creative',
  'upscale_subtle', 'upscale_subtile', 'variation', 'high_variation', 'low_variation',
  'reroll', 'zoom', 'custom_zoom', 'pan', 'inpaint', 'modal',
] as const;
export const IMAGE_OPERATION_SPEEDS = ['fast', 'relax', 'turbo'] as const;
export type ImageOperation = typeof IMAGE_OPERATIONS[number];
export type ImageOperationSpeed = typeof IMAGE_OPERATION_SPEEDS[number];
export type ImageOperationCredits = Partial<Record<ImageOperation, Partial<Record<ImageOperationSpeed, string>>>>;
export type ImageOperationQuote = { operation: ImageOperation; speed: ImageOperationSpeed; credits: string };

export const isImageOperation = (value: unknown): value is ImageOperation => typeof value === 'string'
  && (IMAGE_OPERATIONS as readonly string[]).includes(value);
export const isImageOperationSpeed = (value: unknown): value is ImageOperationSpeed => typeof value === 'string'
  && (IMAGE_OPERATION_SPEEDS as readonly string[]).includes(value);

const creditPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ? value as Record<string, unknown> : null;

/** Operation prices are explicit decimal strings. A missing value is never free. */
export function normalizeImageOperationCreditAmount(value: unknown): string {
  if (typeof value !== 'string' || !creditPattern.test(value)) throw new Error('Image operation price must be a non-negative decimal string with at most six decimal places');
  const [whole, fraction = ''] = value.split('.', 2);
  return `${whole!}.${fraction.padEnd(6, '0')}`;
}

export function validateImageOperationCredits(value: unknown): ImageOperationCredits {
  const matrix = object(value);
  if (!matrix) throw new Error('Image operation prices must be an object');
  const output: ImageOperationCredits = {};
  for (const [operation, raw] of Object.entries(matrix)) {
    if (!isImageOperation(operation)) throw new Error('Unknown image operation in pricing');
    const row = object(raw);
    if (!row) throw new Error(`Image operation price speeds must be an object: ${operation}`);
    const prices: Partial<Record<ImageOperationSpeed, string>> = {};
    for (const [speed, amount] of Object.entries(row)) {
      if (!isImageOperationSpeed(speed)) throw new Error(`Unknown image operation speed in pricing: ${operation}`);
      normalizeImageOperationCreditAmount(amount);
      prices[speed] = amount as string;
    }
    output[operation] = prices;
  }
  return output;
}

/** Quote a new operation from its published tariff, without flat-price fallback. */
export function quoteImageOperation(
  profile: unknown,
  request: { operation: unknown; speed: unknown },
): ImageOperationQuote {
  const pricing = object(profile);
  if (!pricing || pricing.billingType !== 'image_flat' || !isImageOperation(request.operation) || !isImageOperationSpeed(request.speed)) {
    throw new ModelCatalogError('PRICING_NOT_AVAILABLE', 'The image operation and speed require an explicit image_flat price', 503);
  }
  let matrix: ImageOperationCredits;
  try { matrix = validateImageOperationCredits(pricing.creditsPerOperation); }
  catch { throw new ModelCatalogError('PRICING_NOT_AVAILABLE', 'Image operation pricing is unavailable or invalid', 503); }
  const amount = matrix[request.operation]?.[request.speed];
  if (amount === undefined) {
    throw new ModelCatalogError('PRICING_NOT_AVAILABLE', `Image operation price is not configured: ${request.operation}/${request.speed}`, 503);
  }
  return { operation: request.operation, speed: request.speed, credits: normalizeImageOperationCreditAmount(amount) };
}

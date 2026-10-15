import { createHash } from 'node:crypto';
import type { AiProviderChannel } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { CloudAiError } from './service.js';
import {
  IMAGE_OPERATIONS, IMAGE_OPERATION_SPEEDS, isImageOperation, isImageOperationSpeed,
  type ImageOperation, type ImageOperationSpeed,
} from './image-operation-pricing.js';

const hasControl = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
};
const identifier = z.string().min(1).max(512).refine(value => !hasControl(value));
const requestIdentifier = z.string().min(8).max(128).refine(value => !hasControl(value));
export const imageOperationInputSchema = z.object({
  userId: z.string().min(1).max(200),
  clientRequestId: requestIdentifier,
  model: z.string().trim().min(1).max(200),
  operation: z.enum(IMAGE_OPERATIONS),
  speed: z.enum(IMAGE_OPERATION_SPEEDS).optional(),
  parentClientRequestId: requestIdentifier.optional(),
  actionId: identifier.optional(),
  prompt: z.string().max(32_000).optional(),
  inputImages: z.array(z.string().min(1).max(28 * 1024 * 1024)).max(5).optional(),
  aspectRatio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).max(20).optional(),
  dimensions: z.enum(['SQUARE', 'PORTRAIT', 'LANDSCAPE']).optional(),
  zoom: z.number().min(1).max(2).optional(),
  maskBase64: z.string().max(28 * 1024 * 1024).optional(),
}).strict();
export type ImageOperationInput = z.infer<typeof imageOperationInputSchema>;
export type ImageDimensions = { width: number; height: number };
export type ImageOperationContext = {
  version: 1;
  protocol: 'GENERIC_TASK';
  providerId: string;
  routeId: string;
  submittedModel: string;
  taskId: string;
  operation: ImageOperation;
  speed: ImageOperationSpeed;
  providerConnectionFingerprint?: string;
  statusUrl?: string;
  imageDimensions?: ImageDimensions;
  originalImageDimensions?: ImageDimensions;
  parentOperation?: ImageOperation;
  parentTaskId?: string;
  parentClientRequestId?: string;
};

export const operationRecord = (value: unknown): Record<string, unknown> | undefined => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const boundedText = (value: unknown, maximum = 512) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !hasControl(value) ? value : undefined;
const dimensions = (value: unknown): ImageDimensions | undefined => {
  const row = operationRecord(value);
  return row && Number.isInteger(row.width) && Number.isInteger(row.height)
    && Number(row.width) > 0 && Number(row.height) > 0 && Number(row.width) * Number(row.height) <= 40_000_000
    ? { width: Number(row.width), height: Number(row.height) } : undefined;
};

export function imageOperationProviderFingerprint(provider: Pick<AiProviderChannel, 'baseUrl' | 'encryptedSecrets'>) {
  return createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.encryptedSecrets])).digest('hex');
}

/** Internal context is never part of the public operation projection. */
export function parseImageOperationContext(value: unknown): ImageOperationContext | undefined {
  const row = operationRecord(value);
  if (!row || row.version !== 1 || row.protocol !== 'GENERIC_TASK'
    || !boundedText(row.providerId) || !boundedText(row.routeId) || !boundedText(row.submittedModel, 200)
    || !boundedText(row.taskId) || !isImageOperation(row.operation) || !isImageOperationSpeed(row.speed)) return undefined;
  const imageDimensions = dimensions(row.imageDimensions);
  const originalImageDimensions = dimensions(row.originalImageDimensions);
  const statusUrl = boundedText(row.statusUrl, 4096);
  const parentTaskId = boundedText(row.parentTaskId);
  const parentClientRequestId = boundedText(row.parentClientRequestId, 128);
  const providerConnectionFingerprint = typeof row.providerConnectionFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(row.providerConnectionFingerprint) ? row.providerConnectionFingerprint : undefined;
  return {
    version: 1, protocol: 'GENERIC_TASK', providerId: String(row.providerId), routeId: String(row.routeId),
    submittedModel: String(row.submittedModel), taskId: String(row.taskId), operation: row.operation, speed: row.speed,
    ...(statusUrl ? { statusUrl } : {}),
    ...(providerConnectionFingerprint ? { providerConnectionFingerprint } : {}),
    ...(imageDimensions ? { imageDimensions } : {}),
    ...(originalImageDimensions ? { originalImageDimensions } : {}),
    ...(isImageOperation(row.parentOperation) ? { parentOperation: row.parentOperation } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(parentClientRequestId ? { parentClientRequestId } : {}),
  };
}

export const INITIAL_IMAGE_OPERATIONS = new Set<ImageOperation>(['imagine', 'blend', 'describe', 'shorten', 'uploads']);
export function operationValidationError(message: string): never {
  throw new CloudAiError('invalid_image_operation', message, 400);
}

/** Validate combinations before references are read, credits reserved, or POST sent. */
export function validateImageOperationInput(input: ImageOperationInput) {
  const initial = INITIAL_IMAGE_OPERATIONS.has(input.operation);
  const referenceCount = input.inputImages?.length ?? 0;
  if (initial && (input.parentClientRequestId || input.actionId)) operationValidationError('Initial operations cannot use a parent or action');
  if (!initial && (!input.parentClientRequestId || !input.actionId)) operationValidationError('This operation requires an owned parent request and an actual action');
  if (input.parentClientRequestId === input.clientRequestId) operationValidationError('A new action requires a new request ID');
  if (!initial && referenceCount) operationValidationError('Parent operations cannot replace their original image with references');
  if (input.operation === 'blend' && (referenceCount < 2 || referenceCount > 5)) operationValidationError('Blend requires two to five images');
  if (input.operation === 'describe' && referenceCount !== 1) operationValidationError('Describe requires one image');
  if (input.operation === 'uploads' && referenceCount < 1) operationValidationError('Uploads requires one to five images');
  if (input.operation === 'shorten' && referenceCount) operationValidationError('Shorten does not accept images');
  if (['imagine', 'shorten'].includes(input.operation) && !input.prompt?.trim()) operationValidationError('This operation requires a prompt');
  if (['blend', 'describe', 'uploads'].includes(input.operation) && input.prompt !== undefined) operationValidationError('This operation does not accept a prompt');
  if (input.dimensions !== undefined && input.operation !== 'blend') operationValidationError('Dimensions are only supported by blend');
  if (input.aspectRatio !== undefined && input.operation !== 'imagine') operationValidationError('Aspect ratio is only supported by imagine');
  if ((input.zoom !== undefined || input.maskBase64 !== undefined) && input.operation !== 'modal') operationValidationError('Zoom and masks belong to the second modal submission');
}

/** No URL fetch: masks must already be a complete PNG with a bounded decode. */
export async function validateImageOperationMask(value: string, expected: ImageDimensions) {
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1]!.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) operationValidationError('Mask must be a PNG Data URL of at most 20 MiB');
  const bytes = Buffer.from(match[1]!, 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString('base64') !== match[1]) operationValidationError('Mask PNG encoding is invalid');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1
      || metadata.width !== expected.width || metadata.height !== expected.height) operationValidationError('Mask dimensions must match the original result image');
    const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let white = false;
    for (let index = 0; index < data.length; index += info.channels) {
      if (data[index] !== data[index + 1] || data[index] !== data[index + 2] || data[index + 3] !== 255) operationValidationError('Mask must be fully opaque grayscale PNG');
      if (data[index] === 255) white = true;
    }
    if (!white) operationValidationError('Mask must contain a white edit area');
  } catch (error) {
    if (error instanceof CloudAiError) throw error;
    operationValidationError('Mask PNG could not be safely decoded');
  }
  return value;
}

import sharp, { type Sharp } from 'sharp';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { getImageResult, isStoredImageResultUrl } from './image-result-store.js';
import { jsonRecord, layerCreditsSchema, type LayerMode, type LayerRoute } from './layer-canvas-config.js';
import { prepareGenericImageDataUrlReference } from './seedream-references.js';

const unit = z.number().min(0).max(1);
export const selectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('point'), x: unit, y: unit }),
  z.strictObject({ kind: z.literal('rect'), x: unit, y: unit, width: unit.positive(), height: unit.positive() })
    .refine(s => s.x + s.width <= 1.00000001 && s.y + s.height <= 1.00000001),
]);
type Selection = z.infer<typeof selectionSchema>;
export const canvasLayerInput = z.strictObject({
  operation: z.enum(['split', 'edit']),
  // Older clients can still send a canonical model. New clients use server routing.
  model: z.string().trim().min(1).max(128).optional(),
  expectedCredits: layerCreditsSchema.optional(),
  image: z.union([
    z.string().max(28_000_080).regex(/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/),
    z.string().max(256).startsWith('reference-images/'),
  ]),
  selection: selectionSchema.optional(),
  prompt: z.string().trim().max(4000).default(''),
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_.:-]{8,128}$/),
}).refine(value => value.operation === 'edit' ? value.prompt.length > 0 : value.selection === undefined);
export type CanvasLayerInput = z.infer<typeof canvasLayerInput>;
const dimension = z.number().int().min(1).max(8192);
const placement = z.number().int().min(-8192).max(8192);
const opacity = z.number().min(0).max(1).default(1);
const name = z.string().trim().min(1).max(160);
const raster = z.union([
  z.string().min(1),
  z.object({ b64_json: z.string().min(1) }),
  z.object({ url: z.string().min(1) }),
  z.object({ signed_url: z.string().min(1) }).transform(({ signed_url }) => ({ url: signed_url })),
  z.object({ download_url: z.string().min(1) }).transform(({ download_url }) => ({ url: download_url })),
]);
type Raster = z.infer<typeof raster>;
const maximumRasterBytes = 20 * 1024 ** 2;
const arkInlineJpegTargetBytes = 512 * 1024;

type SourceImage = { width: number; height: number; alpha: boolean | undefined };
type RasterSize = Pick<SourceImage, 'width' | 'height'>;
type DecodedLayer = RasterSize & {
  name: string;
  image: Raster;
  x: number;
  y: number;
  opacity: number;
  rasterSize?: RasterSize;
};
type DecodedResult = { operation: 'edit'; output: Raster }
  | (RasterSize & { operation: 'split'; base: Raster; layers: DecodedLayer[] });

async function arkSplitReference(image: string) {
  if (!image.startsWith('data:image/webp;')) return image;
  return 'data:image/png;base64,' + (await canvasRaster(dataBytes(image)).png().toBuffer()).toString('base64');
}

export async function prepareArkInlineJpeg(image: string) {
  const bytes = dataBytes(image);
  if (bytes.length <= arkInlineJpegTargetBytes) return image;
  const raster = canvasRaster(bytes).timeout({ seconds: 10 });
  const { orientation } = await raster.metadata();
  // Keep the placement of every pixel and respect orientation in older inputs.
  if (orientation && orientation !== 1) return image;
  const compact = await raster.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return compact.length < bytes.length ? 'data:image/jpeg;base64,' + compact.toString('base64') : image;
}

const arkCoordinate = (value: number) => Math.min(999, Math.max(0, Math.round(value * 1000)));

function arkEditPrompt(prompt: string, selection?: Selection) {
  if (!selection) return prompt;
  if (selection.kind === 'point') {
    return `${prompt}\n目标位置：图1<point>${arkCoordinate(selection.x)} ${arkCoordinate(selection.y)}</point>。`;
  }
  // Even a very small selection must enclose at least one coordinate unit.
  const left = Math.min(998, arkCoordinate(selection.x));
  const top = Math.min(998, arkCoordinate(selection.y));
  const right = Math.max(left + 1, arkCoordinate(selection.x + selection.width));
  const bottom = Math.max(top + 1, arkCoordinate(selection.y + selection.height));
  return `${prompt}\n目标区域：图1<bbox>${left} ${top} ${right} ${bottom}</bbox>。`;
}

function isArkSeedream55(upstreamModel: string, canonicalModelKey: string) {
  const officialModel = /^doubao-seedream-5-5(?:-\d{6})?$/i;
  if (/^doubao-seedream-/i.test(upstreamModel)) return officialModel.test(upstreamModel);
  return officialModel.test(canonicalModelKey) || /^seedream-5[.-]5$/i.test(canonicalModelKey);
}

export async function layerUpstreamBody(
  adapter: LayerRoute['adapter'], input: CanvasLayerInput, model: string, source: SourceImage,
  { maxLayers, canonicalModelKey }: { maxLayers: number; canonicalModelKey: string },
) {
  const { operation, image, prompt, selection } = input;
  const { width, height } = source;
  if (adapter === 'canvas-json') return { operation, model, image, prompt, selection };
  if (adapter === 'volcengine-ark') {
    // URL responses keep a multi-layer result out of the single JSON body limit.
    const fields = { model, output_format: 'png', response_format: 'url', watermark: false };
    if (operation === 'split') return { ...fields, layer_decomposition: true, size: 'auto',
      image: await arkSplitReference(image), ...(prompt ? { prompt } : {}),
      ...(isArkSeedream55(model, canonicalModelKey) ? { layer_decomposition_options: { max_images: maxLayers + 1 } } : {}) };
    const exactSizeSupported = width * height >= 921_600 && width * height <= 4_624_220
      && width / height >= 1 / 16 && width / height <= 16;
    const transparent = source.alpha && !(await sharp(dataBytes(image), { limitInputPixels: 64_000_000 }).stats()).isOpaque;
    return { ...fields, image, prompt: arkEditPrompt(prompt, selection),
      ...(exactSizeSupported ? { size: `${width}x${height}` } : {}),
      ...(transparent ? { background: 'transparent' } : {}) };
  }
  const pixels = (s: Selection) => s.kind === 'point'
    ? [Math.min(width - 1, Math.floor(s.x * width)), Math.min(height - 1, Math.floor(s.y * height))]
    : [Math.floor(s.x * width), Math.floor(s.y * height),
      Math.min(width, Math.ceil((s.x + s.width) * width)), Math.min(height, Math.ceil((s.y + s.height) * height))];
  if (adapter === 'pixel-json') return { action: operation === 'split' ? 'decompose' : 'retouch',
    model_id: model, input_image: image, instructions: prompt,
    ...(selection ? { region_pixels: pixels(selection), region_kind: selection.kind } : {}) };
  const region = selection ? (selection.kind === 'point' ? 'Point' : 'Rectangle [left, top, right, bottom]') + ' at ' + pixels(selection).join(', ') : '';
  return { model, image, prompt: region ? `${prompt}\nSelection guidance on the ${width}×${height} input: ${region}.` : prompt,
    n: 1, response_format: 'b64_json' };
}

function arkOutputSize(size: string) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  return { width: dimension.parse(Number(match?.[1])), height: dimension.parse(Number(match?.[2])) };
}

function decodeArkSplit(data: unknown, maxLayers: number) {
  const item = z.object({
    size: z.string(), z_index: z.number().int().nonnegative(), name: z.string().optional(),
    url: z.string().optional(), b64_json: z.string().optional(),
    bounding_box: z.object({ absolute: z.tuple([placement, placement, placement, placement]) }).optional(),
  });
  const outputs = z.array(item).min(2).max(maxLayers + 1).parse(data)
    .sort((a, b) => a.z_index - b.z_index);
  const [base, ...layers] = outputs;
  if (base?.z_index !== 0 || new Set(outputs.map(entry => entry.z_index)).size !== outputs.length) {
    throw new Error('Invalid Ark layer order');
  }
  return { operation: 'split' as const, ...arkOutputSize(base.size), base: raster.parse(base),
    layers: layers.map(entry => {
      if (!entry.bounding_box) throw new Error('Ark layer is missing its position');
      const [x, y, right, bottom] = entry.bounding_box.absolute;
      return { name: entry.name?.trim().slice(0, 160) || `图层 ${entry.z_index}`, image: raster.parse(entry), x, y,
        width: dimension.parse(right - x), height: dimension.parse(bottom - y),
        rasterSize: arkOutputSize(entry.size), opacity: 1 };
    }),
  };
}

export function canvasLayerEditOutput(adapter: LayerRoute['adapter'], raw: unknown): Raster | undefined {
  const root = jsonRecord(raw);
  const preferred = adapter === 'pixel-json' ? jsonRecord(root.result).output : jsonRecord(root.data).image;
  const imageList: unknown = Array.isArray(root.data) && root.data.length === 1 ? root.data[0] : undefined;
  const decoded = raster.safeParse(preferred ?? imageList);
  return decoded.success ? decoded.data : undefined;
}

function decodeResponse(adapter: LayerRoute['adapter'], operation: LayerMode, raw: unknown, maxLayers: number): DecodedResult {
  const root = jsonRecord(raw);
  if (operation === 'edit') {
    const output = canvasLayerEditOutput(adapter, raw);
    if (!output) throw new Error('No image was found in the canvas edit response');
    return { operation, output };
  }
  if (adapter === 'volcengine-ark') return decodeArkSplit(root.data, maxLayers);
  if (adapter === 'pixel-json') {
    const result = z.object({ width: dimension, height: dimension, background: raster,
      layers: z.array(z.object({ title: name, file: raster, bounds: z.tuple([placement, placement, dimension, dimension]), opacity })).min(1).max(maxLayers),
    }).parse(root.result);
    return { operation, width: result.width, height: result.height, base: result.background,
      layers: result.layers.map(({ title, file, bounds: [x, y, width, height], opacity }) =>
        ({ name: title, image: file, x, y, width, height, opacity })) };
  }
  const result = z.object({ canvas: z.object({ width: dimension, height: dimension, base: raster }),
    layers: z.array(z.object({ name, image: raster, x: placement, y: placement, width: dimension, height: dimension, opacity,
      z: z.number().int().optional() })).min(1).max(maxLayers),
  }).parse(root.data);
  return { operation, ...result.canvas, layers: result.layers.slice().sort((a,b) => (a.z ?? 0) - (b.z ?? 0)) };
}

const dataBytes = (source: string) => {
  const match = /^data:image\/(?:png|jpe?g|webp);base64,([a-zA-Z0-9+/]+={0,2})$/i.exec(source);
  if (!match) throw new Error('Invalid image encoding');
  const bytes = Buffer.from(match[1]!, 'base64');
  if (!bytes.length || bytes.length > maximumRasterBytes || bytes.toString('base64') !== match[1]) throw new Error('Invalid image bytes');
  return bytes;
};
function canvasRaster(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: 64_000_000, failOn: 'warning' });
}
async function canvasRasterDimensions(image: Sharp) {
  const info = await image.metadata();
  if (!info.width || !info.height || !['png', 'jpeg', 'webp'].includes(info.format ?? '') || (info.pages ?? 1) > 1
    || info.width > 8192 || info.height > 8192) throw new Error('Unsupported image dimensions or format');
  return { width: info.width, height: info.height, alpha: info.hasAlpha };
}
export function canvasSourceDimensions(source: string) {
  return canvasRasterDimensions(canvasRaster(dataBytes(source)));
}

export async function canvasResultBytes(source: string) {
  if (isStoredImageResultUrl(source)) {
    const cached = await getImageResult(new URL(source).pathname.split('/').at(-1)!);
    if (!cached) throw new Error('Cached image result is missing or expired');
    if (cached.size > maximumRasterBytes) throw new Error('Cached image result is too large');
    return readFile(cached.path);
  }
  const dataUrl = /^https:\/\//i.test(source) ? (await prepareGenericImageDataUrlReference(source)).value
    : source.startsWith('data:') ? source : 'data:image/png;base64,' + source;
  return dataBytes(dataUrl);
}

type ReadLayerAsset = (source: string) => Promise<Buffer>;

async function normalizeRaster(value: Raster, remainingPixels: number, expected?: RasterSize, resize?: RasterSize,
  readAsset?: ReadLayerAsset) {
  const source = typeof value === 'string' ? value : 'url' in value ? value.url : value.b64_json;
  const image = canvasRaster(await (readAsset ?? canvasResultBytes)(source));
  const dimensions = await canvasRasterDimensions(image);
  const originalPixels = dimensions.width * dimensions.height;
  const output = resize ?? dimensions;
  const budgetPixels = Math.max(originalPixels, output.width * output.height);
  if (budgetPixels > remainingPixels
    || expected && (dimensions.width !== expected.width || dimensions.height !== expected.height)) throw new Error('Invalid result dimensions or configured output budget exceeded');
  if (resize && (resize.width !== dimensions.width || resize.height !== dimensions.height)) {
    image.resize(resize.width, resize.height, { fit: 'fill' });
  }
  const bytes = await image.png().toBuffer();
  const transparent = dimensions.alpha && !(await sharp(bytes).stats()).isOpaque;
  return { width: output.width, height: output.height, alpha: dimensions.alpha, transparent, originalPixels, budgetPixels,
    dataUrl: 'data:image/png;base64,' + bytes.toString('base64') };
}

export async function decodeCanvasLayerResult(config: LayerRoute, operation: LayerMode, reply: unknown, readAsset?: ReadLayerAsset) {
  const decoded = decodeResponse(config.adapter, operation, reply, config.maxLayers);
  let pixels = 0;
  let usedBudgetPixels = 0;
  const assets: string[] = [];
  const read = async (raster: Raster, dimensions?: RasterSize, resize?: RasterSize) => {
    const { dataUrl, originalPixels, budgetPixels, ...meta } = await normalizeRaster(raster,
      config.maxMegapixels * 1_000_000 - usedBudgetPixels, dimensions, resize, readAsset);
    pixels += originalPixels;
    usedBudgetPixels += budgetPixels;
    assets.push(dataUrl);
    return meta;
  };
  if (decoded.operation === 'edit') {
    const image = await read(decoded.output);
    return { assets, pixels, structure: { operation, image: { ...image, asset: 0 } } };
  }
  const base = await read(decoded.base, decoded);
  const layers = [];
  for (const [index, layer] of decoded.layers.entries()) {
    if (layer.x >= decoded.width || layer.y >= decoded.height || layer.x + layer.width <= 0 || layer.y + layer.height <= 0) {
      throw new Error('A returned layer falls outside the canvas');
    }
    // Ark sends cropped rasters whose resolutions may differ from their placement bounds.
    const image = layer.rasterSize ? await read(layer.image, layer.rasterSize, layer) : await read(layer.image, layer);
    if (!image.alpha) throw new Error('A returned layer is missing its alpha channel');
    layers.push({ ...image, asset: index + 1, id: 'layer-' + index, name: layer.name,
      x: layer.x, y: layer.y, order: index, opacity: layer.opacity });
  }
  return { assets, pixels, structure: { operation, width: decoded.width, height: decoded.height, base: { ...base, asset: 0 }, layers } };
}

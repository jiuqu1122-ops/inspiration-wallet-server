import { z } from 'zod';
import { storageService } from '../storage/service.js';
import { createImageResultFromResponse, getImageResult, isStoredImageResultUrl } from './image-result-store.js';
import type { ResolveSplitRaster } from './layer-canvas-adapters.js';

const pixels = z.number().int().positive().max(64_000_000);
const keyOf = (url: string) => new URL(url).pathname.split('/').at(-1)!;
const entry = z.object({
  raster: z.object({
    asset: z.string().refine(url => isStoredImageResultUrl(url)),
    width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
    alpha: z.boolean(), transparent: z.boolean(), originalPixels: pixels, budgetPixels: pixels,
  }).refine(r => r.budgetPixels === Math.max(r.originalPixels, r.width * r.height)),
  uploaded: z.boolean(),
});

export class ArkSplitAssets {
  readonly entries: z.infer<typeof entry>[];

  constructor(stored: unknown) {
    const parsed = z.array(entry).max(65).safeParse(stored);
    this.entries = parsed.success ? parsed.data : [];
  }

  async resolve(index: number, decode: Parameters<ResolveSplitRaster>[1], checkpoint: () => Promise<void>) {
    let saved = this.entries[index];
    if (saved?.uploaded) return saved.raster;

    const local = saved && await getImageResult(keyOf(saved.raster.asset));
    let source: Buffer | string | undefined = local?.path;
    // The worker can restart after PUT succeeds but before the receipt is updated.
    if (!saved || (!local && !await storageService.exists('generated-images/' + keyOf(saved.raster.asset)))) {
      const { bytes, ...meta } = await decode();
      const asset = await createImageResultFromResponse(new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } }));
      saved = { raster: { ...meta, asset }, uploaded: false };
      this.entries[index] = saved;
      source = bytes;
      await checkpoint();
    }
    if (source) {
      await storageService.uploadMedia({ namespace: 'generated-images', filename: keyOf(saved.raster.asset), mime: 'image/png', source });
    }
    saved.uploaded = true;
    await checkpoint();
    return saved.raster;
  }
}

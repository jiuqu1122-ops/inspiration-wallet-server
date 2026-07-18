import { describe, expect, it } from 'vitest';
import { createImageReference, getImageReference } from '../src/modules/ai/reference-store.js';

describe('temporary image reference store', () => {
  it('serves opaque image references from memory and expires them', () => {
    const bytes = Buffer.from('image-bytes');
    const url = createImageReference(bytes, 'image/png');
    const key = new URL(url).pathname.split('/').pop()!;
    expect(key).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(getImageReference(key)).toMatchObject({ mime: 'image/png', bytes });
    expect(getImageReference(key, Date.now() + 21 * 60_000)).toBeNull();
  });
});

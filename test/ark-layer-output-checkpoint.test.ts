import { expect, it } from 'vitest';
import {
  openArkLayerOutputCheckpoint,
  sealArkLayerOutputCheckpoint,
} from '../src/modules/ai/ark-layer-output-checkpoint.js';

const identity = { requestId: 'request-12', userId: 'user-34' };
const now = 1_795_280_422_000;
const limits = { maxLayers: 4, maxMegapixels: 16 };
const base = { size: '800x600', url: 'https://assets.example.test/background.png?signature=base', z_index: 0 };
const foreground = {
  size: '240x180', url: 'https://assets.example.test/foreground.png?signature=front', z_index: 1,
  name: '  Foreground  ', bounding_box: { absolute: [10, 20, 250, 200], normalized: [0, 0, 1, 1] },
};

it('stores only the encrypted layer metadata and the original limits needed for retrieval', () => {
  const reply = { data: [foreground, { ...base, unexpected: 'discard' }], unrelated: 'discard' };
  const sealed = sealArkLayerOutputCheckpoint(identity, reply, limits, now);
  expect(sealed).toBeTruthy();
  expect(sealed).not.toContain('assets.example.test');
  expect(sealed).not.toContain('signature');
  expect(sealArkLayerOutputCheckpoint(identity, reply, limits, now)).not.toEqual(sealed);
  expect(openArkLayerOutputCheckpoint(identity, sealed!, now + 1_000)).toEqual({
    expiresAt: now + 30 * 60_000,
    limits,
    reply: { data: [{ ...foreground, name: 'Foreground', bounding_box: { absolute: [10, 20, 250, 200] } }, base] },
  });
});

it('rejects another user or task, expired receipts, and changed ciphertext', () => {
  const sealed = sealArkLayerOutputCheckpoint(identity, { data: [base, foreground] }, limits, now)!;
  const [version, iv, tag, ciphertext] = sealed.split('.');
  const altered = (ciphertext!.startsWith('a') ? 'b' : 'a') + ciphertext!.slice(1);
  expect(openArkLayerOutputCheckpoint({ ...identity, requestId: 'different-request' }, sealed, now)).toBeNull();
  expect(openArkLayerOutputCheckpoint({ ...identity, userId: 'different-user' }, sealed, now)).toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, sealed, now + 30 * 60_000 - 1)).not.toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, sealed, now + 30 * 60_000)).toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, [version, iv, tag, altered].join('.'), now)).toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, sealed + '.extra', now)).toBeNull();
});

it.each([
  ['unsecured URL', { url: 'http://assets.example.test/foreground.png' }],
  ['own hostname', { url: 'https://api.example.test/foreground.png' }],
  ['private IP', { url: 'https://127.0.0.1/foreground.png' }],
  ['URL credentials', { url: 'https://user:pass@assets.example.test/foreground.png' }],
  ['oversized URL', { url: `https://assets.example.test/${'x'.repeat(4096)}` }],
  ['inline payload', { url: undefined, b64_json: 'aW1hZ2U=' }],
  ['invalid dimensions', { size: '0x600' }],
  ['duplicate index', { z_index: 0 }],
  ['missing coordinates', { bounding_box: undefined }],
  ['invalid coordinates', { bounding_box: { absolute: [10, 20, 5, 200] } }],
] as const)('rejects %s in a checkpoint', (_reason, fields) => {
  expect(sealArkLayerOutputCheckpoint(identity, { data: [base, { ...foreground, ...fields }] }, limits, now)).toBeNull();
});

it('rejects output with more layers than the captured limit', () => {
  const reply = { data: [base, foreground, { ...foreground, z_index: 2 }] };
  expect(sealArkLayerOutputCheckpoint(identity, reply, { ...limits, maxLayers: 1 }, now)).toBeNull();
});

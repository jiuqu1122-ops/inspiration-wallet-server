import { createCipheriv, randomBytes } from 'node:crypto';
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
    expiresAt: now + 90 * 60_000,
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
  expect(openArkLayerOutputCheckpoint(identity, sealed, now + 90 * 60_000 - 1)).not.toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, sealed, now + 90 * 60_000)).toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, [version, iv, tag, altered].join('.'), now)).toBeNull();
  expect(openArkLayerOutputCheckpoint(identity, sealed + '.extra', now)).toBeNull();
});

it.each([9, 30])('honors the original %i-minute expiry of a previously sealed receipt', minutes => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.PROVIDER_SECRETS_ENCRYPTION_KEY!, 'base64'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['ark-layer-output-checkpoint', 'v1', identity.userId, identity.requestId])));
  const expiry = now + minutes * 60_000;
  const payload = { expiresAt: now + 9 * 60_000, ...(minutes === 30 ? { downloadUntil: expiry } : {}), reply: { data: [base, foreground] }, limits };
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const sealed = ['v1', ...[iv, cipher.getAuthTag(), bytes].map(buffer => buffer.toString('base64url'))].join('.');
  expect(openArkLayerOutputCheckpoint(identity, sealed, expiry - 1)?.expiresAt).toBe(expiry);
  expect(openArkLayerOutputCheckpoint(identity, sealed, expiry)).toBeNull();
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

import { describe, expect, it } from 'vitest';
import { extractImageTaskMetadata, mergeImageTaskMetadata, projectImageTaskMetadata, type ImageTaskMetadata } from '../src/modules/ai/image-task-metadata.js';

describe('bounded task metadata projection', () => {
  it('extracts documented nested actions and top-level expiry without copying raw provider data', () => {
    expect(extractImageTaskMetadata({ task_id: 'accepted-task', expires_at: '2030-01-01T00:00:00Z', raw_secret: 'never-public',
      midjourney: { operation: 'imagine', speed: 'fast', requires_modal: true, parent_task_id: 'parent',
        actions: [{ action_id: 'opaque-action', label: 'U1', operation: 'upscale', requires_prompt: false, requires_mask: true,
          url: 'https://private.example/signed', raw: { api_key: 'never-public' } }] } }, 'accepted-task'))
      .toEqual({ version: 1, taskId: 'accepted-task', operation: 'imagine', speed: 'fast', requiresModal: true, parentTaskId: 'parent',
        expiresAt: '2030-01-01T00:00:00Z', actions: [{ actionId: 'opaque-action', label: 'U1', operation: 'upscale', requiresPrompt: false, requiresMask: true }] });
  });

  it('retains bounded opaque IDs and fields intact, dropping oversized items rather than truncating identity', () => {
    const actionId = 'a'.repeat(512);
    const metadata = extractImageTaskMetadata({ task_id: 't'.repeat(512), midjourney: { operation: 'o'.repeat(64), speed: 's'.repeat(64),
      actions: [{ action_id: actionId, operation: 'upscale', label: 'l'.repeat(200) }, { action_id: 'b'.repeat(513), operation: 'upscale' }] } }, 't'.repeat(512));
    expect(metadata).toMatchObject({ taskId: 't'.repeat(512), operation: 'o'.repeat(64), speed: 's'.repeat(64),
      actions: [{ actionId, operation: 'upscale', label: 'l'.repeat(200) }] });
    expect(metadata?.actions).toHaveLength(1);
    expect(extractImageTaskMetadata({ task_id: 't'.repeat(513), actions: [] }, 't'.repeat(513))).toBeUndefined();
  });

  it('drops invalid, duplicate, credential-like and URL-valued action identities while keeping valid booleans', () => {
    const metadata = extractImageTaskMetadata({ task_id: 'accepted-task', midjourney: { actions: [
      null, { action_id: 'missing-operation' }, { operation: 'missing-id' },
      { action_id: 'https://private.example/signed', operation: 'upscale' }, { action_id: 'api_key=canary', operation: 'upscale' },
      { action_id: 'control\ncharacters', operation: 'upscale' },
      { action_id: 'valid', operation: 'upscale', requires_prompt: false, requires_mask: 'true' },
      { action_id: 'valid', operation: 'variation' },
    ] } }, 'accepted-task');
    expect(metadata?.actions).toEqual([{ actionId: 'valid', operation: 'upscale', requiresPrompt: false }]);
  });

  it('rejects a foreign root task and skips nested metadata explicitly bound to another task', () => {
    expect(extractImageTaskMetadata({ task_id: 'foreign-task', midjourney: { actions: [{ action_id: 'foreign-action', operation: 'upscale' }] } }, 'accepted-task')).toBeUndefined();
    const metadata = extractImageTaskMetadata({ task_id: 'accepted-task', operation: 'imagine',
      midjourney: { task_id: 'foreign-task', actions: [{ action_id: 'foreign-action', operation: 'upscale' }] } }, 'accepted-task');
    expect(metadata).toEqual({ version: 1, taskId: 'accepted-task', operation: 'imagine', actions: [] });
  });

  it('reprojects only known version-one public fields from stored JSON', () => {
    expect(projectImageTaskMetadata({ version: 1, taskId: 'accepted-task', operation: 'imagine', requiresModal: false,
      actions: [{ actionId: 'valid', operation: 'upscale', raw: { api_key: 'canary' } }], providerKey: 'canary', statusUrl: 'https://private.example' }))
      .toEqual({ version: 1, taskId: 'accepted-task', operation: 'imagine', requiresModal: false, actions: [{ actionId: 'valid', operation: 'upscale' }] });
    expect(projectImageTaskMetadata({ version: 2, taskId: 'accepted-task', actions: [] })).toBeUndefined();
    expect(projectImageTaskMetadata({ version: 1, taskId: {}, actions: [] })).toBeUndefined();
  });

  it('merges the same task without losing prior actions when an image-only response omits them', () => {
    const previous: ImageTaskMetadata = { version: 1, taskId: 'accepted-task', operation: 'imagine', speed: 'fast',
      actions: [{ actionId: 'old-action', operation: 'upscale' }] };
    const imageOnly: ImageTaskMetadata = { version: 1, taskId: 'accepted-task', actions: [] };
    expect(mergeImageTaskMetadata(previous, imageOnly)).toEqual(previous);
    const replacement: ImageTaskMetadata = { version: 1, taskId: 'accepted-task', requiresModal: false,
      actions: [{ actionId: 'new-action', operation: 'variation' }] };
    expect(mergeImageTaskMetadata(previous, replacement)).toEqual({ ...previous, ...replacement });
    expect(mergeImageTaskMetadata(previous, { ...replacement, taskId: 'foreign-task' })).toEqual(previous);
  });
});

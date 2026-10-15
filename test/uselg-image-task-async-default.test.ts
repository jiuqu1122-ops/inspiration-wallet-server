import { describe, expect, it } from 'vitest';
import { isGptImage25Identity, normalizeImageTaskExecutionConfig } from '../src/modules/ai/image-execution.js';

const task = { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations' };
const image25 = { modelIdentities: ['gpt-image-2.5'] };

describe('USELG standard Images API task async defaults', () => {
  it.each(['/v1/images/generations', '/v1/images/edits'])('defaults %s to async=true without changing the saved config', (submitEndpoint) => {
    const source = { ...task, submitEndpoint };
    const config = normalizeImageTaskExecutionConfig(source, image25);
    expect(config).toMatchObject({ submitEndpoint, asyncParameterName: 'async', asyncParameterValue: true,
      submitTimeoutMs: 60_000, statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary' });
    expect(source).toEqual({ ...task, submitEndpoint });
    expect(normalizeImageTaskExecutionConfig(config)).toEqual(config);
  });

  it.each([
    { asyncParameterName: 'async', asyncParameterValue: false },
    { asyncParameterName: 'async_mode', asyncParameterValue: false },
    { asyncParameterName: 'async_mode', asyncParameterValue: 'queued' },
  ])('preserves the explicit parameter contract $asyncParameterName=$asyncParameterValue', (parameters) => {
    expect(normalizeImageTaskExecutionConfig({ ...task, ...parameters }, image25)).toMatchObject(parameters);
  });

  it('preserves an explicit false value on the known implicit async parameter', () => {
    expect(normalizeImageTaskExecutionConfig({ ...task, asyncParameterValue: false }, image25))
      .toMatchObject({ asyncParameterName: 'async', asyncParameterValue: false });
  });

  it('honors explicitly supplied caller defaults before the protocol default', () => {
    expect(normalizeImageTaskExecutionConfig(task, { ...image25, asyncParameterName: 'run_async' }))
      .toMatchObject({ asyncParameterName: 'run_async', asyncParameterValue: true });
  });

  it.each([
    { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations' },
    { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/edits' },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/custom/image-tasks' },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations/custom' },
    { profile: 'USELG_IMAGE_TASK', submitEndpoint: '/v1/images/generations?mode=custom' },
  ])('does not guess an async parameter for $profile $submitEndpoint', (source) => {
    const config = normalizeImageTaskExecutionConfig({ ...source, statusEndpointTemplate: '/tasks/{taskId}' }, image25);
    expect(config).not.toHaveProperty('asyncParameterName');
    expect(config).not.toHaveProperty('asyncParameterValue');
  });

  it.each([
    { ...task, asyncParameterName: '' },
    { ...task, asyncParameterName: 'bad name' },
    { ...task, submitTimeoutMs: 10_000 },
    { ...task, submitEndpoint: '/v1beta/models/image:generateContent' },
    { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', asyncParameterValue: false, statusEndpointTemplate: '/tasks/{taskId}' },
  ])('keeps invalid explicit configuration rejected: %j', (source) => {
    expect(() => normalizeImageTaskExecutionConfig(source, image25)).toThrow();
  });

  it.each(['gpt-image-2.5', 'GPT_Image_2_5-high', 'Image 2.5', 'image-2-5-fixture'])('recognizes the bounded Image 2.5 identity %s', (identity) => {
    expect(isGptImage25Identity(null, undefined, identity)).toBe(true);
  });

  it.each([undefined, 'gpt-image-2', 'gpt-image-1', 'nano-banana-2', 'seedream-4.5', 'midjourney-v7', 'not-gpt-image-2.5'])('does not change implicit task parameters for another or unspecified identity: %s', (identity) => {
    expect(isGptImage25Identity(identity)).toBe(false);
    const defaults = identity === undefined ? {} : { modelIdentities: [identity] };
    const config = normalizeImageTaskExecutionConfig(task, defaults);
    expect(config).not.toHaveProperty('asyncParameterName');
    expect(config).not.toHaveProperty('asyncParameterValue');
    const explicit = { ...task, asyncParameterName: 'run_async', asyncParameterValue: false };
    expect(normalizeImageTaskExecutionConfig(explicit, defaults)).toMatchObject(explicit);
  });
});

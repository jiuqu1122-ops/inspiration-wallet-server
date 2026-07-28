import { describe, expect, it } from 'vitest';
import {
  classifyInspirationPayload,
  validateInspirationSubmission,
} from '../src/modules/inspiration-space/service.js';

const fakePng = 'data:image/png;base64,SGVsbG8=';
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZTKsAAAAASUVORK5CYII=';

describe('inspiration space payload validation', () => {
  it('recognizes node presets, workflows, and workflow instances', () => {
    expect(classifyInspirationPayload({ label: '质感增强', prompt: '增强材质细节' }))
      .toEqual(['NODE_PRESET']);
    expect(classifyInspirationPayload({ label: '产品展示', nodes: [] }))
      .toEqual(['WORKFLOW']);
    expect(classifyInspirationPayload({
      type: 'inspiration-drawer-workflow-instance',
      workflow: { label: '带图工作流', nodes: [] },
      runtime: {},
    })).toEqual(['WORKFLOW']);
  });

  it('recognizes exported preset and workflow containers', () => {
    expect(classifyInspirationPayload({
      presets: [{ label: '节点预设', prompt: '测试' }],
      workflows: [{ label: '工作流', nodes: [] }],
    })).toEqual(['NODE_PRESET', 'WORKFLOW']);
  });

  it('rejects a mismatched declared kind', () => {
    expect(() => validateInspirationSubmission({
      kind: 'NODE_PRESET',
      payload: { label: '工作流', nodes: [] },
      previews: [],
    })).toThrow(/does not match/i);
  });

  it('checks preview content instead of trusting its data URL mime', () => {
    expect(() => validateInspirationSubmission({
      kind: 'NODE_PRESET',
      payload: { label: '节点预设', prompt: '测试' },
      previews: [{ dataUrl: fakePng, width: 1, height: 1 }],
    })).toThrow(/does not match/i);
  });

  it('accepts a valid compressed preview image', () => {
    expect(() => validateInspirationSubmission({
      kind: 'NODE_PRESET',
      payload: { label: '节点预设', prompt: '测试' },
      previews: [{ dataUrl: onePixelPng, width: 1, height: 1 }],
    })).not.toThrow();
  });
});

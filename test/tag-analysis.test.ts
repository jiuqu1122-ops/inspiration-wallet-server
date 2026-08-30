import { describe, expect, it } from 'vitest';
import { MIN_AI_IMAGE_TAGS, normalizeImageTagAnalysis } from '../src/modules/ai/tag-analysis.js';

describe('AI image tag normalization', () => {
  it('normalizes aliases, removes forbidden tags, and keeps the strongest duplicate', () => {
    const result = normalizeImageTagAnalysis({
      tags: [
        { name: '极简风', category: '风格', confidence: 0.72 },
        { name: 'minimalism', category: 'style', confidence: 0.91 },
        { name: '漂亮', category: '风格', confidence: 0.99 },
        { name: '金属材质', category: '材质', confidence: 0.82 },
        { name: 'black', category: '颜色', confidence: 0.77 },
      ],
      description: '  一款 极简 电子产品  ',
      objects: ['桌面音响'],
    }, { itemId: 'asset-1' });

    expect(result.tags).toEqual(expect.arrayContaining([
      { name: '极简主义', category: '风格', confidence: 0.91 },
      { name: '金属', category: '材质', confidence: 0.82 },
      { name: '黑色', category: '色彩', confidence: 0.77 },
      { name: '桌面音响', category: '产品类别', confidence: 0.7 },
    ]));
    expect(result.tags.some((tag) => tag.name === '漂亮')).toBe(false);
    expect(result.profile).toMatchObject({ itemId: 'asset-1', summary: '一款 极简 电子产品', aiTags: result.tags });
  });

  it('does not erase user tags or notes when rebuilding the compatibility profile', () => {
    const result = normalizeImageTagAnalysis({
      tags: [{ name: '工业风', category: '风格', confidence: 0.9 }],
      description: '工业风灯具',
    }, { itemId: 'asset-2', userTags: ['收藏'], userNotes: ['保留旋钮细节'] });

    expect(result.profile).toMatchObject({ userTags: ['收藏'], userNotes: ['保留旋钮细节'] });
  });

  it('fills sparse high-confidence tags from other structured analysis results', () => {
    const result = normalizeImageTagAnalysis({
      tags: [
        { name: '桌面音响', category: '产品类别', confidence: 0.92 },
        { name: '工业设计', category: '设计领域', confidence: 0.52 },
      ],
      description: '黑色金属机身，采用圆角和极简风格，适合桌面场景。',
      colors: ['黑色'],
      cmf: { materials: ['金属'], finishes: ['哑光'] },
      form: { silhouette: ['圆角矩形'], geometry: [], proportion: [] },
      style: ['极简主义'],
      scene: ['桌面场景'],
    }, { itemId: 'asset-sparse' });

    expect(result.tags.length).toBeGreaterThanOrEqual(MIN_AI_IMAGE_TAGS);
    expect(result.tags.map((tag) => tag.name)).toEqual(expect.arrayContaining([
      '桌面音响',
      '黑色',
      '金属',
      '圆角矩形',
      '极简主义',
    ]));
  });

  it('uses valid low-confidence model tags only when needed to reach five', () => {
    const result = normalizeImageTagAnalysis({
      tags: [
        { name: '键盘', category: '产品类别', confidence: 0.93 },
        { name: '黑色', category: '色彩', confidence: 0.83 },
        { name: '塑料', category: '材质', confidence: 0.61 },
        { name: '圆角', category: '形态', confidence: 0.55 },
        { name: '科技感', category: '风格', confidence: 0.48 },
        { name: '漂亮', category: '风格', confidence: 0.99 },
      ],
    }, { itemId: 'asset-low-confidence' });

    expect(result.tags).toHaveLength(MIN_AI_IMAGE_TAGS);
    expect(result.tags.some((tag) => tag.name === '漂亮')).toBe(false);
    expect(result.tags.map((tag) => tag.name)).toEqual(expect.arrayContaining([
      '键盘', '黑色', '塑料', '圆角', '科技感',
    ]));
  });
});

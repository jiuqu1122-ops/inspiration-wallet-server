export const AI_TAG_CATEGORIES = [
  '产品类别',
  '设计领域',
  '风格',
  '材质',
  '色彩',
  '形态',
  '场景',
  '视角',
] as const;

export type AiTagCategory = typeof AI_TAG_CATEGORIES[number];

export type AiImageTag = {
  name: string;
  category: AiTagCategory;
  confidence: number;
};

export type NormalizedImageAnalysis = {
  tags: AiImageTag[];
  description: string;
  objects: string[];
  colors: string[];
  profile: Record<string, unknown>;
};

const CATEGORY_ALIASES: Record<string, AiTagCategory> = {
  '产品类别': '产品类别', product: '产品类别', '产品': '产品类别', '品类': '产品类别',
  '设计领域': '设计领域', '领域': '设计领域', 'design domain': '设计领域',
  '风格': '风格', style: '风格', '设计语言': '风格',
  '材质': '材质', material: '材质', '材料': '材质',
  '色彩': '色彩', color: '色彩', '颜色': '色彩',
  '形态': '形态', form: '形态', '造型': '形态',
  '场景': '场景', scene: '场景', '使用场景': '场景',
  '视角': '视角', view: '视角', '构图': '视角',
};

const TAG_ALIASES: Record<string, string> = {
  '极简风': '极简主义', '简约设计': '极简主义', minimal: '极简主义', minimalism: '极简主义', minimalist: '极简主义',
  '工业风格': '工业风', '金属材质': '金属', metal: '金属', glass: '玻璃', plastic: '塑料', wood: '木材', ceramic: '陶瓷',
  black: '黑色', white: '白色', silver: '银色', grey: '灰色', gray: '灰色',
};

const FORBIDDEN_TAGS = new Set(['图片', '照片', '素材', '设计作品', '漂亮', '好看', '高级', '东西', '物品', '产品', '设计']);
const MAX_TAGS_PER_CATEGORY: Record<AiTagCategory, number> = {
  '产品类别': 3, '设计领域': 2, '风格': 3, '材质': 3, '色彩': 4, '形态': 3, '场景': 2, '视角': 2,
};
const MIN_CONFIDENCE = 0.65;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ').replace(/[，,、；;。.!！?？]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function strings(value: unknown, max = 12): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return Array.from(new Set(values.map(normalizeText).filter(Boolean))).slice(0, max);
}

function aliasKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\-_./]+/g, '');
}

function normalizeTagName(value: unknown): string {
  const name = normalizeText(value);
  return name ? TAG_ALIASES[aliasKey(name)] ?? name : '';
}

function normalizeCategory(value: unknown): AiTagCategory | null {
  return CATEGORY_ALIASES[normalizeText(value).toLocaleLowerCase()] ?? null;
}

function normalizeConfidence(value: unknown, fallback = 0.7): number {
  const number = Number(value);
  const confidence = Number.isFinite(number) ? number : fallback;
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
}

function addCandidate(candidates: AiImageTag[], name: unknown, category: unknown, confidence: unknown, fallback?: number) {
  const normalizedName = normalizeTagName(name);
  const normalizedCategory = normalizeCategory(category);
  const normalizedConfidence = normalizeConfidence(confidence, fallback);
  if (!normalizedCategory || !normalizedName || normalizedName.length < 2 || normalizedName.length > 40 || FORBIDDEN_TAGS.has(normalizedName.toLocaleLowerCase()) || normalizedConfidence < MIN_CONFIDENCE) return;
  candidates.push({ name: normalizedName, category: normalizedCategory, confidence: normalizedConfidence });
}

function profileFromAnalysis(source: Record<string, unknown>, analysis: Pick<NormalizedImageAnalysis, 'tags' | 'description' | 'objects' | 'colors'>, input: { itemId: string; userTags?: string[] | undefined; userNotes?: string[] | undefined; existingProfile?: unknown }) {
  const existing = record(input.existingProfile);
  const existingForm = record(existing.form);
  const existingCmf = record(existing.cmf);
  const fromCategory = (category: AiTagCategory) => analysis.tags.filter((tag) => tag.category === category).map((tag) => tag.name);
  return {
    itemId: input.itemId,
    summary: analysis.description || normalizeText(existing.summary),
    description: analysis.description || normalizeText(existing.description || existing.summary),
    objects: analysis.objects,
    category: fromCategory('产品类别')[0] || normalizeText(existing.category),
    form: { silhouette: fromCategory('形态').length ? fromCategory('形态') : strings(existingForm.silhouette), geometry: strings(existingForm.geometry), proportion: strings(existingForm.proportion) },
    cmf: { colors: analysis.colors, materials: fromCategory('材质').length ? fromCategory('材质') : strings(existingCmf.materials), finishes: strings(existingCmf.finishes) },
    style: fromCategory('风格').length ? fromCategory('风格') : strings(existing.style),
    interaction: strings(existing.interaction),
    scene: fromCategory('场景').length ? fromCategory('场景') : strings(existing.scene),
    mood: strings(existing.mood),
    userTags: strings(input.userTags ?? existing.userTags),
    userNotes: strings(input.userNotes ?? existing.userNotes, 24),
    aiTags: analysis.tags,
    analyzedAt: new Date().toISOString(),
    analysisVersion: 1,
  };
}

export function normalizeImageTagAnalysis(value: unknown, input: { itemId: string; userTags?: string[] | undefined; userNotes?: string[] | undefined; existingProfile?: unknown }): NormalizedImageAnalysis {
  const source = record(value);
  const cmf = record(source.cmf);
  const form = record(source.form);
  const candidates: AiImageTag[] = [];
  for (const entry of Array.isArray(source.tags) ? source.tags : []) {
    const tag = record(entry);
    addCandidate(candidates, tag.name, tag.category, tag.confidence);
  }
  strings(source.objects).forEach((name) => addCandidate(candidates, name, '产品类别', 0.7));
  strings(source.colors ?? cmf.colors).forEach((name) => addCandidate(candidates, name, '色彩', 0.72));
  strings(source.style).forEach((name) => addCandidate(candidates, name, '风格', 0.7));
  strings(cmf.materials).forEach((name) => addCandidate(candidates, name, '材质', 0.7));
  strings([...(strings(form.silhouette)), ...(strings(form.geometry)), ...(strings(form.proportion))]).forEach((name) => addCandidate(candidates, name, '形态', 0.68));
  strings(source.scene).forEach((name) => addCandidate(candidates, name, '场景', 0.68));

  const best = new Map<string, AiImageTag>();
  for (const tag of candidates) {
    const key = `${tag.category}:${aliasKey(tag.name)}`;
    const current = best.get(key);
    if (!current || current.confidence < tag.confidence) best.set(key, tag);
  }
  const categoryCount = new Map<AiTagCategory, number>();
  const tags = Array.from(best.values()).sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name, 'zh-CN')).filter((tag) => {
    const count = categoryCount.get(tag.category) ?? 0;
    if (count >= MAX_TAGS_PER_CATEGORY[tag.category]) return false;
    categoryCount.set(tag.category, count + 1);
    return true;
  }).slice(0, 16);
  const description = normalizeText(source.description || source.summary).slice(0, 280);
  const objects = Array.from(new Set([...strings(source.objects), ...tags.filter((tag) => tag.category === '产品类别').map((tag) => tag.name)])).slice(0, 6);
  const colors = Array.from(new Set([...strings(source.colors ?? cmf.colors), ...tags.filter((tag) => tag.category === '色彩').map((tag) => tag.name)])).slice(0, 6);
  return { tags, description, objects, colors, profile: profileFromAnalysis(source, { tags, description, objects, colors }, input) };
}

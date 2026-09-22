/** Statistics use request creation day in UTC+8, matching the existing usage page. */
const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;

export function usageDiagnosticsRange(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isFinite(now.getTime())) {
    throw new Error('invalid_usage_range');
  }
  const shifted = new Date(now.getTime() + OFFSET_MS);
  const today = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - OFFSET_MS;
  return { start: new Date(today + DAY_MS - days * DAY_MS), end: new Date(today + DAY_MS), asOf: now };
}

/** Null/missing/inverted timestamps must never be counted as zero-duration samples. */
export function usageDurationMs(start: Date | null | undefined, end: Date | null | undefined, asOf = new Date()) {
  if (!(start instanceof Date) || !(end instanceof Date)) return null;
  const a = start.getTime();
  const b = end.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b > asOf.getTime()) return null;
  return b - a;
}

export type TimingModality = 'image' | 'text' | 'video';
export type TimingBucket = { samples: number; missingSamples: number; averageMs: number | null };
type Counter = { samples: number; missingSamples: number; totalMs: number };
type ModelCounter = Counter & { key: string; displayName: string; modality: TimingModality };
const counter = (): Counter => ({ samples: 0, missingSamples: 0, totalMs: 0 });
const serialized = (value: Counter): TimingBucket => ({
  samples: value.samples,
  missingSamples: value.missingSamples,
  averageMs: value.samples ? Math.round(value.totalMs / value.samples) : null,
});

export function timingModality(capability: string): TimingModality | null {
  if (capability === 'IMAGE' || capability.startsWith('IMAGE_')) return 'image';
  if (capability === 'LLM' || capability === 'VISION') return 'text';
  if (capability === 'VIDEO' || capability === 'VIDEO_MINIMAX') return 'video';
  return null;
}

/** Streaming accumulator: bounded memory, weighted by actual samples, not means of means. */
export function createUsageTimingCollector(asOf = new Date()) {
  const totals = { image: counter(), text: counter(), video: counter() };
  const models = new Map<string, ModelCounter>();
  return {
    add(input: {
      status: string;
      modality: TimingModality;
      modelKey: string;
      displayName: string;
      createdAt: Date | null | undefined;
      completedAt: Date | null | undefined;
    }) {
      if (input.status !== 'SUCCEEDED') return;
      const key = `${input.modality}:${input.modelKey}`;
      const model = models.get(key) ?? {
        ...counter(), key: input.modelKey, displayName: input.displayName, modality: input.modality,
      };
      const duration = usageDurationMs(input.createdAt, input.completedAt, asOf);
      for (const target of [totals[input.modality], model]) {
        if (duration === null) target.missingSamples += 1;
        else { target.samples += 1; target.totalMs += duration; }
      }
      models.set(key, model);
    },
    result() {
      return {
        image: serialized(totals.image), text: serialized(totals.text), video: serialized(totals.video),
        models: [...models.values()]
          .sort((a, b) => a.modality.localeCompare(b.modality) || b.samples - a.samples || a.key.localeCompare(b.key))
          .map(value => ({ key: value.key, displayName: value.displayName, modality: value.modality, ...serialized(value) })),
      };
    },
  };
}

export function encodeUsageCursor(row: { id: string; createdAt: Date }) {
  return Buffer.from(JSON.stringify({ id: row.id, at: row.createdAt.toISOString() })).toString('base64url');
}

export function decodeUsageCursor(value?: string) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_usage_cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_usage_cursor'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_usage_cursor');
  const row = parsed as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)
    || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) throw new Error('invalid_usage_cursor');
  return { id: row.id, createdAt: new Date(row.at) };
}

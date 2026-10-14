import type { ProviderSecrets } from '../../lib/provider-secrets.js';

export class MusicUpstreamError extends Error {
  constructor(public readonly status: number, public readonly uncertain: boolean) {
    super(uncertain ? 'Music submission outcome is uncertain; automatic resubmission is disabled' : 'Music provider rejected the request');
  }
}

export function parseMusicResponse(value: unknown) {
  const response = value as { choices?: Array<{ message?: { content?: unknown } }> };
  const contents = (response?.choices ?? []).map(choice => choice.message?.content);
  const urls = new Set<string>();
  const visit = (content: unknown) => {
    if (typeof content === 'string') {
      for (const candidate of content.match(/https?:\/\/[^\s<>"'\])]+/gi) ?? []) {
        try {
          const url = new URL(candidate.replace(/[.,;]+$/, ''));
          if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)(?:$|\?)/i.test(url.pathname + url.search)) urls.add(url.href);
        } catch { /* Ignore malformed links in provider prose. */ }
      }
      try { const parsed: unknown = JSON.parse(content); if (parsed && typeof parsed === 'object') visit(parsed); } catch { /* Plain text is also supported. */ }
    } else if (Array.isArray(content)) content.forEach(visit);
    else if (content && typeof content === 'object') {
      for (const [key, child] of Object.entries(content)) {
        if (['audio_url', 'audioUrl'].includes(key) && typeof child === 'string') {
          try { const url = new URL(child); if (url.protocol === 'https:' || url.protocol === 'http:') urls.add(url.href); } catch { /* Invalid URL. */ }
        } else visit(child);
      }
    }
  };
  contents.forEach(visit);
  if (!urls.size) throw new MusicUpstreamError(502, true);
  return { type: 'audio' as const, content: '', audioUrls: [...urls], assets: [...urls].map(url => ({ assetType: 'audio' as const, url })) };
}

/** Exactly one POST. Network errors, timeouts and 5xx must never resubmit. */
export async function submitMusic(
  baseUrl: string, secrets: ProviderSecrets, model: string, prompt: string,
  send: typeof fetch = fetch,
) {
  const endpoint = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  let response: Response;
  try {
    response = await send(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { ...secrets.headers, authorization: `Bearer ${secrets.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], n: 1, stream: false }),
    });
  } catch { throw new MusicUpstreamError(503, true); }
  if (!response.ok) throw new MusicUpstreamError(response.status, response.status >= 500 || response.status === 408);
  try { return parseMusicResponse(await response.json()); }
  catch { throw new MusicUpstreamError(502, true); }
}

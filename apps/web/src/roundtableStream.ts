/**
 * M3.A.5 — Roundtable annotation stream consumer.
 *
 * The sidecar emits all roundtable events through Vercel AI SDK data-stream
 * `8:[{...}]` annotation frames (spec §3.1). This helper opens an authed POST
 * to a /round / /retry / /summarize endpoint, parses the body line-by-line
 * and dispatches each annotation to the caller via `onAnnotation`.
 *
 * The promise resolves when the stream ends (success OR sidecar-side error).
 * Network errors / aborts reject.
 */
import { authedFetch } from './sidecar.js';
import type { RoundtableAnnotation } from '@taori/shared';

export interface StreamRoundtableOpts {
  path: string;
  method?: 'POST' | 'PUT';
  body?: unknown;
  signal?: AbortSignal;
  onAnnotation: (a: RoundtableAnnotation) => void;
}

export async function streamRoundtableAnnotations(
  opts: StreamRoundtableOpts,
): Promise<void> {
  const init: RequestInit = {
    method: opts.method ?? 'POST',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await authedFetch(opts.path, init);
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`stream failed: ${res.status} ${res.statusText} ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('8:')) continue;
        let arr: unknown;
        try {
          arr = JSON.parse(line.slice(2));
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;
        for (const ann of arr) {
          if (ann && typeof ann === 'object' && 'type' in ann) {
            opts.onAnnotation(ann as RoundtableAnnotation);
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

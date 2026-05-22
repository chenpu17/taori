/**
 * Sidecar endpoint resolver + authedFetch.
 *
 * Two modes:
 *   - Tauri runtime (window.__TAURI_INTERNALS__): invoke('sidecar_endpoint').
 *   - Browser dev: VITE_SIDECAR_URL / VITE_SIDECAR_BEARER from .env.local
 *     (set by scripts/dev-browser.mjs).
 *   - Standalone browser (sidecar serves the SPA): cookie-mode bootstrap.
 *
 * Kept thin on purpose — typed clients live in api.ts.
 */

export interface SidecarEndpoint {
  url: string;
  bearer: string;
  authMode?: 'bearer' | 'cookie';
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAORI_BROWSER_BOOTSTRAP__?: {
      url: string;
      authMode: 'bearer' | 'cookie';
      bearer?: string;
    };
  }
}

let cached: SidecarEndpoint | null = null;

export async function getSidecarEndpoint(): Promise<SidecarEndpoint> {
  if (cached) return cached;

  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (mod?.invoke) {
      const ep = (await mod.invoke('sidecar_endpoint')) as SidecarEndpoint;
      cached = ep;
      return ep;
    }
  }

  if (typeof window !== 'undefined' && window.__TAORI_BROWSER_BOOTSTRAP__) {
    const b = window.__TAORI_BROWSER_BOOTSTRAP__;
    cached = { url: b.url, bearer: b.bearer ?? '', authMode: b.authMode };
    return cached;
  }

  const env = (import.meta as ImportMeta & { env: Record<string, string> }).env;
  const url = env.VITE_SIDECAR_URL;
  const bearer = env.VITE_SIDECAR_BEARER;
  if (!url) {
    throw new Error('Sidecar endpoint not configured. Run `pnpm dev:browser` from repo root.');
  }
  cached = { url, bearer: bearer ?? '', authMode: 'bearer' };
  return cached;
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ep = await getSidecarEndpoint();
  return fetch(`${ep.url}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.headers ?? {}),
      ...(ep.bearer ? { Authorization: `Bearer ${ep.bearer}` } : {}),
    },
  });
}

export function isSidecarConfigured(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__TAURI_INTERNALS__) return true;
  if (window.__TAORI_BROWSER_BOOTSTRAP__) return true;
  const env = (import.meta as ImportMeta & { env: Record<string, string> }).env;
  return !!env.VITE_SIDECAR_URL;
}

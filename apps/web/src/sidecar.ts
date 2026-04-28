/**
 * Resolves the Sidecar HTTP endpoint and bearer token.
 *
 * Two modes:
 *   - Tauri runtime: window.__TAURI__ is present → call invoke('sidecar_endpoint').
 *   - Browser dev: vars come from VITE_SIDECAR_URL / VITE_SIDECAR_BEARER (set
 *     by the dev script that also boots the standalone sidecar).
 */

export interface SidecarEndpoint {
  url: string;
  bearer: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

let cached: SidecarEndpoint | null = null;

export async function getSidecarEndpoint(): Promise<SidecarEndpoint> {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core').catch(() => ({
      invoke: null as unknown as never,
    }));
    if (invoke) {
      const ep = (await invoke('sidecar_endpoint')) as SidecarEndpoint;
      cached = ep;
      return ep;
    }
  }
  const url = (import.meta as ImportMeta & { env: Record<string, string> }).env
    .VITE_SIDECAR_URL;
  const bearer = (import.meta as ImportMeta & { env: Record<string, string> })
    .env.VITE_SIDECAR_BEARER;
  if (!url || !bearer) {
    throw new Error(
      'Sidecar endpoint not available. In dev set VITE_SIDECAR_URL & VITE_SIDECAR_BEARER.',
    );
  }
  cached = { url, bearer };
  return cached;
}

export async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ep = await getSidecarEndpoint();
  return fetch(`${ep.url}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${ep.bearer}`,
    },
  });
}

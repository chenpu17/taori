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
      cached = (await mod.invoke('sidecar_endpoint')) as SidecarEndpoint;
      return cached;
    }
  }

  if (typeof window !== 'undefined' && window.__TAORI_BROWSER_BOOTSTRAP__) {
    const boot = window.__TAORI_BROWSER_BOOTSTRAP__;
    cached = {
      url: boot.url,
      bearer: boot.bearer ?? '',
      authMode: boot.authMode,
    };
    return cached;
  }

  const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
  if (!env.VITE_SIDECAR_URL) {
    throw new Error('Sidecar 未配置。请通过桌面端启动，或使用 pnpm dev:browser。');
  }
  cached = {
    url: env.VITE_SIDECAR_URL,
    bearer: env.VITE_SIDECAR_BEARER ?? '',
    authMode: 'bearer',
  };
  return cached;
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const endpoint = await getSidecarEndpoint();
  const headers = new Headers(init.headers);
  if (endpoint.bearer) {
    headers.set('Authorization', `Bearer ${endpoint.bearer}`);
  }
  return fetch(`${endpoint.url}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
}

export function resetSidecarEndpointCache(): void {
  cached = null;
}

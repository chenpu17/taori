/**
 * Client for the Sidecar↔Tauri Rust control channel (axum-backed).
 *
 * Endpoints (per docs/architecture/03-process-and-ipc.md):
 *   POST /v1/keychain/write   { service, account, secret }    -> { ok: true }
 *   POST /v1/keychain/read    { service, account }            -> { secret } | 404
 *   POST /v1/keychain/delete  { service, account }            -> { ok: true }
 *   POST /v1/files/read       { path, max_bytes? }            -> { bytes_base64, size }
 *   GET  /health                                              -> { ok: true }
 *
 * All requests carry: Authorization: Bearer <CONTROL_BEARER>.
 *
 * Note: M0 does not actually call any of these methods — the wire is plumbed
 * but unused until M1 (provider/model + onboarding stores keys).
 */

import { TaoriError } from '@taori/shared';

export const TAORI_KEYCHAIN_SERVICE = 'app.taori.desktop';

export interface ControlClientConfig {
  url: string | null;
  bearer: string | null;
}

const KEYCHAIN_READ_TIMEOUT_MS = 15_000;
const KEYCHAIN_WRITE_TIMEOUT_MS = 30_000;
const KEYCHAIN_DELETE_TIMEOUT_MS = 30_000;

export class ControlClient {
  constructor(private readonly cfg: ControlClientConfig) {}

  get isAvailable(): boolean {
    return Boolean(this.cfg.url && this.cfg.bearer);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isAvailable) {
      throw new TaoriError({
        code: 'keychain_error',
        message: 'Control channel not configured (sidecar running standalone)',
      });
    }
    const url = `${this.cfg.url}${path}`;
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller?.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.bearer}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (timeoutMs && e instanceof Error && e.name === 'AbortError') {
        throw new TaoriError({
          code: 'keychain_error',
          message: `Control channel ${method} ${path} timed out after ${timeoutMs}ms`,
        });
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      throw new TaoriError({
        code: res.status === 404 ? 'not_found' : 'keychain_error',
        message: `Control channel ${method} ${path} → ${res.status}`,
      });
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    if (!this.isAvailable) return false;
    try {
      await this.req<{ ok: true }>('GET', '/health', undefined, 1_500);
      return true;
    } catch {
      return false;
    }
  }

  async writeKeychain(
    account: string,
    secret: string,
    service: string = TAORI_KEYCHAIN_SERVICE,
  ): Promise<void> {
    await this.req(
      'POST',
      '/v1/keychain/write',
      { service, account, secret },
      KEYCHAIN_WRITE_TIMEOUT_MS,
    );
  }

  async readKeychain(
    account: string,
    service: string = TAORI_KEYCHAIN_SERVICE,
  ): Promise<string | null> {
    try {
      const res = await this.req<{ secret: string }>(
        'POST',
        '/v1/keychain/read',
        { service, account },
        KEYCHAIN_READ_TIMEOUT_MS,
      );
      return res.secret;
    } catch (e) {
      if (e instanceof TaoriError && e.code === 'not_found') return null;
      throw e;
    }
  }

  async deleteKeychain(
    account: string,
    service: string = TAORI_KEYCHAIN_SERVICE,
  ): Promise<void> {
    await this.req(
      'POST',
      '/v1/keychain/delete',
      { service, account },
      KEYCHAIN_DELETE_TIMEOUT_MS,
    );
  }

  // NOTE: file read is intentionally not exposed in M0. M1 will add it via
  // the control channel (Renderer-driven file-drop → Tauri allowlist).
}

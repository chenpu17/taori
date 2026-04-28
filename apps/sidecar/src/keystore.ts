/**
 * KeyStore — abstracts where a provider's API key is held at rest.
 *
 * Production: keys MUST live in OS Keychain via the Tauri Rust control channel
 * (KeychainStore). Sidecar never writes keys to disk. See
 * docs/architecture/05-security.md.
 *
 * Standalone dev (no Tauri running, e.g. `pnpm dev:browser`): keys live in
 * process memory only (MemoryStore). They survive the sidecar process but
 * not a restart, and the user must re-enter on each dev session. We log a
 * conspicuous warning so this never silently happens in production.
 *
 * The store is keyed by an opaque `account` string the caller picks
 * (typically `provider:<id>`). The sidecar never sees plaintext keys when
 * using KeychainStore — they are written through the control channel and
 * read back lazily right before a provider HTTP call.
 */

import { TaoriError } from '@taori/shared';
import { type ControlClient } from './control/client.js';

export interface KeyStore {
  readonly kind: 'keychain' | 'memory';
  write(account: string, secret: string): Promise<void>;
  read(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
}

export class KeychainStore implements KeyStore {
  readonly kind = 'keychain' as const;
  constructor(private readonly control: ControlClient) {}
  write(account: string, secret: string): Promise<void> {
    return this.control.writeKeychain(account, secret);
  }
  read(account: string): Promise<string | null> {
    return this.control.readKeychain(account);
  }
  delete(account: string): Promise<void> {
    return this.control.deleteKeychain(account);
  }
}

export class MemoryStore implements KeyStore {
  readonly kind = 'memory' as const;
  private map = new Map<string, string>();
  async write(account: string, secret: string): Promise<void> {
    this.map.set(account, secret);
  }
  async read(account: string): Promise<string | null> {
    return this.map.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.map.delete(account);
  }
}

/** Pick a store based on whether the control channel is reachable. */
export function buildKeyStore(args: {
  control: ControlClient;
  isDev: boolean;
  log: (msg: string) => void;
}): KeyStore {
  if (args.control.isAvailable) {
    return new KeychainStore(args.control);
  }
  if (!args.isDev) {
    // In production a missing control channel is a fatal misconfiguration —
    // we must not silently fall back to memory (would lose keys + violate
    // security spec).
    throw new TaoriError({
      code: 'internal',
      message:
        'No control channel configured in production: refusing to start without OS Keychain access',
    });
  }
  args.log(
    '[sidecar] WARNING: control channel unavailable — using in-memory key store (DEV ONLY).',
  );
  return new MemoryStore();
}

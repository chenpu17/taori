/**
 * KeyStore — abstracts where a provider's API key is held at rest.
 *
 * Production: keys MUST live in OS Keychain via the Tauri Rust control channel
 * (KeychainStore). Sidecar never writes keys to disk. See
 * docs/architecture/05-security.md.
 *
 * Standalone dev (no Tauri running, e.g. `pnpm dev:browser`): keys are
 * persisted to a local JSON file (`dev.keys.json`) alongside `dev.db` so
 * they survive sidecar restarts. The file is plain-text and should never be
 * committed; it is gitignored by default. We log a conspicuous warning so
 * this never silently happens in production.
 *
 * The store is keyed by an opaque `account` string the caller picks
 * (typically `provider:<id>`). The sidecar never sees plaintext keys when
 * using KeychainStore — they are written through the control channel and
 * read back lazily right before a provider HTTP call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TaoriError } from '@taori/shared';
import { type ControlClient } from './control/client.js';

export interface KeyStore {
  readonly kind: 'keychain' | 'memory' | 'dev_file';
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
  standalone?: boolean;
  dbPath: string;
  log: (msg: string) => void;
}): KeyStore {
  if (args.control.isAvailable) {
    return new KeychainStore(args.control);
  }
  if (!args.isDev && !args.standalone) {
    // In production a missing control channel is a fatal misconfiguration —
    // we must not silently fall back to memory (would lose keys + violate
    // security spec).
    throw new TaoriError({
      code: 'internal',
      message:
        'No control channel configured in production: refusing to start without OS Keychain access',
    });
  }
  const keysPath = path.join(path.dirname(args.dbPath), args.standalone ? 'taori.keys.json' : 'dev.keys.json');
  args.log(
    args.standalone
      ? `[sidecar] standalone mode — using local file key store (${keysPath})`
      : `[sidecar] WARNING: control channel unavailable — using dev file key store (${keysPath}). DEV ONLY.`,
  );
  return new DevFileKeyStore(keysPath);
}

/**
 * Dev-only persistent key store backed by a plain JSON file on disk.
 * Keys survive sidecar restarts during development.
 *
 * NEVER use in production — the file is plain-text. It is gitignored.
 */
export class DevFileKeyStore implements KeyStore {
  readonly kind = 'dev_file' as const;

  constructor(private readonly filePath: string) {}

  private load(): Record<string, string> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private save(map: Record<string, string>): void {
    fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2), 'utf8');
  }

  async write(account: string, secret: string): Promise<void> {
    const map = this.load();
    map[account] = secret;
    this.save(map);
  }

  async read(account: string): Promise<string | null> {
    return this.load()[account] ?? null;
  }

  async delete(account: string): Promise<void> {
    const map = this.load();
    delete map[account];
    this.save(map);
  }
}

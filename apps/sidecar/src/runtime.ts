import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type SidecarConfig } from './config.js';
import { openDb } from './db/index.js';
import { ControlClient } from './control/client.js';
import { buildKeyStore } from './keystore.js';
import { buildServer } from './server.js';
import { buildRepos } from './db/repos/index.js';
import { formatHttpUrl, normalizeLocalConnectUrl } from './standalone-cli.js';

export interface StartedSidecar {
  config: SidecarConfig;
  bindUrl: string;
  port: number;
  bearer: string;
  url: string;
  close(): Promise<void>;
}

export async function startSidecar(args?: {
  onReady?: (info: { port: number; bearer: string; url: string; config: SidecarConfig }) => void;
}): Promise<StartedSidecar> {
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  const control = new ControlClient({
    url: config.controlUrl,
    bearer: config.controlBearer,
  });
  const keystore = buildKeyStore({
    control,
    isDev: config.isDev,
    standalone: config.standalone,
    dbPath: config.dbPath,
    log: (msg) => process.stderr.write(msg + '\n'),
  });
  const startedAt = Date.now();

  const repos = buildRepos(db);
  const app = buildServer({ config, db, repos, control, keystore, startedAt });
  const address = await app.listen({ host: config.host ?? '127.0.0.1', port: config.port });
  const url = new URL(address);
  const port = Number(url.port);
  const bindHost = config.host ?? '127.0.0.1';
  const bindUrl = formatHttpUrl(bindHost, port);
  const href = normalizeLocalConnectUrl(bindHost, port);

  const { scheduleCatalogSync } = await import('./catalog/index.js');
  const catalogTask = scheduleCatalogSync({
    providers: repos.providers,
    models: repos.models,
    keystore,
    log: {
      info: (...a) => process.stderr.write('[catalog] ' + a.join(' ') + '\n'),
      warn: (...a) => process.stderr.write('[catalog] WARN ' + a.join(' ') + '\n'),
    },
  });

  if (config.isDev) {
    process.stderr.write(
      `[sidecar] dev mode listening on ${bindUrl} (local=${href}, control=${config.controlUrl ? 'configured' : 'none'})\n`,
    );
  }
  if (config.standalone) {
    process.stderr.write(`[sidecar] standalone mode listening on ${bindUrl} (local=${href})\n`);
  }

  let shuttingDown = false;
  const close = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    catalogTask.stop();
    await app.close();
  };

  const shutdown = async (signal: string) => {
    process.stderr.write(`[sidecar] received ${signal}, shutting down\n`);
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  args?.onReady?.({ port, bearer: config.bearer, url: href, config });

  return {
    config,
    bindUrl,
    port,
    bearer: config.bearer,
    url: href,
    close,
  };
}

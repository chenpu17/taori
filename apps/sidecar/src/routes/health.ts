import type { FastifyInstance } from 'fastify';
import type { BuildServerArgs } from '../server.js';

export function registerHealthRoute(
  app: FastifyInstance,
  args: BuildServerArgs,
): void {
  app.get('/health', async () => {
    const controlOk = await args.control.health().catch(() => false);
    return {
      ok: true as const,
      service: 'taori-sidecar' as const,
      version: args.config.version,
      uptime_ms: Date.now() - args.startedAt,
      control_channel: args.control.isAvailable
        ? controlOk
          ? ('connected' as const)
          : ('disconnected' as const)
        : ('unknown' as const),
    };
  });
}

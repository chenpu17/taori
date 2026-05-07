import type { FastifyInstance } from 'fastify';
import {
  McpServerCreateSchema,
  McpServerUpdateSchema,
  TaoriError,
} from '@taori/shared';
import { McpServersRepo } from '../db/repos/index.js';
import type { CapabilityBus } from '../bus/index.js';
import { refreshMcpServerTools } from '../mcp/index.js';
import { closeMcpServerSession } from '../mcp/client.js';
import type { BuildServerArgs } from '../server.js';

export interface McpRouteDeps extends BuildServerArgs {
  bus: CapabilityBus;
}

export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  const repo = new McpServersRepo(deps.db);

  app.get('/v1/mcp/servers', async () => {
    return { ok: true, servers: repo.list() };
  });

  app.post('/v1/mcp/servers', async (req, reply) => {
    const parsed = McpServerCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const server = repo.create(parsed.data);
    reply.code(201);
    return { ok: true, server };
  });

  app.patch<{ Params: { id: string } }>('/v1/mcp/servers/:id', async (req) => {
    const parsed = McpServerUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const previous = repo.get(req.params.id);
    const server = repo.update(req.params.id, parsed.data);
    if (!server) {
      throw new TaoriError({
        code: 'not_found',
        message: `MCP server ${req.params.id} not found`,
      });
    }
    if (previous) {
      closeMcpServerSession({
        command: previous.command,
        args: previous.args,
        env: previous.env,
      });
    }
    if (parsed.data.enabled === false) {
      deps.bus.unregisterBySource('mcp', server.id);
    } else {
      for (const tool of deps.bus.list().filter((t) => t.source === 'mcp' && t.source_id === server.id)) {
        deps.bus.setEnabled(tool.name, server.enabled);
      }
    }
    return { ok: true, server };
  });

  app.delete<{ Params: { id: string } }>('/v1/mcp/servers/:id', async (req, reply) => {
    const server = repo.get(req.params.id);
    deps.bus.unregisterBySource('mcp', req.params.id);
    const ok = repo.delete(req.params.id);
    if (!ok) {
      throw new TaoriError({
        code: 'not_found',
        message: `MCP server ${req.params.id} not found`,
      });
    }
    if (server) {
      closeMcpServerSession({
        command: server.command,
        args: server.args,
        env: server.env,
      });
    }
    reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/mcp/servers/:id/refresh', async (req) => {
    const server = repo.get(req.params.id);
    if (!server) {
      throw new TaoriError({
        code: 'not_found',
        message: `MCP server ${req.params.id} not found`,
      });
    }
    try {
      const tools = await refreshMcpServerTools(deps.bus, server);
      const updated = repo.setHealth(server.id, {
        health_status: server.enabled ? 'ok' : 'disabled',
        last_error: null,
        tools_count: tools.length,
      }) ?? server;
      return {
        ok: true,
        server: updated,
        tools: tools.map((tool) => ({
          name: `mcp.${server.id}.${tool.name}`,
          description: tool.description,
        })),
      };
    } catch (e) {
      deps.bus.unregisterBySource('mcp', server.id);
      const message = e instanceof Error ? e.message : String(e);
      const updated = repo.setHealth(server.id, {
        health_status: 'error',
        last_error: message.slice(0, 500),
        tools_count: 0,
      }) ?? server;
      return { ok: false, server: updated, tools: [] };
    }
  });
}

export async function restoreMcpToolsAtStartup(
  deps: Pick<McpRouteDeps, 'db' | 'bus' | 'config'> & {
    log?: { warn: (...a: unknown[]) => void };
  },
): Promise<void> {
  const repo = new McpServersRepo(deps.db);
  for (const server of repo.list().filter((item) => item.enabled)) {
    try {
      const tools = await refreshMcpServerTools(deps.bus, server);
      repo.setHealth(server.id, { health_status: 'ok', last_error: null, tools_count: tools.length });
    } catch (e) {
      repo.setHealth(server.id, {
        health_status: 'error',
        last_error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        tools_count: 0,
      });
      deps.log?.warn({ err: e, server_id: server.id }, 'mcp.startup_refresh_failed');
    }
  }
}

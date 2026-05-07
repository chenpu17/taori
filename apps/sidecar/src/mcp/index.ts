import type { McpServer, Tool } from '@taori/shared';
import type { CapabilityBus, ToolDescriptor } from '../bus/index.js';
import { callMcpTool, listMcpTools, type McpToolInfo } from './client.js';
import { jsonSchemaToZod } from './schema.js';

export function mcpBusToolName(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

export function registerMcpTools(
  bus: CapabilityBus,
  server: McpServer,
  tools: McpToolInfo[],
): Tool[] {
  bus.unregisterBySource('mcp', server.id);
  for (const mcpTool of tools) {
    const descriptor: ToolDescriptor<Record<string, unknown>, unknown> = {
      name: mcpBusToolName(server.id, mcpTool.name),
      description: mcpTool.description,
      capability: 'mcp',
      source: 'mcp',
      source_id: server.id,
      enabled: server.enabled,
      inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
      execute: async (input) => ({
        output: await callMcpTool(
          { command: server.command, args: server.args, env: server.env },
          mcpTool.name,
          input,
        ),
      }),
    };
    bus.register(descriptor);
  }
  return bus.list().filter((tool) => tool.source === 'mcp' && tool.source_id === server.id);
}

export async function refreshMcpServerTools(
  bus: CapabilityBus,
  server: McpServer,
): Promise<McpToolInfo[]> {
  const tools = await listMcpTools({
    command: server.command,
    args: server.args,
    env: server.env,
  });
  registerMcpTools(bus, server, tools);
  return tools;
}

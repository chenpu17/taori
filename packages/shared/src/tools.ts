import { z } from 'zod';

/**
 * M2 §4 — Capability Bus contracts.
 *
 * Three schemas pin the cross-process data contract for sidecar-internal
 * tools (`builtin.*`) and (M3) MCP-bridged tools (`mcp.<server_id>.<name>`).
 *
 *   - `Tool`              — descriptor exposed via GET /v1/tools
 *   - `ToolInvokeRequest` — POST /v1/tools/invoke body
 *   - `ToolInvokeResult`  — POST /v1/tools/invoke response.data
 *
 * The renderer (M2.4 image flow) and E2E only use these names; per-tool
 * `input` / `output` shapes are validated by each tool's own zod schema
 * inside the sidecar's bus.
 */

export const TOOL_CAPABILITIES = ['image', 'file', 'web', 'code', 'mcp'] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const TOOL_SOURCES = ['builtin', 'mcp'] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

export const TOOL_ERROR_CLASSIFICATIONS = [
  'validation_error',
  'tool_timeout',
  'mcp_crashed',
  'permission_denied',
  'rate_limit',
  'quota',
  'network',
  'unknown',
] as const;
export type ToolErrorClassification = (typeof TOOL_ERROR_CLASSIFICATIONS)[number];

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  capability: z.enum(TOOL_CAPABILITIES),
  source: z.enum(TOOL_SOURCES),
  source_id: z.string(),
  enabled: z.boolean(),
});
export type Tool = z.infer<typeof ToolSchema>;

export const ToolHealthRowSchema = z.object({
  tool_name: z.string(),
  calls_24h: z.number().int().nonnegative(),
  failures_24h: z.number().int().nonnegative(),
  avg_duration_ms: z.number().nullable(),
  last_failure_at: z.number().int().nullable(),
  last_failure_classification: z.enum(TOOL_ERROR_CLASSIFICATIONS).nullable(),
});
export type ToolHealthRow = z.infer<typeof ToolHealthRowSchema>;

export const ToolInvokeRequestSchema = z.object({
  name: z.string(),
  input: z.unknown(),
  conversation_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'conversation_id must be an opaque token')
    .nullable()
    .optional(),
  source_message_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'source_message_id must be an opaque token')
    .nullable()
    .optional(),
});
export type ToolInvokeRequest = z.infer<typeof ToolInvokeRequestSchema>;

export const ToolInvokeErrorSchema = z.object({
  classification: z.enum(TOOL_ERROR_CLASSIFICATIONS),
  message: z.string(),
});
export type ToolInvokeError = z.infer<typeof ToolInvokeErrorSchema>;

export const ToolInvokeCostSchema = z.object({
  estimated_usd: z.number().optional(),
  actual_usd: z.number().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
});
export type ToolInvokeCost = z.infer<typeof ToolInvokeCostSchema>;

export const ToolInvokeResultSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: ToolInvokeErrorSchema.optional(),
  cost: ToolInvokeCostSchema.optional(),
});
export type ToolInvokeResult = z.infer<typeof ToolInvokeResultSchema>;

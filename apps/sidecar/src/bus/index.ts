/**
 * Capability Bus — M2 §4.
 *
 * Single dispatch surface for sidecar-internal `builtin.*` tools and (M3)
 * MCP-bridged tools. The renderer never imports tool internals; it goes
 * through `/v1/tools/invoke`, which calls `bus.invoke()`.
 *
 * Responsibilities:
 *   1. Validate input via the tool's own zod schema.
 *   2. Run the tool's `execute()` with a try/catch that classifies errors.
 *   3. Auto-write `cost_records(source_type='tool_call')` for every invoke
 *      (success OR failure), so 上层全局成本视图天然包含工具调用。
 *
 * `cost_records.feature` is set to the tool's `capability` (e.g. 'image',
 * 'file'). For `builtin.file_read` the cost is always 0; for image
 * generation M2.4 will fill in `actual_cost_usd` after upstream return.
 */
import { z } from 'zod';
import { tool as aiTool } from 'ai';
import {
  TOOL_ERROR_CLASSIFICATIONS,
  type Tool,
  type ToolCapability,
  type ToolErrorClassification,
  type ToolInvokeResult,
} from '@taori/shared';
import { CostsRepo, type CostInsert } from '../db/repos/index.js';
import { classifyProviderError } from '../providers/registry.js';

export interface ToolContext {
  conversationId?: string | null;
  sourceMessageId?: string | null;
  /**
   * Optional assistant message that should receive tool output attachments.
   * Used by LLM-side tool calls so generated images stay on the same answer
   * after history reload; direct /tools invocations can omit it.
   */
  targetMessageId?: string | null;
  /** dev-only test hook — see routes/tools.ts and bus/builtins/image_generate.ts */
  testForce?: 'success' | 'quota' | 'content_filter' | 'billed_4xx' | null;
}

export interface ToolDescriptor<I = unknown, O = unknown> {
  name: string;
  description: string;
  capability: ToolCapability;
  source: 'builtin' | 'mcp';
  source_id: string;
  enabled: boolean;
  inputSchema: z.ZodType<I>;
  /**
   * Pure execution. Throws on failure (any thrown value will be classified
   * by the bus). Costs returned via the optional second tuple slot are
   * recorded in cost_records by the bus.
   */
  execute(input: I, ctx: ToolContext): Promise<{
    output: O;
    cost?: {
      actual_usd?: number;
      tokens_in?: number;
      tokens_out?: number;
      /** When the tool fanned out to a model, capture its identity so
       *  `cost_records` can attribute spend per model (spec 09-m2-spec §3.3). */
      model_id?: string | null;
      model_name_snapshot?: string | null;
      price_per_call_snapshot?: number | null;
      /** Override `source_id` to point at the assistant message the tool
       *  emitted, not the user message that triggered the invocation. */
      assistant_message_id?: string | null;
    };
  }>;
}

export interface AiSdkToolTrace {
  call_id: string;
  ai_tool_name: string;
  tool: string;
  label: string;
  input?: string | null;
  output?: string | null;
  ok?: boolean;
  duration_ms?: number;
}

export interface AiSdkToolsResult {
  tools: Record<string, unknown>;
  exposed: Array<{
    ai_name: string;
    bus_name: string;
    description: string;
    source: ToolDescriptor['source'];
  }>;
}

export class CapabilityBus {
  private tools = new Map<string, ToolDescriptor<unknown, unknown>>();

  constructor(private readonly costs: CostsRepo) {}

  register<I, O>(tool: ToolDescriptor<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDescriptor<unknown, unknown>);
  }

  unregisterBySource(source: ToolDescriptor['source'], sourceId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.source === source && tool.source_id === sourceId) {
        this.tools.delete(name);
      }
    }
  }

  list(): Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      capability: t.capability,
      source: t.source,
      source_id: t.source_id,
      enabled: t.enabled,
    }));
  }

  get(name: string): ToolDescriptor<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  setEnabled(name: string, enabled: boolean): Tool | null {
    const tool = this.tools.get(name);
    if (!tool) return null;
    tool.enabled = enabled;
    return {
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      source: tool.source,
      source_id: tool.source_id,
      enabled: tool.enabled,
    };
  }

  async invoke(
    name: string,
    rawInput: unknown,
    ctx: ToolContext = {},
  ): Promise<ToolInvokeResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.recordCost(null, ctx, 'file', false, 0, undefined, undefined, 'validation_error');
      return {
        ok: false,
        error: { classification: 'validation_error', message: `Unknown tool: ${name}` },
      };
    }
    if (!tool.enabled) {
      this.recordCost(tool, ctx, tool.capability, false, 0, undefined, undefined, 'permission_denied');
      return {
        ok: false,
        error: { classification: 'permission_denied', message: `Tool disabled: ${name}` },
      };
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      this.recordCost(tool, ctx, tool.capability, false, 0, undefined, undefined, 'validation_error');
      return {
        ok: false,
        error: {
          classification: 'validation_error',
          message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        },
      };
    }

    const start = Date.now();
    try {
      const { output, cost } = await tool.execute(parsed.data, ctx);
      const actual = cost?.actual_usd ?? 0;
      this.recordCost(tool, ctx, tool.capability, true, actual, Date.now() - start, cost);
      return {
        ok: true,
        output,
        cost: { actual_usd: actual, tokens_in: cost?.tokens_in, tokens_out: cost?.tokens_out },
      };
    } catch (err) {
      const classification = classifyToolError(err);
      const message = err instanceof Error ? err.message : String(err);
      // Spec §6.1 / §7 step 8: a "billed 4xx" — provider charged us even
      // though the call failed — must record `actual_cost_usd > 0` with
      // success=false so the session panel can flag "含 X 次 4xx 扣费".
      const billed =
        err && typeof err === 'object' && typeof (err as { billedCost?: unknown }).billedCost === 'number'
          ? ((err as { billedCost: number }).billedCost)
          : 0;
      this.recordCost(tool, ctx, tool.capability, false, billed, Date.now() - start, undefined, classification);
      return {
        ok: false,
        error: { classification, message },
      };
    }
  }

  toAISDKTools(options: {
    names: string[];
    context: ToolContext;
    callIdPrefix: string;
    labelFor?: (tool: ToolDescriptor<unknown, unknown>) => string;
    summarizeInput?: (value: unknown, tool: ToolDescriptor<unknown, unknown>) => string;
    summarizeOutput?: (value: unknown, tool: ToolDescriptor<unknown, unknown>) => string;
    onStart?: (trace: AiSdkToolTrace) => void;
    onFinish?: (trace: AiSdkToolTrace) => void;
  }): AiSdkToolsResult {
    const used = new Set<string>();
    const out: Record<string, unknown> = {};
    const exposed: AiSdkToolsResult['exposed'] = [];

    for (const name of options.names) {
      const descriptor = this.tools.get(name);
      if (!descriptor || !descriptor.enabled) continue;

      const aiName = safeAiToolName(descriptor.name, used);
      const label = options.labelFor?.(descriptor) ?? descriptor.description;
      exposed.push({
        ai_name: aiName,
        bus_name: descriptor.name,
        description: descriptor.description,
        source: descriptor.source,
      });

      out[aiName] = aiTool({
        description: descriptor.description,
        parameters: descriptor.inputSchema,
        execute: async (input: unknown) => {
          const callId = `${options.callIdPrefix}:${aiName}:${Date.now()}`;
          const startedAt = Date.now();
          options.onStart?.({
            call_id: callId,
            ai_tool_name: aiName,
            tool: descriptor.name,
            label,
            input: options.summarizeInput?.(input, descriptor) ?? summarizeToolValue(input),
          });

          const result = await this.invoke(descriptor.name, input, options.context);
          const output = result.ok ? result.output : result.error?.message;
          options.onFinish?.({
            call_id: callId,
            ai_tool_name: aiName,
            tool: descriptor.name,
            label,
            ok: result.ok,
            output: options.summarizeOutput?.(output, descriptor) ?? summarizeToolValue(output),
            duration_ms: Date.now() - startedAt,
          });

          return result.ok ? result.output : { ok: false, error: result.error };
        },
      });
    }

    return { tools: out, exposed };
  }

  private recordCost(
    tool: ToolDescriptor | null,
    ctx: ToolContext,
    capability: ToolCapability,
    success: boolean,
    actual_usd: number,
    duration_ms?: number,
    cost?: {
      tokens_in?: number;
      tokens_out?: number;
      model_id?: string | null;
      model_name_snapshot?: string | null;
      price_per_call_snapshot?: number | null;
      assistant_message_id?: string | null;
    },
    classification?: ToolErrorClassification | null,
  ): void {
    const featureCol: CostInsert['feature'] =
      capability === 'image' ? 'image' : 'tool_call';
    const insert: CostInsert = {
      conversation_id: ctx.conversationId ?? null,
      source_type: 'tool_call',
      source_id: cost?.assistant_message_id ?? ctx.sourceMessageId ?? null,
      feature: featureCol,
      model_id: cost?.model_id ?? null,
      model_name_snapshot:
        cost?.model_name_snapshot ?? (tool ? tool.name : 'unknown_tool'),
      input_tokens: cost?.tokens_in ?? null,
      output_tokens: cost?.tokens_out ?? null,
      price_input_per_1m_snapshot: null,
      price_output_per_1m_snapshot: null,
      price_per_call_snapshot: cost?.price_per_call_snapshot ?? null,
      estimated_cost_usd: null,
      actual_cost_usd: actual_usd,
      success,
      classification: classification ?? null,
      duration_ms: duration_ms ?? null,
    };
    this.costs.insert(insert);
  }
}

export function safeAiToolName(busName: string, used: Set<string>): string {
  const base = busName.replace(/^builtin\./, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 58) || 'tool';
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 54)}_${i++}`;
  }
  used.add(name);
  return name;
}

function summarizeToolValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 220);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return String(value).slice(0, 220);
  }
}

function classifyToolError(err: unknown): ToolErrorClassification {
  if (err && typeof err === 'object' && 'classification' in err) {
    const c = (err as { classification?: unknown }).classification;
    if (typeof c === 'string' && (TOOL_ERROR_CLASSIFICATIONS as readonly string[]).includes(c)) {
      return c as ToolErrorClassification;
    }
  }
  // Reuse provider classifier for network/rate-limit/quota signals.
  const provider = classifyProviderError({ err });
  if (provider.classification === 'rate_limit') return 'rate_limit';
  if (provider.classification === 'quota') return 'quota';
  if (provider.classification === 'network') return 'network';
  return 'unknown';
}

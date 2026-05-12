import { tool } from 'ai';
import { z } from 'zod';
import { safeAiToolName, type CapabilityBus } from '../bus/index.js';
import type { FilesRepo } from '../db/repos/index.js';
import {
  applyPreferredSearchToolSelection as applyPreferredSearchToolSelectionFromBus,
  isSearchToolLike as isSearchToolLikeFromBus,
  pickPreferredSearchToolName as pickPreferredSearchToolNameFromBus,
} from '../search/tool-selection.js';

export interface UpstreamToolContext {
  messageId: string;
  conversationId: string;
  sourceUserMessageId: string | null;
  supportsTools: boolean;
  toolPolicy: Record<string, boolean>;
  bus: CapabilityBus | null;
  imageModelId: string | null;
  filesRepo: FilesRepo | null;
  log: { warn: (...a: unknown[]) => void };
  runtimeState?: {
    imageGenerateCompleted?: boolean;
  };
  defaultSearchToolName?: string | null;
}

export interface ToolTracePayload {
  event: 'start' | 'finish';
  call_id: string;
  tool: string;
  label: string;
  input?: string;
  ok?: boolean;
  output?: string;
  duration_ms?: number;
}

export interface UpstreamToolBuildResult {
  tools: Record<string, any> | undefined;
  flags: { image: boolean; web: boolean; mcp: boolean; file: boolean };
}

export interface UpstreamToolDefinition {
  aiName: string;
  busName: string;
  label: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown) => Promise<unknown>;
}

export interface UpstreamToolCatalog {
  definitions: UpstreamToolDefinition[];
  flags: { image: boolean; web: boolean; mcp: boolean; file: boolean };
}

export function isSearchToolLike(name: string, description?: string | null): boolean {
  return isSearchToolLikeFromBus(name, description);
}

export function pickPreferredSearchToolName(ctx: UpstreamToolContext, names: string[]): string | null {
  return pickPreferredSearchToolNameFromBus(ctx.bus, ctx.defaultSearchToolName, names);
}

export function applyPreferredSearchToolSelection(
  ctx: UpstreamToolContext,
  names: string[],
): string[] {
  return applyPreferredSearchToolSelectionFromBus(ctx.bus, ctx.defaultSearchToolName, names);
}

export function withCapabilityToolInstruction(
  messages: any[],
  flags: { image: boolean; web: boolean; mcp: boolean; file: boolean },
): any[] {
  const parts = [
    flags.image
      ? 'If the user asks you to create, draw, render, or generate an image, call the image_generate tool. When the user explicitly asks to call image_generate, call it immediately with the user-provided prompt instead of asking follow-up questions. Do not claim you cannot generate images when the tool is available. If the user is asking about capability, or says not to generate an image, answer normally without calling the tool.\n如果用户要求生成/绘制/制作图片，或明确说“调用 image_generate 工具”，请立即调用 image_generate，并把用户描述整理成图片提示词；不要先追问补充信息，除非用户只是在询问能力或明确说不要生成。'
      : null,
    flags.web
      ? 'If the user needs current, recent, external, or URL-specific information, use the available web search tool to find sources and any web fetch tool to read specific URLs. If the user explicitly asks to browse, call the relevant tool. Cite the URLs you used in the answer. Do not use web tools for private/local URLs or when the user explicitly asks you not to browse.\n如果问题需要最新、外部或 URL 指定信息，请使用可用的网页搜索/抓取工具，并在回答中引用使用过的 URL；如果用户明确要求联网检索，也应直接调用相关工具。'
      : null,
    flags.mcp
      ? 'You may use the available MCP tools when they directly help solve the user request. Prefer them for user-configured local capabilities, data sources, or automations; use the tool descriptions to choose the right tool and integrate the result into the answer.\n当用户配置的 MCP 工具能直接帮助解决问题时可以调用它们；根据工具描述选择合适工具，并把工具结果整合进回答。'
      : null,
    flags.file
      ? 'If the user asks about uploaded/local files, use file_search to retrieve focused snippets instead of asking the user to paste the whole file or reading an entire long file. Cite file_id and chunk number when using snippets.\n当用户询问已上传/本地文件内容时，请优先使用 file_search 检索相关片段，不要把长文件整段读入；使用片段时说明 file_id 和 chunk。'
      : null,
  ].filter(Boolean);
  if (parts.length === 0) return messages;
  const instruction = {
    role: 'system',
    content: parts.join('\n'),
  };
  const firstNonSystemIndex = messages.findIndex((message) => message?.role !== 'system');
  const insertAt = firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex;
  return [
    ...messages.slice(0, insertAt),
    instruction,
    ...messages.slice(insertAt),
  ];
}

function isToolEnabledForConversation(ctx: UpstreamToolContext, name: string): boolean {
  return ctx.toolPolicy[name] === true;
}

export function canExposeToolToModel(ctx: UpstreamToolContext, name: string): boolean {
  if (!ctx.supportsTools || !ctx.bus || !isToolEnabledForConversation(ctx, name)) {
    return false;
  }
  if (ctx.bus.get(name)?.enabled !== true) {
    return false;
  }
  if (name === 'builtin.image_generate') {
    return Boolean(ctx.imageModelId);
  }
  if (name === 'builtin.web_search' || name === 'builtin.web_fetch') {
    return true;
  }
  if (name === 'builtin.file_search') {
    return true;
  }
  if (name.startsWith('mcp.')) {
    return true;
  }
  return false;
}

export function getVisibleToolNames(ctx: UpstreamToolContext): string[] {
  return applyPreferredSearchToolSelection(
    ctx,
    Object.keys(ctx.toolPolicy).filter((name) => canExposeToolToModel(ctx, name)),
  );
}

function summarizeValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 220);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return String(value).slice(0, 220);
  }
}

function toolLabelForName(name: string, source: 'builtin' | 'mcp', description: string): string {
  if (source === 'mcp') return `MCP · ${description}`;
  if (name === 'builtin.web_search') return '搜索网页';
  if (name === 'builtin.web_fetch') return '抓取网页';
  if (name === 'builtin.image_generate') return '生成图片';
  return description;
}

function summarizeToolInput(busName: string, input: unknown): string {
  if (isSearchToolLike(busName) && input && typeof input === 'object') {
    const query = (input as { query?: unknown }).query;
    return typeof query === 'string' ? query.slice(0, 180) : JSON.stringify(input).slice(0, 180);
  }
  if (busName === 'builtin.web_fetch' && input && typeof input === 'object') {
    const url = (input as { url?: unknown }).url;
    return typeof url === 'string' ? url.slice(0, 180) : JSON.stringify(input).slice(0, 180);
  }
  return summarizeValue(input);
}

function summarizeToolOutput(busName: string, output: unknown): string {
  if (isSearchToolLike(busName) && output && typeof output === 'object') {
    const results = (output as { results?: unknown }).results;
    return `返回 ${Array.isArray(results) ? results.length : 0} 条结果`;
  }
  if (busName === 'builtin.web_fetch' && output && typeof output === 'object') {
    const obj = output as { content?: string; title?: string };
    return obj.title
      ? `${obj.title} · ${(obj.content ?? '').length} 字符`
      : `返回 ${(obj.content ?? '').length} 字符`;
  }
  return summarizeValue(output);
}

export function buildUpstreamToolCatalog(
  ctx: UpstreamToolContext,
  write: (line: string) => boolean,
  emitToolTrace: (payload: ToolTracePayload) => void,
): UpstreamToolCatalog {
  const imageToolEnabled = Boolean(canExposeToolToModel(ctx, 'builtin.image_generate'));
  const visibleToolNames = getVisibleToolNames(ctx);
  const busToolNames = visibleToolNames.filter((name) => name !== 'builtin.image_generate');
  const definitions: UpstreamToolDefinition[] = [];
  const usedNames = new Set<string>();

  if (imageToolEnabled && ctx.bus) {
    definitions.push({
      aiName: 'image_generate',
      busName: 'builtin.image_generate',
      label: '生成图片',
      description:
        'Generate an image from a text prompt. Use this when the user asks for a picture, drawing, illustration, poster, or any visual artifact. The result is automatically attached to the conversation; do NOT include the image bytes in your reply — instead briefly tell the user the image is ready.',
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe('Detailed English prompt describing the image to generate'),
      }),
      execute: async (rawInput: unknown) => {
        const parsed = z.object({ prompt: z.string().min(1).max(4000) }).parse(rawInput);
        const callId = `${ctx.messageId}:image_generate:${Date.now()}`;
        const toolStartedAt = Date.now();
        emitToolTrace({
          event: 'start',
          call_id: callId,
          tool: 'builtin.image_generate',
          label: '生成图片',
          input: parsed.prompt.slice(0, 180),
        });
        const result = await ctx.bus!.invoke(
          'builtin.image_generate',
          { prompt: parsed.prompt, model_id: ctx.imageModelId! },
          {
            conversationId: ctx.conversationId,
            sourceMessageId: ctx.sourceUserMessageId,
            targetMessageId: ctx.messageId,
          },
        );
        if (!result.ok) {
          emitToolTrace({
            event: 'finish',
            call_id: callId,
            tool: 'builtin.image_generate',
            label: '生成图片',
            ok: false,
            output: result.error?.message ?? 'image_generate failed',
            duration_ms: Date.now() - toolStartedAt,
          });
          return {
            ok: false,
            error: result.error?.message ?? 'image_generate failed',
          };
        }
        const out = result.output as {
          file_id: string;
          content_type: string;
          width: number;
          height: number;
          assistant_message_id: string;
        };
        let dataB64: string | null = null;
        try {
          const row = ctx.filesRepo?.get(out.file_id);
          if (row?.original_path) {
            const fs = await import('node:fs/promises');
            const buf = await fs.readFile(row.original_path);
            dataB64 = buf.toString('base64');
          }
        } catch (e) {
          ctx.log.warn({ err: e }, 'chat.image_inline_read_failed');
        }
        write(
          `8:${JSON.stringify([
            {
              type: 'tool_image_result',
              tool: 'image_generate',
              file_id: out.file_id,
              content_type: out.content_type,
              width: out.width,
              height: out.height,
              prompt: parsed.prompt,
              ...(dataB64 ? { data_b64: dataB64 } : {}),
            },
          ])}\n`,
        );
        if (ctx.runtimeState) {
          ctx.runtimeState.imageGenerateCompleted = true;
        }
        emitToolTrace({
          event: 'finish',
          call_id: callId,
          tool: 'builtin.image_generate',
          label: '生成图片',
          ok: true,
          output: `已生成图片 ${out.width}×${out.height}`,
          duration_ms: Date.now() - toolStartedAt,
        });
        return {
          ok: true,
          file_id: out.file_id,
          width: out.width,
          height: out.height,
        };
      },
    });
    usedNames.add('image_generate');
  }

  for (const busName of busToolNames) {
    const descriptor = ctx.bus?.get(busName);
    if (!descriptor || !descriptor.enabled) continue;
    const aiName = safeAiToolName(descriptor.name, usedNames);
    const label = toolLabelForName(descriptor.name, descriptor.source, descriptor.description);
    definitions.push({
      aiName,
      busName: descriptor.name,
      label,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      execute: async (input: unknown) => {
        const callId = `${ctx.messageId}:${aiName}:${Date.now()}`;
        const startedAt = Date.now();
        emitToolTrace({
          event: 'start',
          call_id: callId,
          tool: descriptor.name,
          label,
          input: summarizeToolInput(descriptor.name, input),
        });
        const result = await ctx.bus!.invoke(descriptor.name, input, {
          conversationId: ctx.conversationId,
          sourceMessageId: ctx.sourceUserMessageId,
          targetMessageId: ctx.messageId,
        });
        const output = result.ok ? result.output : result.error?.message;
        emitToolTrace({
          event: 'finish',
          call_id: callId,
          tool: descriptor.name,
          label,
          ok: result.ok,
          output: summarizeToolOutput(descriptor.name, output),
          duration_ms: Date.now() - startedAt,
        });
        return result.ok ? result.output : { ok: false, error: result.error };
      },
    });
  }

  const webToolsEnabled = definitions.some((item) =>
    isSearchToolLike(item.busName, item.description) || item.busName === 'builtin.web_fetch',
  );
  const mcpToolsEnabled = definitions.some((item) => item.busName.startsWith('mcp.'));
  const fileToolsEnabled = definitions.some((item) => item.busName === 'builtin.file_search');

  return {
    definitions,
    flags: {
      image: imageToolEnabled,
      web: webToolsEnabled,
      mcp: mcpToolsEnabled,
      file: fileToolsEnabled,
    },
  };
}

export function buildUpstreamTools(
  ctx: UpstreamToolContext,
  write: (line: string) => boolean,
  emitToolTrace: (payload: ToolTracePayload) => void,
): UpstreamToolBuildResult {
  const catalog = buildUpstreamToolCatalog(ctx, write, emitToolTrace);
  const tools = catalog.definitions.length > 0
    ? Object.fromEntries(
        catalog.definitions.map((definition) => [
          definition.aiName,
          tool({
            description: definition.description,
            parameters: definition.inputSchema,
            execute: definition.execute,
          }),
        ]),
      )
    : undefined;
  return {
    tools,
    flags: catalog.flags,
  };
}

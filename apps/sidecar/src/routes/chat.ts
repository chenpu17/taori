/**
 * POST /v1/chat — streaming chat endpoint (M1.2).
 *
 * Wire format: AI SDK v4 data-stream protocol (header
 * `x-vercel-ai-data-stream: v1`, parts `0:` text, `8:[…]` annotations,
 * `e:{…}` step finish, `d:{…}` message finish).
 *
 * Resolution order for the model used to answer:
 *   1. Look up models[id] from the request body.
 *   2. If the model's provider has an api_key_ref AND the keystore can
 *      retrieve a key, we call the upstream Chat Completions endpoint via
 *      `@ai-sdk/openai` (works for OpenAI / OpenRouter / any compat API).
 *   3. Otherwise we fall back to a deterministic mock reply. This keeps the
 *      M0 path alive (Playwright + offline dev still work) without the
 *      Renderer needing to know about keys.
 *
 * Persistence (M1.2):
 *   - Conversations are upserted via ConversationsRepo (idempotent).
 *   - The incoming user turn is persisted with status='complete'.
 *   - The assistant turn is created up-front with status='streaming' so the
 *     id can be sent on the wire as a `8:[{type:'meta',message_id:…}]`
 *     annotation, then finalized with content+status='complete' on stop or
 *     status='incomplete' on client abort / status='failed' on error.
 *
 * Error classification: any thrown upstream error is mapped via
 * classifyProviderError so the Renderer can decide retry behavior.
 */

import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { ChatRequestSchema, TaoriError, calculateCostUsd, isChatCapable } from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import {
  ConversationsRepo,
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  CostsRepo,
  MemoriesRepo,
  FilesRepo,
  type MessageRow,
} from '../db/repos/index.js';
import { classifyProviderError } from '../providers/registry.js';
import { detectImageIntent, isIntentDisabledUntilNow } from '../intent.js';
import type { CapabilityBus } from '../bus/index.js';

const TEST_HOOKS_ENABLED = process.env.NODE_ENV !== 'production'
  && process.env.TAORI_DISABLE_TEST_HOOKS !== '1';
const FORCE_CLASSIFICATION_HEADER = 'x-test-force-classification';
const VALID_FORCED_CLASSIFICATIONS = new Set([
  'quota', 'network', 'rate_limit', 'content_filter', 'auth', 'unknown',
]);

export function registerChatRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const msgRepo = new MessagesRepo(deps.db);
  const modelsRepo = new ModelsRepo(deps.db);
  const providersRepo = new ProvidersRepo(deps.db);
  const costsRepo = new CostsRepo(deps.db);
  const memoriesRepo = new MemoriesRepo(deps.db);
  const filesRepo = new FilesRepo(deps.db);

  app.post('/v1/chat', async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const body = parsed.data;
    const attachments = body.attachments ?? [];
    const hasImage = attachments.some((a) => a.kind === 'image');
    const lastUserMsg = [...body.messages].reverse().find((m) => m.role === 'user');

    // Aggregate cap: even if individual files pass the per-attachment limit,
    // the combined payload should fit comfortably in memory + a SQLite blob.
    const totalAttachmentBytes = attachments.reduce(
      (sum, a) => sum + a.data_b64.length,
      0,
    );
    if (totalAttachmentBytes > 20_000_000) {
      throw new TaoriError({
        code: 'validation_error',
        message: '附件总大小不能超过 20MB（base64）',
      });
    }

    // Per-kind size cap: text attachments end up truncated to ~200KB inside
    // the prompt anyway, so reject obviously-too-large text files upfront
    // instead of decoding ~7.5MB of base64 only to throw most of it away.
    // Base64 inflates by 4/3, so 400KB of base64 ≈ 300KB of decoded UTF-8 —
    // gives us ~50% headroom over TEXT_CAP for non-ASCII content.
    const TEXT_B64_CAP = 400_000;
    const oversizedText = attachments.find(
      (a) => a.kind === 'text' && a.data_b64.length > TEXT_B64_CAP,
    );
    if (oversizedText) {
      throw new TaoriError({
        code: 'validation_error',
        message: `文本附件 ${oversizedText.name ?? ''} 过大（超过 ~300KB），请精简后重试。`,
      });
    }

    const conversation = convRepo.ensure(body.conversation_id);
    const model = modelsRepo.get(body.model_id);
    const provider = model?.provider_id ? providersRepo.get(model.provider_id) : null;

    // Auto-title: if this is a brand-new conversation (no title yet) and we
    // have a user message, derive a short title from its first ~30 chars.
    // CHAT-4 spec: "标题自动从首条消息生成". We persist it before streaming
    // so the sidebar can pick it up immediately.
    if (!conversation.title && lastUserMsg?.content) {
      const raw = lastUserMsg.content.replace(/\s+/g, ' ').trim();
      const title = raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
      if (title) convRepo.rename(conversation.id, title);
    }

    if (hasImage && model && !model.supports_vision) {
      throw new TaoriError({
        code: 'validation_error',
        message:
          '当前模型不支持图片输入；请切换到带 👁 的视觉模型后重新发送。',
        details: { model_id: model.id, supports_vision: false },
      });
    }
    // R4.1 — PDF parsing. We parse the PDF here and replace its base64 with
    // the extracted UTF-8 text (re-encoded as base64). Downstream
    // (`buildUpstreamMessages`) treats `kind:'pdf'` identically to text and
    // wraps it in a fenced block so the model sees the file as plain text.
    // The kind is preserved so the renderer keeps the 📕 chip and the DB
    // record reflects the user's actual upload type.
    const PDF_TEXT_CAP = 200_000; // characters; matches TEXT_CAP downstream.
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i]!;
      if (a.kind !== 'pdf') continue;
      let parsed: string;
      try {
        const buf = Buffer.from(a.data_b64, 'base64');
        // Use the inner module path to avoid pdf-parse@1.1.1 index.js debug
        // mode which tries to read a bundled fixture and fails with ENOENT.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error -- no .d.ts for the inner path; we keep typing via cast.
        const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
          default: (b: Buffer) => Promise<{ text: string }>;
        };
        const result = await mod.default(buf);
        parsed = (result.text ?? '').trim();
      } catch (e) {
        throw new TaoriError({
          code: 'validation_error',
          message: `PDF 解析失败：${a.name ?? 'document.pdf'} — 文件可能损坏或为扫描件。`,
          details: { kind: 'pdf', name: a.name ?? null, err: e instanceof Error ? e.message : String(e) },
        });
      }
      if (!parsed) {
        throw new TaoriError({
          code: 'validation_error',
          message: `PDF ${a.name ?? ''} 没有可提取的文本（可能是纯图片扫描件）。请改用图片附件 + 视觉模型。`,
          details: { kind: 'pdf', name: a.name ?? null },
        });
      }
      if (parsed.length > PDF_TEXT_CAP) {
        parsed = parsed.slice(0, PDF_TEXT_CAP) + `\n…（已截断，原 PDF 文本超过 ${Math.round(PDF_TEXT_CAP / 1024)}KB）`;
      }
      attachments[i] = {
        ...a,
        mime: 'text/plain',
        data_b64: Buffer.from(parsed, 'utf-8').toString('base64'),
      };
    }
    if (attachments.length > 0 && !model) {
      throw new TaoriError({
        code: 'not_found',
        message: '未找到所选模型，无法处理附件。',
      });
    }

    // Persist user turn + assistant placeholder atomically so a crash between
    // them can't leave an orphaned user message or a half-recorded turn.
    //
    // M2.4 — image-intent fast path: if the user's text matches the intent
    // regex AND the session-level escape memory is NOT active, we skip the
    // assistant placeholder entirely. The renderer-side image picker will
    // call /v1/tools/invoke later, and `image_generate.execute` will then
    // insert the assistant message itself with parent_message_id linked to
    // the user message we persist here. (See spec §2.2 step 3.)
    let intentRoute: { prompt: string; user_message_id: string } | null = null;
    if (lastUserMsg?.content) {
      const intent = detectImageIntent(lastUserMsg.content);
      if (intent.hit) {
        const escape = memoriesRepo.getEffective(
          conversation.id,
          'intent_route_disabled_until',
        );
        const disabled = isIntentDisabledUntilNow(escape, Date.now());
        if (!disabled) {
          const userRow = deps.db.transaction((tx) => {
            const txMsgRepo = new MessagesRepo(tx);
            return txMsgRepo.insert({
              conversation_id: conversation.id,
              role: 'user',
              content: lastUserMsg.content,
              status: 'complete',
              attachments:
                attachments.length > 0 ? JSON.stringify(attachments) : null,
            });
          });
          intentRoute = { prompt: intent.prompt, user_message_id: userRow.id };
        }
      }
    }

    const assistantMsg = intentRoute
      ? null
      : deps.db.transaction((tx) => {
          const txMsgRepo = new MessagesRepo(tx);
          if (lastUserMsg) {
            txMsgRepo.insert({
              conversation_id: conversation.id,
              role: 'user',
              content: lastUserMsg.content,
              status: 'complete',
              attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
            });
          }
          return txMsgRepo.insert({
            conversation_id: conversation.id,
            role: 'assistant',
            content: '',
            model_id: model?.id ?? null,
            status: 'streaming',
          });
        });

    const stream = new PassThrough();

    // CORS — re-emit explicitly because the cors plugin's reply-layer
    // headers can be lost when streaming (see M0 chat fix).
    const origin = req.headers.origin;
    if (
      typeof origin === 'string' &&
      (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
        origin === 'tauri://localhost' ||
        origin.startsWith('http://tauri.localhost'))
    ) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Expose-Headers', 'x-vercel-ai-data-stream');
    }

    reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('Connection', 'keep-alive')
      .header('x-vercel-ai-data-stream', 'v1');

    if (typeof reply.raw.socket?.setNoDelay === 'function') {
      reply.raw.socket.setNoDelay(true);
    }

    const abortController = new AbortController();
    let aborted = false;
    reply.raw.on('close', () => {
      if (!stream.writableEnded) {
        aborted = true;
        abortController.abort();
      }
    });

    reply.send(stream);

    // M2.4 image-intent fast path: emit capability_route annotation, end.
    if (intentRoute) {
      stream.write(
        `8:${JSON.stringify([
          { type: 'meta', conversation_id: conversation.id, message_id: null, model_id: null },
        ])}\n`,
      );
      stream.write(
        `8:${JSON.stringify([
          {
            type: 'capability_route',
            capability: 'image',
            prompt: intentRoute.prompt,
            user_message_id: intentRoute.user_message_id,
            conversation_id: conversation.id,
          },
        ])}\n`,
      );
      stream.write(
        `d:${JSON.stringify({
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
        })}\n`,
      );
      stream.end();
      return;
    }

    const ctx: ProduceCtx = {
      conversationId: conversation.id,
      messageId: assistantMsg!.id,
      modelId: body.model_id,
      modelDbId: model?.id ?? null,
      modelNameSnapshot: model?.model_name ?? body.model_id,
      priceInputPer1m: model?.price_input_per_1m ?? null,
      priceOutputPer1m: model?.price_output_per_1m ?? null,
      pricePerCall: model?.price_per_call ?? null,
      userText: lastUserMsg?.content ?? '',
      messages: body.messages,
      attachments,
      log: req.log,
      forcedClassification: TEST_HOOKS_ENABLED
        ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
        : null,
      capability: model?.capability ?? 'chat',
      bus: deps.bus ?? null,
      // Pick an image candidate at request time (default → cheapest enabled).
      // If the chat model itself isn't chat-capable (e.g. an image-only model),
      // skip — there's no LLM to dispatch tool calls.
      imageModelId:
        deps.bus && model && isChatCapable(model.capability)
          ? (modelsRepo.defaultFor('image') ??
              modelsRepo.pickCheapestActive('image', ''))?.id ?? null
          : null,
      filesRepo,
    };

    if (model && provider && provider.api_key_ref) {
      // Real upstream call — fetch key from keystore right before the call so
      // it never lives in the request scope longer than necessary.
      let apiKey: string | null = null;
      try {
        apiKey = await deps.keystore.read(provider.api_key_ref);
      } catch (e) {
        req.log.warn({ err: e }, 'chat.keystore_read_failed');
      }
      if (apiKey) {
        // Attach DB-finalize listeners BEFORE the producer writes its first
        // chunk — otherwise the synchronous lead frames are flushed to the
        // HTTP response before our on('data') listener can collect them
        // (the assistant message would then be persisted with the leading
        // tokens missing).
        finalizeOnEnd(stream, () => aborted, ctx, msgRepo, costsRepo, modelsRepo);
        void produceUpstreamStream(stream, abortController.signal, ctx, {
          baseURL: provider.base_url,
          apiKey,
          modelName: model.model_name,
        }, modelsRepo, memoriesRepo).catch((e) => req.log.error({ err: e }, 'chat.upstream_unhandled'));
        return;
      }
    }

    // Fallback: M0 mock stream (no provider key configured).
    finalizeOnEnd(stream, () => aborted, ctx, msgRepo, costsRepo, modelsRepo);
    void produceMockStream(stream, () => aborted, ctx, modelsRepo, memoriesRepo);
  });
}

interface ProduceCtx {
  conversationId: string;
  messageId: string;
  modelId: string;
  modelDbId: string | null;
  modelNameSnapshot: string;
  priceInputPer1m: number | null;
  priceOutputPer1m: number | null;
  pricePerCall: number | null;
  userText: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  attachments: { kind: 'image' | 'text' | 'pdf'; mime: string; data_b64: string; name?: string }[];
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** dev-only test hook: force classification on upstream call (M2 §6.1) */
  forcedClassification: string | null;
  /** capability of the model — used to pick fallback within same family */
  capability: string;
  /**
   * M2.5 §F-CR — capability-bus reference and the image model the LLM should
   * route image_generate calls to. Both null = no image tool offered. The
   * fast-path image-intent route runs BEFORE this and is mutually exclusive.
   */
  bus: CapabilityBus | null;
  imageModelId: string | null;
  filesRepo: FilesRepo | null;
}

/**
 * Parse the dev-only `X-Test-Force-Classification` header. Returns null if
 * absent, malformed, or not in the allowlist. Even in dev a junk value is
 * silently ignored — no error to client — to avoid surprising production-ish
 * deployments that accidentally have NODE_ENV != production.
 */
function readForcedClassification(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return VALID_FORCED_CLASSIFICATIONS.has(v) ? v : null;
}

/**
 * Build the failure_decision annotation payload (M2 §1.3). Renderer uses
 * this to render the in-message decision card; for `content_filter` the
 * `recommended_model_id` is intentionally null so the card hides the
 * "switch model" button (content policy isn't a model problem).
 */
function buildFailureDecision(
  classification: string,
  ctx: ProduceCtx,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Record<string, unknown> {
  let recommendedId: string | null = null;
  if (classification !== 'content_filter' && ctx.modelDbId) {
    try {
      const fb = modelsRepo.nextFallback(
        ctx.modelDbId,
        (ctx.capability as 'chat' | 'image' | 'embedding'),
      );
      recommendedId = fb?.id ?? null;
    } catch {
      recommendedId = null;
    }
  }
  let autoFallback = false;
  try {
    autoFallback = memoriesRepo.getEffective(ctx.conversationId, 'auto_fallback_enabled') === 'true';
  } catch {
    /* ignore */
  }
  return {
    type: 'failure_decision',
    classification,
    current_model_id: ctx.modelDbId,
    recommended_model_id: recommendedId,
    auto_fallback_enabled: autoFallback,
  };
}

function finalizeOnEnd(
  stream: PassThrough,
  isAborted: () => boolean,
  ctx: ProduceCtx,
  msgRepo: MessagesRepo,
  costsRepo: CostsRepo,
  modelsRepo: ModelsRepo,
): void {
  let collected = '';
  let lineBuffer = '';
  let usage: { input: number; output: number; durationMs: number; calls: number } = {
    input: 0,
    output: 0,
    durationMs: 0,
    calls: 1,
  };
  let upstreamErrored = false;
  let upstreamClassification: string | null = null;
  // Tap text chunks for persistence. The producers write `0:"…"\n` lines for
  // text — parse them back so we can reconstruct what was actually sent. The
  // PassThrough stream may emit `data` events whose boundaries do NOT align
  // with our line writes (TCP/buffer coalescing), so accumulate into a line
  // buffer and only parse complete lines (terminated by `\n`).
  const parseLine = (line: string): void => {
    if (line.startsWith('0:')) {
      try {
        const part = JSON.parse(line.slice(2));
        if (typeof part === 'string') collected += part;
      } catch {
        /* ignore non-JSON tail */
      }
      return;
    }
    if (line.startsWith('8:')) {
      try {
        const arr = JSON.parse(line.slice(2)) as Array<Record<string, unknown>>;
        for (const ann of arr) {
          if (ann?.type === 'cost') {
            usage.input = (ann.input_tokens as number) ?? usage.input;
            usage.output = (ann.output_tokens as number) ?? usage.output;
            usage.durationMs = (ann.duration_ms as number) ?? usage.durationMs;
          }
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (line.startsWith('3:')) {
      upstreamErrored = true;
      // Frame format: `3:"provider_error/<classification>: <msg>"` — extract
      // the classification token so finalizeOnEnd can decide whether to
      // strike the model. Only quota/rate_limit/network are scored.
      try {
        const payload = JSON.parse(line.slice(2));
        if (typeof payload === 'string') {
          const m = /^provider_error\/([a-z_]+)/.exec(payload);
          if (m) upstreamClassification = m[1] ?? null;
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  };
  stream.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) parseLine(line);
  });
  const writeCost = (success: boolean): void => {
    const actual = success
      ? calculateCostUsd({
          inputTokens: usage.input,
          outputTokens: usage.output,
          callCount: usage.calls,
          priceInputPer1m: ctx.priceInputPer1m,
          priceOutputPer1m: ctx.priceOutputPer1m,
          pricePerCall: ctx.pricePerCall,
        })
      : null;
    try {
      costsRepo.insert({
        conversation_id: ctx.conversationId,
        source_type: 'message',
        source_id: ctx.messageId,
        feature: 'chat',
        model_id: ctx.modelDbId,
        model_name_snapshot: ctx.modelNameSnapshot,
        input_tokens: usage.input || null,
        output_tokens: usage.output || null,
        call_count: 1,
        price_input_per_1m_snapshot: ctx.priceInputPer1m,
        price_output_per_1m_snapshot: ctx.priceOutputPer1m,
        price_per_call_snapshot: ctx.pricePerCall,
        estimated_cost_usd: null,
        actual_cost_usd: actual,
        success,
        duration_ms: usage.durationMs || null,
      });
    } catch (e) {
      // Cost tracking is non-critical observability — never let it crash
      // the request path or the stream-end handler. The message itself is
      // already persisted by the time we reach here.
      ctx.log.warn(
        { err: e, messageId: ctx.messageId, conversationId: ctx.conversationId },
        'cost.write_failed',
      );
    }
  };
  stream.on('end', () => {
    if (lineBuffer) parseLine(lineBuffer);
    const aborted = isAborted();
    const status: MessageRow['status'] = upstreamErrored
      ? 'failed'
      : aborted
        ? 'incomplete'
        : 'complete';
    msgRepo.finalize(ctx.messageId, { content: collected, status });
    writeCost(!aborted && !upstreamErrored);
    // Per spec §7.5.2: track quota/rate_limit/network as failures so models
    // demote (≥3) and disable (≥5). Successful runs reset the rolling
    // counter. content_filter / unknown (auth) do NOT count.
    if (ctx.modelDbId) {
      try {
        if (upstreamErrored && upstreamClassification) {
          modelsRepo.recordFailure(ctx.modelDbId, upstreamClassification);
        } else if (!upstreamErrored && !aborted) {
          modelsRepo.recordSuccess(ctx.modelDbId);
        }
      } catch (e) {
        ctx.log.warn({ err: e }, 'model.failure_track_failed');
      }
    }
  });
  stream.on('error', (err) => {
    if (lineBuffer) parseLine(lineBuffer);
    msgRepo.finalize(ctx.messageId, {
      content: collected,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    writeCost(false);
  });
}

/**
 * Convert ChatRequest.messages + attachments into AI SDK CoreMessages.
 *
 * Attachments are bound to the LAST user turn — this matches OpenAI/OpenRouter
 * convention where user uploads sit alongside the prompt that referred to them.
 * Image attachments become content parts; everything else falls back to a
 * text-only message.
 */
function buildUpstreamMessages(ctx: ProduceCtx): any {
  if (!ctx.attachments || ctx.attachments.length === 0) return ctx.messages;
  const out: any[] = [];
  let lastUserIdx = -1;
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    if (ctx.messages[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  // Decode text attachments once and prepend them as a fenced block above the
  // user prompt. We cap each decoded attachment at ~200KB of text to avoid
  // blowing the context budget for tiny models — anything past the cap is
  // truncated with a clear marker so the user sees it happened.
  //
  // Two safety considerations:
  //   1. User-controlled content could break out of triple-backtick fences
  //      and inject prompts. We escape backtick fences (`\`\`\``) inside
  //      `decoded` to a zero-width-joiner-separated form so the model sees
  //      them as text but they no longer terminate the wrapper.
  //   2. Files misclassified as text/* may be binary; Buffer.toString('utf-8')
  //      silently inserts U+FFFD replacement chars. We count those and bail
  //      out (skip the attachment with a notice) when the ratio looks like
  //      binary garbage rather than UTF-8 text.
  const TEXT_CAP = 200_000;
  const textBlocks: string[] = [];
  const imageParts: any[] = [];
  for (const a of ctx.attachments) {
    if (a.kind === 'image') {
      imageParts.push({ type: 'image', image: `data:${a.mime};base64,${a.data_b64}` });
    } else if (a.kind === 'text' || a.kind === 'pdf') {
      let decoded = '';
      try {
        decoded = Buffer.from(a.data_b64, 'base64').toString('utf-8');
      } catch {
        decoded = '';
      }
      if (!decoded) continue;
      // Detect binary-misclassified-as-text: if more than 1% of the first
      // 4KB is U+FFFD (the UTF-8 replacement char), treat the file as
      // unreadable and surface a notice instead of garbage tokens.
      const sample = decoded.slice(0, 4096);
      const replCount = (sample.match(/\uFFFD/g) ?? []).length;
      if (sample.length > 0 && replCount / sample.length > 0.01) {
        textBlocks.push(`【附件：${a.name ?? 'attachment'}】（无法以 UTF-8 解码，已忽略内容）`);
        continue;
      }
      let truncatedNotice = '';
      if (decoded.length > TEXT_CAP) {
        decoded = decoded.slice(0, TEXT_CAP);
        truncatedNotice = `\n…（已截断，原始文件超过 ${Math.round(TEXT_CAP / 1024)}KB）`;
      }
      // Neutralise any embedded triple-backtick fences so user-supplied text
      // can't escape our wrapper and inject instructions. We insert a zero-
      // width space between each pair of backticks; the model still reads
      // them as backticks but the closing fence is no longer matchable.
      const safe = decoded.replace(/```/g, '`\u200b`\u200b`');
      const fallbackName = a.kind === 'pdf' ? 'document.pdf' : 'attachment.txt';
      const name = a.name ?? fallbackName;
      const lang = a.kind === 'pdf' ? '' : (name.endsWith('.md') ? 'markdown' : '');
      const labelPrefix = a.kind === 'pdf' ? '【附件 PDF（已解析为文本）：' : '【附件：';
      textBlocks.push(`${labelPrefix}${name}】\n\`\`\`${lang}\n${safe}${truncatedNotice}\n\`\`\``);
    }
  }
  for (let i = 0; i < ctx.messages.length; i++) {
    const m = ctx.messages[i]!;
    if (i === lastUserIdx) {
      const userText = textBlocks.length > 0
        ? `${textBlocks.join('\n\n')}\n\n${m.content}`
        : m.content;
      if (imageParts.length > 0) {
        out.push({
          role: 'user',
          content: [{ type: 'text', text: userText }, ...imageParts],
        });
      } else {
        out.push({ role: 'user', content: userText });
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

async function produceUpstreamStream(
  stream: PassThrough,
  signal: AbortSignal,
  ctx: ProduceCtx,
  cfg: { baseURL: string; apiKey: string; modelName: string },
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const startedAt = Date.now();
  const write = (line: string): boolean => stream.write(line);

  // Always announce the assistant message id first so the Renderer can wire
  // up follow-up calls (cancel, attach files, etc.) before any text arrives.
  write(
    `8:${JSON.stringify([
      { type: 'meta', conversation_id: ctx.conversationId, message_id: ctx.messageId, model_id: ctx.modelId },
    ])}\n`,
  );

  try {
    // dev-only test hook: short-circuit to a synthesized provider error.
    // Lets E2E exercise the failure_decision path without flaky network mocks.
    if (ctx.forcedClassification) {
      const synthetic = new Error(`forced ${ctx.forcedClassification}`);
      (synthetic as { _forcedClassification?: string })._forcedClassification =
        ctx.forcedClassification;
      throw synthetic;
    }

    const provider = createOpenAI({
      baseURL: cfg.baseURL.replace(/\/$/, ''),
      apiKey: cfg.apiKey,
    });

    // M2.5 §F-CR — Inject `image_generate` as an LLM tool when:
    //  • the user has at least one enabled image-capability model;
    //  • the chat model itself supports text I/O (chat or multimodal).
    // The fast-path image-intent route already took precedence above, so
    // when we reach here either (a) the user's text didn't match the regex
    // or (b) they had no image model. Case (a) is precisely where the LLM
    // should be allowed to pick the tool itself.
    const tools = ctx.bus && ctx.imageModelId
      ? {
          image_generate: tool({
            description:
              'Generate an image from a text prompt. Use this when the user asks for a picture, drawing, illustration, poster, or any visual artifact. The result is automatically attached to the conversation; do NOT include the image bytes in your reply — instead briefly tell the user the image is ready.',
            parameters: z.object({
              prompt: z
                .string()
                .min(1)
                .max(4000)
                .describe('Detailed English prompt describing the image to generate'),
            }),
            execute: async ({ prompt }) => {
              const result = await ctx.bus!.invoke(
                'image_generate',
                { prompt, model_id: ctx.imageModelId! },
                {
                  conversationId: ctx.conversationId,
                  sourceMessageId: ctx.messageId,
                },
              );
              if (!result.ok) {
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
              // Read the file bytes back from disk and inline them as base64
              // in the annotation. This avoids needing a separate authed
              // /v1/files endpoint just for inline rendering, at the cost of
              // a one-time stream blow-up of ~1MB per generated image.
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
              // Stream a tool_image_result annotation back to the renderer
              // so it can render the image inline immediately, even before
              // the LLM writes its closing prose.
              write(
                `8:${JSON.stringify([
                  {
                    type: 'tool_image_result',
                    tool: 'image_generate',
                    file_id: out.file_id,
                    content_type: out.content_type,
                    width: out.width,
                    height: out.height,
                    prompt,
                    ...(dataB64 ? { data_b64: dataB64 } : {}),
                  },
                ])}\n`,
              );
              return {
                ok: true,
                file_id: out.file_id,
                width: out.width,
                height: out.height,
              };
            },
          }),
        }
      : undefined;

    const result = await streamText({
      model: provider.chat(cfg.modelName),
      messages: buildUpstreamMessages(ctx),
      abortSignal: signal,
      ...(tools && { tools, maxSteps: 3 }),
    });

    let chunks = 0;
    for await (const delta of result.textStream) {
      if (signal.aborted) break;
      write(`0:${JSON.stringify(delta)}\n`);
      chunks++;
    }

    const usage = await result.usage.catch(() => undefined);
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    // M2.5 §F-CB — compute the per-call cost server-side using the price
    // snapshot we already captured on ctx, so the renderer can render a
    // CostBadge without doing the math twice. Falls back to null when no
    // price is configured (e.g. local Ollama or BYO model with empty pricing).
    let actualUsd: number | null = null;
    try {
      const c = calculateCostUsd({
        priceInputPer1m: ctx.priceInputPer1m,
        priceOutputPer1m: ctx.priceOutputPer1m,
        pricePerCall: ctx.pricePerCall,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      });
      actualUsd = c ?? null;
    } catch {
      actualUsd = null;
    }
    // AI SDK reports `finishReason: 'content-filter'` when the upstream
    // refused to deliver / cut off the response for safety reasons. Map it
    // to the same `provider_error/content_filter` wire frame as exception
    // path so the Renderer can show one consistent banner. Per spec §7.5.2
    // a content_filter outcome is NOT a model failure (do not strike).
    const finishReason = await result.finishReason.catch(() => undefined);
    if (!signal.aborted && finishReason === 'content-filter') {
      // Emit failure_decision BEFORE the `3:` error frame (M2 §1.3 frame order).
      // We use the `8:` annotation frame so the payload is bound to the
      // assistant message — `2:` data frames are not message-scoped and would
      // require renderer-side bookkeeping to associate with the failure.
      const decision = buildFailureDecision('content_filter', ctx, modelsRepo, memoriesRepo);
      write(`8:${JSON.stringify([decision])}\n`);
      write(
        `3:${JSON.stringify(
          'provider_error/content_filter: 内容被供应商安全策略拦截',
        )}\n`,
      );
      write(
        `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens, completionTokens } })}\n`,
      );
      ctx.log.warn({ chunks }, 'chat.upstream_content_filter');
      return;
    }

    write(
      `8:${JSON.stringify([
        {
          type: 'cost',
          message_id: ctx.messageId,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          actual_usd: actualUsd,
          duration_ms: Date.now() - startedAt,
        },
      ])}\n`,
    );

    write(
      `e:${JSON.stringify({
        finishReason: signal.aborted ? 'abort' : 'stop',
        usage: { promptTokens, completionTokens },
        isContinued: false,
      })}\n`,
    );
    write(
      `d:${JSON.stringify({
        finishReason: signal.aborted ? 'abort' : 'stop',
        usage: { promptTokens, completionTokens },
      })}\n`,
    );
    ctx.log.info({ chunks, durationMs: Date.now() - startedAt }, 'chat.upstream_done');
  } catch (e) {
    if (signal.aborted) {
      ctx.log.warn('chat.upstream_aborted');
    } else {
      const status = (e as { statusCode?: number; status?: number })?.statusCode
        ?? (e as { status?: number })?.status;
      const forced = (e as { _forcedClassification?: string })?._forcedClassification;
      const cls = forced
        ? { classification: forced, message: `forced ${forced}` }
        : classifyProviderError({ status, err: e });
      const msg = e instanceof Error ? e.message : String(e);
      // Sanitize before logging — AI SDK's APICallError carries
      // `requestBodyValues` which contains user prompts and base64 image
      // attachments. Pino's redaction keys won't reach those nested fields,
      // so strip them here before they hit the log sink.
      const safeErr = {
        name: e instanceof Error ? e.name : typeof e,
        message: msg,
        status,
      };
      ctx.log.error(
        { err: safeErr, classification: cls },
        'chat.upstream_failed',
      );
      // Wire format per spec §7.5.2 + M2 §1.3: emit failure_decision
      // annotation BEFORE the `3:` error frame so renderers can render
      // a decision card from a single end-of-stream payload. Uses the
      // `8:` annotation frame (message-bound) for parity with meta/cost.
      const decision = buildFailureDecision(cls.classification, ctx, modelsRepo, memoriesRepo);
      write(`8:${JSON.stringify([decision])}\n`);
      write(
        `3:${JSON.stringify(`provider_error/${cls.classification}: ${cls.message || msg}`)}\n`,
      );
      write(
        `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
      );
    }
  } finally {
    stream.end();
  }
}

async function produceMockStream(
  stream: PassThrough,
  isAborted: () => boolean,
  ctx: ProduceCtx,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const startedAt = Date.now();
  const write = (line: string): boolean => stream.write(line);

  // Lead annotation so the renderer knows which message this stream belongs to.
  write(
    `8:${JSON.stringify([
      { type: 'meta', conversation_id: ctx.conversationId, message_id: ctx.messageId, model_id: ctx.modelId },
    ])}\n`,
  );

  // dev-only test hook: short-circuit to a synthesized failure_decision +
  // `3:` error frame. Mirrors produceUpstreamStream so E2E can exercise the
  // renderer card without configuring a real provider.
  if (ctx.forcedClassification) {
    const cls = (ctx.forcedClassification === 'quota'
      || ctx.forcedClassification === 'network'
      || ctx.forcedClassification === 'rate_limit'
      || ctx.forcedClassification === 'content_filter'
      || ctx.forcedClassification === 'auth'
      || ctx.forcedClassification === 'unknown')
      ? ctx.forcedClassification
      : 'unknown';
    const decision = buildFailureDecision(cls, ctx, modelsRepo, memoriesRepo);
    write(`8:${JSON.stringify([decision])}\n`);
    write(`3:${JSON.stringify(`provider_error/${cls}: forced ${cls}`)}\n`);
    write(
      `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
    );
    stream.end();
    return;
  }

  const text = mockReply(ctx.userText);
  let i = 0;
  for (const chunk of chunkText(text, 8)) {
    if (isAborted()) {
      ctx.log.warn({ chunks: i }, 'chat.client_aborted');
      stream.end();
      return;
    }
    write(`0:${JSON.stringify(chunk)}\n`);
    i++;
    await sleep(40);
  }

  write(
    `8:${JSON.stringify([
      {
        type: 'cost',
        message_id: ctx.messageId,
        input_tokens: 12,
        output_tokens: text.length,
        actual_usd: 0.00009,
        duration_ms: Date.now() - startedAt,
      },
    ])}\n`,
  );

  const usage = { promptTokens: 12, completionTokens: text.length };
  write(`e:${JSON.stringify({ finishReason: 'stop', usage, isContinued: false })}\n`);
  write(`d:${JSON.stringify({ finishReason: 'stop', usage })}\n`);
  stream.end();
}

function mockReply(userText: string): string {
  if (!userText) return 'Hello from Taori M0 spike. The end-to-end stream works. ✅';
  return `[M0 mock] You said: "${userText.slice(0, 200)}". ` +
    `End-to-end Renderer→Sidecar streaming is working. ✅`;
}

function* chunkText(s: string, size: number): Generator<string> {
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

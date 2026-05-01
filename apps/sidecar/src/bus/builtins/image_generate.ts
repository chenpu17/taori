/**
 * builtin.image_generate — M2 §2.4 + §4.4.
 *
 * Pipeline (success path):
 *   1. Look up `models` row by model_id. Snapshot price + capability.
 *   2. Look up `providers` row → pick adapter by `provider.type`.
 *   3. Adapter returns `{ b64, mime, width, height }`.
 *   4. Persist file: write bytes to a per-conversation directory under the
 *      sidecar data dir, insert `files` row.
 *   5. Insert `messages` row (role='assistant', parent_message_id=user_msg_id,
 *      attachments=[{file_id,kind:'image',mime,...}], status='complete').
 *   6. Return { file_id, width, height, content_type, assistant_message_id }.
 *      Bus auto-writes `cost_records(source_type='tool_call', feature='image',
 *      source_id=<assistant_message_id>)`.
 *
 * Test hook (`X-Test-Force-Image-Result`) is parsed in routes/tools.ts and
 * passed via ctx.testForce. This module never reaches a real adapter when
 * forced — keeps E2E hermetic.
 *
 * Adapters: openai (DALL-E), replicate, sd_webui. All return base64 data;
 * we never fetch URLs separately to avoid cross-host CORS / token leaks.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDescriptor, ToolContext } from '../index.js';
import type {
  ModelsRepo,
  ProvidersRepo,
  FilesRepo,
  MessagesRepo,
  ConversationsRepo,
} from '../../db/repos/index.js';
import type { Model } from '@taori/shared';
import type { KeyStore } from '../../keystore.js';

const InputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model_id: z.string().min(1),
});

export interface ImageGenerateOutput {
  file_id: string;
  width: number;
  height: number;
  content_type: string;
  assistant_message_id: string;
}

export type TestForceImageResult =
  | 'success'
  | 'quota'
  | 'content_filter'
  | 'billed_4xx'
  | null;

export interface ImageGenerateDeps {
  models: ModelsRepo;
  providers: ProvidersRepo;
  files: FilesRepo;
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  keystore: KeyStore;
  /** absolute root for image bytes; M2 reuses sidecar data dir */
  filesDir: string;
}

export interface ExtendedToolContext extends ToolContext {
  /** dev-only test hook (M2 §6.1) */
  testForce?: TestForceImageResult;
}
interface AdapterResult {
  b64: string;
  mime: string;
  width: number;
  height: number;
}

export function createImageGenerateTool(
  deps: ImageGenerateDeps,
): ToolDescriptor<z.infer<typeof InputSchema>, ImageGenerateOutput> {
  return {
    name: 'builtin.image_generate',
    description:
      'Generate an image from a text prompt using a registered image-capable model.',
    capability: 'image',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: InputSchema,
    async execute(input, ctx) {
      if (!ctx.conversationId) {
        throw vErr('conversation_id is required for image_generate');
      }
      // SECURITY: conversation_id ends up in `path.join(filesDir, id)`.
      // ToolInvokeRequestSchema in @taori/shared already applies the same
      // regex at the route boundary; this defense-in-depth check guards
      // direct callers (e.g., future internal pipelines) and surfaces a
      // domain error instead of a generic 400.
      if (!/^[A-Za-z0-9_-]+$/.test(ctx.conversationId)) {
        throw vErr('conversation_id has invalid format');
      }
      // Defense-in-depth: also confirm the conversation row exists. Stops
      // attackers that forge a realistic-looking ID and would otherwise
      // create empty directories under filesDir.
      if (!deps.conversations.get(ctx.conversationId)) {
        throw vErr(`conversation not found: ${ctx.conversationId}`);
      }
      if (!ctx.sourceMessageId) {
        throw vErr('source_message_id is required for image_generate');
      }
      const model = deps.models.get(input.model_id);
      if (!model) throw vErr(`model not found: ${input.model_id}`);
      if (model.capability !== 'image') {
        throw vErr(`model is not an image model: ${input.model_id}`);
      }

      const force = ctx.testForce ?? null;

      let adapterResult: AdapterResult | null = null;
      let upstreamErr: { classification: string; message: string } | null = null;
      let billedAnyway = false;

      if (force) {
        if (force === 'success') {
          adapterResult = synthesizeImage();
        } else if (force === 'billed_4xx') {
          // success=false but actual cost incurred (provider charged us)
          upstreamErr = { classification: 'unknown', message: 'forced billed_4xx' };
          billedAnyway = true;
        } else {
          upstreamErr = { classification: force, message: `forced ${force}` };
        }
      } else {
        const provider = model.provider_id ? deps.providers.get(model.provider_id) : null;
        if (!provider) throw vErr('provider not found for model');
        const apiKey = provider.api_key_ref
          ? await deps.keystore.read(provider.api_key_ref)
          : null;
        adapterResult = await callAdapter(provider.type, {
          baseUrl: provider.base_url,
          apiKey,
          modelName: model.model_name,
          prompt: input.prompt,
        });
      }

      const pricePerCall = model.price_per_call ?? 0.05;

      if (upstreamErr) {
        // Failure path — bus records cost (0 by default). For billed_4xx
        // we throw a special wrapper so the bus' cost-write notices the
        // billed amount (we extend bus next).
        const err = Object.assign(new Error(upstreamErr.message), {
          classification: upstreamErr.classification,
          billedCost: billedAnyway ? pricePerCall : 0,
        });
        throw err;
      }
      if (!adapterResult) throw new Error('image adapter returned empty result');

      const buf = Buffer.from(adapterResult.b64, 'base64');
      const ext = imageExtension(adapterResult.mime);
      const dir = path.join(deps.filesDir, ctx.conversationId);
      await fs.mkdir(dir, { recursive: true });
      const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const fullPath = path.join(dir, filename);
      await fs.writeFile(fullPath, buf);

      const targetMessageId = ctx.targetMessageId ?? null;
      const fileRow = deps.files.insert({
        conversation_id: ctx.conversationId,
        message_id: targetMessageId,
        original_path: fullPath,
        mime_type: adapterResult.mime,
        size_bytes: buf.length,
      });
      const imageAttachment = {
        file_id: fileRow.id,
        kind: 'image',
        mime: adapterResult.mime,
        width: adapterResult.width,
        height: adapterResult.height,
        data_b64: adapterResult.b64,
      };

      const assistantMessageId = targetMessageId ?? deps.messages.insert({
        conversation_id: ctx.conversationId,
        role: 'assistant',
        content: `Generated with ${model.model_name}`,
        model_id: model.id,
        status: 'complete',
        parent_message_id: ctx.sourceMessageId,
        attachments: JSON.stringify([imageAttachment]),
      }).id;

      if (targetMessageId) {
        const target = deps.messages.get(targetMessageId);
        const existing = parseAttachments(target?.attachments);
        deps.messages.updateAttachments(targetMessageId, JSON.stringify([...existing, imageAttachment]));
      }

      return {
        output: {
          file_id: fileRow.id,
          width: adapterResult.width,
          height: adapterResult.height,
          content_type: adapterResult.mime,
          assistant_message_id: assistantMessageId,
        },
        cost: {
          actual_usd: pricePerCall,
          model_id: model.id,
          model_name_snapshot: model.model_name,
          price_per_call_snapshot: model.price_per_call ?? null,
          assistant_message_id: assistantMessageId,
        },
      };
    },
  };
}

function parseAttachments(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function vErr(msg: string): Error {
  return Object.assign(new Error(msg), { classification: 'validation_error' });
}

async function callAdapter(
  type: string,
  args: { baseUrl: string; apiKey: string | null; modelName: string; prompt: string },
): Promise<AdapterResult> {
  switch (type) {
    case 'openai':
      return adapterOpenAI(args);
    case 'replicate':
      return adapterReplicate(args);
    case 'sd_webui':
      return adapterSdWebui(args);
    case 'volcengine_ark':
      return adapterVolcengineArk(args);
    case 'huawei_maas':
      return adapterHuaweiMaas(args);
    default:
      throw vErr(`unsupported provider type for image_generate: ${type}`);
  }
}

/**
 * Volcengine Ark text-to-image (doubao-seedream / seedance-image families).
 * Ark mirrors the OpenAI Images API at /api/v3/images/generations and accepts
 * the same `prompt`/`model`/`size` shape, returning either b64_json or URL.
 */
async function adapterVolcengineArk(args: {
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
  prompt: string;
}): Promise<AdapterResult> {
  if (!args.apiKey) throw vErr('Ark image adapter requires api_key');
  const url = `${args.baseUrl.replace(/\/+$/, '')}/images/generations`;
  // Ark Seedream 4.x requires ≥3,686,400 pixels (min 1920×1920).
  // Use 1920×1920 as the default square size which all Seedream models support.
  const imgSize = '1920x1920';
  const imgDim = 1920;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.modelName,
      prompt: args.prompt,
      n: 1,
      size: imgSize,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Ark images upstream ${res.status}: ${text.slice(0, 200)}`);
    Object.assign(err, { upstreamStatus: res.status });
    throw err;
  }
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const item = json.data?.[0];
  if (item?.b64_json) {
    return { ...parseBase64Image(item.b64_json), width: imgDim, height: imgDim };
  }
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Ark image fetch failed ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return {
      b64: buf.toString('base64'),
      mime: imgRes.headers.get('content-type') ?? 'image/png',
      width: imgDim,
      height: imgDim,
    };
  }
  throw new Error('Ark images: empty response');
}

/**
 * Huawei MaaS image generation lives at /v1/images/generations, while chat
 * uses the OpenAI-compatible /openai/v1 prefix. Derive the image endpoint
 * from the configured chat base URL so users only configure one provider.
 */
async function adapterHuaweiMaas(args: {
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
  prompt: string;
}): Promise<AdapterResult> {
  if (!args.apiKey) throw vErr('Huawei MaaS image adapter requires api_key');
  const imageBase = args.baseUrl
    .replace(/\/+$/, '')
    .replace(/\/openai\/v1$/i, '/v1');
  const url = `${imageBase}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.modelName,
      prompt: args.prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Huawei MaaS images upstream ${res.status}: ${text.slice(0, 200)}`);
    Object.assign(err, { upstreamStatus: res.status });
    throw err;
  }
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const item = json.data?.[0];
  if (item?.b64_json) {
    return { ...parseBase64Image(item.b64_json), width: 1024, height: 1024 };
  }
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Huawei MaaS image fetch failed ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return {
      b64: buf.toString('base64'),
      mime: imgRes.headers.get('content-type') ?? 'image/png',
      width: 1024,
      height: 1024,
    };
  }
  throw new Error('Huawei MaaS images: empty response');
}

async function adapterOpenAI(args: {
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
  prompt: string;
}): Promise<AdapterResult> {
  if (!args.apiKey) throw vErr('OpenAI image adapter requires api_key');
  const url = `${args.baseUrl.replace(/\/+$/, '')}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.modelName,
      prompt: args.prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`OpenAI images upstream ${res.status}: ${text.slice(0, 200)}`);
    Object.assign(err, { upstreamStatus: res.status });
    throw err;
  }
  const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI images: missing b64_json');
  return { ...parseBase64Image(b64), width: 1024, height: 1024 };
}

async function adapterReplicate(args: {
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
  prompt: string;
}): Promise<AdapterResult> {
  if (!args.apiKey) throw vErr('Replicate adapter requires api_key');
  const url = `${args.baseUrl.replace(/\/+$/, '')}/predictions`;
  // model_name format: "<owner>/<name>:<version>"
  const colon = args.modelName.lastIndexOf(':');
  if (colon < 0) throw vErr('Replicate model_name must be "<owner>/<name>:<version>"');
  const version = args.modelName.slice(colon + 1);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Token ${args.apiKey}`,
      'content-type': 'application/json',
      prefer: 'wait',
    },
    body: JSON.stringify({ version, input: { prompt: args.prompt } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Replicate upstream ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    output?: string | string[];
    status?: string;
  };
  const outputUrl = Array.isArray(json.output) ? json.output[0] : json.output;
  if (!outputUrl) throw new Error('Replicate: missing output url');
  const fileRes = await fetch(outputUrl);
  if (!fileRes.ok) throw new Error(`Replicate output fetch ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const mime = fileRes.headers.get('content-type') ?? 'image/png';
  return { b64: buf.toString('base64'), mime, width: 0, height: 0 };
}

async function adapterSdWebui(args: {
  baseUrl: string;
  prompt: string;
}): Promise<AdapterResult> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/sdapi/v1/txt2img`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: args.prompt, steps: 20 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SD WebUI upstream ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { images?: string[] };
  const b64 = json.images?.[0];
  if (!b64) throw new Error('SD WebUI: missing images[0]');
  return { ...parseBase64Image(b64), width: 512, height: 512 };
}

function parseBase64Image(raw: string, fallbackMime = 'image/png'): {
  b64: string;
  mime: string;
} {
  const trimmed = raw.trim();
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  if (!match) {
    return { b64: trimmed, mime: normalizeImageMime(fallbackMime) };
  }
  const [, mime, b64] = match;
  return {
    b64: (b64 ?? '').replace(/\s/g, ''),
    mime: normalizeImageMime(mime),
  };
}

function normalizeImageMime(mime: string | undefined): string {
  const lower = (mime ?? 'image/png').toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

function imageExtension(mime: string): string {
  switch (normalizeImageMime(mime)) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}

// Synthesize a 1x1 PNG for tests. Smallest valid PNG.
function synthesizeImage(): AdapterResult {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  return { b64, mime: 'image/png', width: 1, height: 1 };
}

declare module '../index.js' {}

/**
 * Minimal OpenAI-compatible mock server used by M3.A.6 DoD e2e to drive the
 * full happy-path round-table flow without hitting real LLMs.
 *
 * Behaviour key: routes by SYSTEM prompt content because each pipeline stage
 * uses a distinctive Chinese phrase:
 *   - analyzer    → "圆桌主持人" → returns analyzer JSON (3 participants)
 *   - summarizer  → "圆桌总结员" → streams summary JSON
 *   - round       → otherwise   → streams a short "我认为…" speech per call
 *
 * Listens on 127.0.0.1:17891 (configurable via MOCK_OPENAI_PORT). Caller
 * configures providers in sidecar with base_url=http://127.0.0.1:17891/v1.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
}
interface MockModelListItem {
  id: string;
  object?: string;
  name?: string;
  status?: string | null;
  created?: number;
  version?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => p.text ?? '').join('');
}

function analyzerResponse(messages: ChatMessage[]): string {
  // Parse candidate model lines from user prompt: "- <id>: <display> (<name>)".
  const userMsg = messages.find((m) => m.role === 'user');
  const userText = userMsg ? textOf(userMsg) : '';
  const ids: { id: string; display: string }[] = [];
  for (const line of userText.split(/\r?\n/)) {
    const m = /^-\s+(mdl_[A-Za-z0-9_-]{6,}):\s+(.+?)\s+\(/.exec(line);
    if (m) ids.push({ id: m[1], display: m[2] });
  }
  // Fall back to first three even if duplicates; spec needs ≥2 distinct rows.
  const m0 = ids[0];
  const m1 = ids[1] ?? ids[0];
  const m2 = ids[2] ?? ids[1] ?? ids[0];
  if (!m0) {
    return JSON.stringify({ error: 'no candidate models in mock prompt' });
  }
  return JSON.stringify({
    topic_type: 'business',
    complexity: 'medium',
    suggested_mode: 'deep',
    participant_count: 3,
    participants: [
      {
        model_id: m0.id,
        display_name: m0.display,
        role_label: '战略视角',
        persona_prompt:
          '你是商业战略顾问，从业务模式、市场定位和长期增长角度分析问题。',
      },
      {
        model_id: m1.id,
        display_name: m1.display,
        role_label: '用户视角',
        persona_prompt: '你是用户研究专家，从终端用户体验和接受度角度分析问题。',
      },
      {
        model_id: m2.id,
        display_name: m2.display,
        role_label: '技术视角',
        persona_prompt: '你是工程负责人，从实现复杂度与运维成本角度分析问题。',
      },
    ],
    summarizer_model_id: m0.id,
  });
}

function summaryResponse(): string {
  return JSON.stringify({
    consensus: ['采用分层定价策略', '需要清晰的免费版边界'],
    divergence: [
      {
        topic: '是否引入按量计费',
        positions: [
          { role: '战略视角', stance: '支持，提升弹性' },
          { role: '技术视角', stance: '反对，运维复杂' },
        ],
      },
    ],
    risks: ['免费版滥用导致单位经济恶化'],
    recommended_decision: '先采用分层订阅，6 个月后评估是否引入按量计费',
    next_steps: ['确定免费版功能边界', '设计三档订阅价格'],
  });
}

function roundSpeech(role: 'm0' | 'm1' | 'm2'): string {
  const map = {
    m0: '从战略层面看，分层定价能更好地匹配不同客户群体的支付能力，建议采用 free / pro / enterprise 三档结构。',
    m1: '从用户视角，定价透明度比绝对价格更重要；用户讨厌按量计费的不确定性，分层订阅心理负担更轻。',
    m2: '从技术实现看，分层订阅的计量复杂度低，按量计费需要额外的 metering 与对账系统。',
  };
  return map[role];
}

function classifyAndRoleFromMessages(messages: ChatMessage[]): {
  kind: 'analyzer' | 'summarizer' | 'round';
  role: 'm0' | 'm1' | 'm2';
} {
  const sys = messages.find((m) => m.role === 'system');
  const sysText = sys ? textOf(sys) : '';
  if (sysText.includes('圆桌主持人')) return { kind: 'analyzer', role: 'm0' };
  if (sysText.includes('圆桌总结员')) return { kind: 'summarizer', role: 'm0' };
  let role: 'm0' | 'm1' | 'm2' = 'm0';
  if (sysText.includes('用户研究')) role = 'm1';
  else if (sysText.includes('工程负责人') || sysText.includes('实现复杂度')) {
    role = 'm2';
  }
  return { kind: 'round', role };
}

function sseChunk(content: string, model: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, delta: { content }, finish_reason: null },
      ],
    }) +
    '\n\n'
  );
}

function sseFinal(model: string, prompt: number, completion: number): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      },
    }) +
    '\n\n'
  );
}

function sseToolCallStart(model: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_image_generate_1',
                type: 'function',
                function: { name: 'image_generate', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    '\n\n'
  );
}

function sseToolCallArgs(model: string, args: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
          finish_reason: null,
        },
      ],
    }) +
    '\n\n'
  );
}

function sseToolCallFinal(model: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    }) +
    '\n\n'
  );
}

function sseNamedToolCallStart(model: string, name: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: `chatcmpl-mock-${name}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${name}_1`,
                type: 'function',
                function: { name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    '\n\n'
  );
}

function sseNamedToolCallArgs(model: string, args: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: `chatcmpl-mock-${model}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
          finish_reason: null,
        },
      ],
    }) +
    '\n\n'
  );
}

function sseNamedToolCallFinal(model: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id: `chatcmpl-mock-${model}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 24, completion_tokens: 4, total_tokens: 28 },
    }) +
    '\n\n'
  );
}

function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'tool');
}

function hasImageInput(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'image' || p.type === 'image_url'),
  );
}

function shouldMockImageTool(body: ChatRequest): boolean {
  if (!Array.isArray(body.tools) || body.tools.length === 0 || hasToolResult(body.messages)) {
    return false;
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser).toLowerCase() : '';
  const negative =
    /不要|别|无需|不用|不要生成|不要画|do not|don't|dont|without generating|no image/.test(text);
  if (negative) return false;
  return (
    /生成|画|绘制|图片|图像|照片|海报|generate|draw|create|make|image|picture|photo|illustration|poster/.test(
      text,
    )
  );
}

function shouldMockWebTool(body: ChatRequest): boolean {
  if (!Array.isArray(body.tools) || body.tools.length === 0 || hasToolResult(body.messages)) {
    return false;
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser).toLowerCase() : '';
  if (!/搜索|检索|查找|网页|抓取|读取网页|fetch|search|browse|web/.test(text)) {
    return false;
  }
  const names = availableToolNames(body);
  const wantsFetch = /抓取|读取网页|fetch|url|https?:\/\//.test(text);
  return wantsFetch ? names.has('web_fetch') : names.has('web_search');
}

function pickMcpToolCall(body: ChatRequest): { name: string; args: Record<string, unknown> } | null {
  if (!Array.isArray(body.tools) || body.tools.length === 0 || hasToolResult(body.messages)) {
    return null;
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser).toLowerCase() : '';
  if (!/mcp|工具|tool/.test(text)) return null;
  const name = [...availableToolNames(body)].find((item) => item.startsWith('mcp_'));
  return name ? { name, args: { text: 'roundtable mcp evidence' } } : null;
}

function pickWebToolCall(body: ChatRequest): {
  name: 'web_search' | 'web_fetch';
  args: Record<string, unknown>;
} {
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser).toLowerCase() : '';
  if (/抓取|读取网页|fetch|url|https?:\/\//.test(text)) {
    return {
      name: 'web_fetch',
      args: {
        url: 'https://example.com/',
        format: 'markdown',
        max_chars: 1200,
      },
    };
  }
  return {
    name: 'web_search',
    args: {
      query: 'Taori multi model assistant',
      num_results: 2,
    },
  };
}

function availableToolNames(body: ChatRequest): Set<string> {
  const names = new Set<string>();
  for (const item of body.tools ?? []) {
    if (!item || typeof item !== 'object') continue;
    const fn = (item as { function?: { name?: unknown } }).function;
    if (typeof fn?.name === 'string') names.add(fn.name);
  }
  return names;
}

export function startMockOpenAI(
  port = 17891,
  opts: {
    streamDelayMs?: number;
    fixedReply?: string;
    imageToolCalls?: boolean;
    webToolCalls?: boolean;
    mcpToolCalls?: boolean;
    failAfterToolResult?: boolean;
    models?: MockModelListItem[];
    onChatRequest?: (body: ChatRequest) => void;
  } = {},
): http.Server {
  const server = http.createServer((req, res) => {
    const path = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
    if (req.method === 'GET' && path.endsWith('/key')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { label: 'mock-key' } }));
      return;
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: opts.models ?? [
            { id: 'mock-strategy', object: 'model' },
            { id: 'mock-user', object: 'model' },
            { id: 'mock-tech', object: 'model' },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url?.includes('/images/generations')) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                b64_json:
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
              },
            ],
          }),
        );
      });
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: ChatRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      opts.onChatRequest?.(body);
      if (opts.failAfterToolResult && hasToolResult(body.messages)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream failed after tool result' } }));
        return;
      }
      const { kind, role } = classifyAndRoleFromMessages(body.messages);
      const text =
        opts.fixedReply ??
        (opts.imageToolCalls && hasToolResult(body.messages)
          ? '图片已生成。'
          : hasImageInput(body.messages)
          ? '我看到了这张图片：主体清晰、背景简洁，适合继续做风格描述或用途分析。'
          : kind === 'analyzer'
          ? analyzerResponse(body.messages)
          : kind === 'summarizer'
          ? summaryResponse()
          : roundSpeech(role));

      if (opts.imageToolCalls && shouldMockImageTool(body)) {
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock-tool',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_image_generate_1',
                        type: 'function',
                        function: {
                          name: 'image_generate',
                          arguments: JSON.stringify({ prompt: 'cute duck' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseToolCallStart(body.model));
        res.write(sseToolCallArgs(body.model, JSON.stringify({ prompt: 'cute duck' })));
        res.write(sseToolCallFinal(body.model));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (opts.webToolCalls && shouldMockWebTool(body)) {
        const { name, args } = pickWebToolCall(body);
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock-web-tool',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: `call_${name}_1`,
                        type: 'function',
                        function: {
                          name,
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseNamedToolCallStart(body.model, name));
        res.write(sseNamedToolCallArgs(body.model, JSON.stringify(args)));
        res.write(sseNamedToolCallFinal(body.model));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const mcpCall = opts.mcpToolCalls ? pickMcpToolCall(body) : null;
      if (mcpCall) {
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock-mcp-tool',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: `call_${mcpCall.name}_1`,
                        type: 'function',
                        function: {
                          name: mcpCall.name,
                          arguments: JSON.stringify(mcpCall.args),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseNamedToolCallStart(body.model, mcpCall.name));
        res.write(sseNamedToolCallArgs(body.model, JSON.stringify(mcpCall.args)));
        res.write(sseNamedToolCallFinal(body.model));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 50,
              completion_tokens: text.length,
              total_tokens: 50 + text.length,
            },
          }),
        );
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Allow specs to slow the stream down for abort/race tests via the
      // factory option. Defaults to 5ms to preserve existing fast-path tests.
      const delayMs = opts.streamDelayMs ?? 5;
      const step = Math.max(8, Math.ceil(text.length / 6));
      let i = 0;
      function tick(): void {
        if (i >= text.length) {
          res.write(sseFinal(body.model, 50, text.length));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const slice = text.slice(i, i + step);
        i += step;
        res.write(sseChunk(slice, body.model));
        setTimeout(tick, delayMs);
      }
      tick();
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (process.argv[1]?.endsWith('_mock-openai-server.ts')) {
  const s = startMockOpenAI(Number(process.env.MOCK_OPENAI_PORT ?? 17891));
  s.on('listening', () => {
    const addr = s.address() as AddressInfo;
    console.log(`mock-openai listening on ${addr.address}:${addr.port}`);
  });
}

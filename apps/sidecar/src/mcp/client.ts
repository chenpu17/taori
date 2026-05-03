import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function listMcpTools(config: McpServerConfig): Promise<McpToolInfo[]> {
  const session = new McpStdioSession(config);
  try {
    await session.start();
    await session.initialize();
    const result = await session.request('tools/list', {});
    const tools = result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)
      ? (result as { tools: unknown[] }).tools
      : [];
    return tools
      .map((tool): McpToolInfo | null => {
        if (!tool || typeof tool !== 'object') return null;
        const row = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof row.name !== 'string' || row.name.trim() === '') return null;
        return {
          name: row.name,
          description: typeof row.description === 'string' ? row.description : row.name,
          inputSchema: row.inputSchema,
        };
      })
      .filter((tool): tool is McpToolInfo => tool !== null);
  } finally {
    session.close();
  }
}

export async function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = new McpStdioSession(config);
  try {
    await session.start();
    await session.initialize();
    return await session.request('tools/call', {
      name: toolName,
      arguments: args,
    });
  } finally {
    session.close();
  }
}

class McpStdioSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly config: McpServerConfig) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', () => {
      /* stderr is intentionally not surfaced; failed requests carry context. */
    });
    child.on('exit', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server exited before response ${id}`));
      }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'taori', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child) throw new Error('MCP session is not started');
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
    this.child.stdin.write(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  close(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const [, pending] of this.pending) clearTimeout(pending.timer);
    this.pending.clear();
    child.stdin.end();
    child.kill();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buffer.slice(0, sep).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(sep + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = sep + 4;
      const end = start + len;
      if (this.buffer.byteLength < end) return;
      const payload = this.buffer.slice(start, end).toString('utf8');
      this.buffer = this.buffer.slice(end);
      this.handleMessage(payload);
    }
  }

  private handleMessage(payload: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(payload) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ''}`));
      return;
    }
    pending.resolve(message.result);
  }
}

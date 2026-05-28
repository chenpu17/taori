import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveManagedMcpServerConfig } from './managed.js';

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
  stdio_protocol?: 'content-length' | 'jsonl';
}

export interface McpServerLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type McpClassification = 'tool_timeout' | 'mcp_crashed';

interface ClassifiedMcpError extends Error {
  classification: McpClassification;
}

interface PooledSession {
  session: McpStdioSession;
  ready: Promise<McpStdioSession>;
}

const pool = new Map<string, PooledSession>();
const logsByKey = new Map<string, McpServerLogEntry[]>();
const MAX_LOG_ENTRIES = 200;

export async function listMcpTools(config: McpServerConfig): Promise<McpToolInfo[]> {
  const resolvedConfig = resolveManagedMcpServerConfig(config);
  const key = sessionKey(resolvedConfig);
  try {
    const session = await getPooledSession(resolvedConfig);
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
  } catch (e) {
    appendSessionLog(key, 'error', `tools/list failed: ${e instanceof Error ? e.message : String(e)}`);
    if (isFatalMcpError(e)) closeMcpServerSession(config);
    throw e;
  }
}

export async function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const resolvedConfig = resolveManagedMcpServerConfig(config);
  const key = sessionKey(resolvedConfig);
  try {
    const session = await getPooledSession(resolvedConfig);
    return await session.request('tools/call', {
      name: toolName,
      arguments: args,
    });
  } catch (e) {
    appendSessionLog(key, 'error', `tools/call ${toolName} failed: ${e instanceof Error ? e.message : String(e)}`);
    if (isFatalMcpError(e)) closeMcpServerSession(config);
    throw e;
  }
}

export function closeMcpServerSession(config: McpServerConfig): void {
  const key = sessionKey(resolveManagedMcpServerConfig(config));
  const pooled = pool.get(key);
  pool.delete(key);
  appendSessionLog(key, 'info', 'session closed');
  pooled?.session.close();
}

export function closeAllMcpSessions(): void {
  for (const pooled of pool.values()) pooled.session.close();
  pool.clear();
}

export function getMcpServerLogs(config: McpServerConfig, limit = 80): McpServerLogEntry[] {
  const entries = logsByKey.get(sessionKey(resolveManagedMcpServerConfig(config))) ?? [];
  return entries.slice(-Math.max(1, limit));
}

export function isMcpServerSessionRunning(config: McpServerConfig): boolean {
  const pooled = pool.get(sessionKey(resolveManagedMcpServerConfig(config)));
  return pooled ? pooled.session.isRunning() : false;
}

async function getPooledSession(config: McpServerConfig): Promise<McpStdioSession> {
  const key = sessionKey(config);
  const existing = pool.get(key);
  if (existing) return existing.ready;

  const session = new McpStdioSession(config);
  const ready = (async () => {
    try {
      await session.start();
      await session.initialize();
      return session;
    } catch (e) {
      session.close();
      if (pool.get(key)?.session === session) pool.delete(key);
      throw e;
    }
  })();
  pool.set(key, { session, ready });
  return ready;
}

function appendSessionLog(
  key: string,
  level: McpServerLogEntry['level'],
  message: string,
): void {
  const entries = logsByKey.get(key) ?? [];
  entries.push({
    ts: Date.now(),
    level,
    message: message.slice(0, 2000),
  });
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
  logsByKey.set(key, entries);
}

function sessionKey(config: McpServerConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args,
    stdio_protocol: config.stdio_protocol ?? 'content-length',
    env: Object.keys(config.env)
      .sort()
      .map((key) => [key, config.env[key]]),
  });
}

function classifiedError(message: string, classification: McpClassification): ClassifiedMcpError {
  return Object.assign(new Error(message), { classification });
}

function isFatalMcpError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'classification' in err &&
      ((err as { classification?: unknown }).classification === 'tool_timeout' ||
        (err as { classification?: unknown }).classification === 'mcp_crashed'),
  );
}

function processExitedMessage(code: number | null, signal: NodeJS.Signals | null): string {
  return `MCP server exited${code == null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`;
}

function isChildAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode == null && child.signalCode == null && !child.killed;
}

function writeOrThrow(child: ChildProcessWithoutNullStreams, data: string | Buffer): void {
  const ok = child.stdin.write(data);
  if (!ok && child.stdin.destroyed) {
    throw classifiedError('MCP server stdin is closed', 'mcp_crashed');
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

  private readonly key: string;

  constructor(private readonly config: McpServerConfig) {
    this.key = sessionKey(config);
  }

  private get protocol(): 'content-length' | 'jsonl' {
    return this.config.stdio_protocol ?? 'content-length';
  }

  async start(): Promise<void> {
    if (this.child && isChildAlive(this.child)) return;
    if (this.child) this.close();
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    appendSessionLog(
      this.key,
      'info',
      `spawn ${this.config.command}${this.config.args.length > 0 ? ` ${this.config.args.join(' ')}` : ''}`,
    );
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) appendSessionLog(this.key, 'warn', trimmed);
      }
    });
    child.on('exit', (code, signal) => {
      appendSessionLog(this.key, 'warn', processExitedMessage(code, signal));
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          classifiedError(`${processExitedMessage(code, signal)} before response ${id}`, 'mcp_crashed'),
        );
      }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(classifiedError(`MCP server failed to start: ${err.message}`, 'mcp_crashed'));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(classifiedError(processExitedMessage(code, signal), 'mcp_crashed'));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'taori', version: '0.0.2' },
    });
    this.notify('notifications/initialized', {});
    appendSessionLog(this.key, 'info', 'initialized');
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child) throw new Error('MCP session is not started');
    if (!isChildAlive(this.child)) {
      throw classifiedError('MCP server is not running', 'mcp_crashed');
    }
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const payload = this.serializeMessage(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        appendSessionLog(this.key, 'error', `request timeout: ${method}`);
        reject(classifiedError(`MCP request timed out: ${method}`, 'tool_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        writeOrThrow(this.child!, payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || !isChildAlive(this.child)) return;
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    const payload = this.serializeMessage(message);
    writeOrThrow(this.child, payload);
  }

  close(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const [, pending] of this.pending) clearTimeout(pending.timer);
    this.pending.clear();
    // Detach listeners before kill so late stderr flushes don't flood logs.
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    if (!child.stdin.destroyed) child.stdin.end();
    child.kill();
  }

  isRunning(): boolean {
    return Boolean(this.child && isChildAlive(this.child));
  }

  private onData(chunk: Buffer): void {
    if (this.protocol === 'jsonl') {
      this.onJsonlData(chunk);
      return;
    }
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

  private onJsonlData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const payload = this.buffer.slice(0, newline).toString('utf8').replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (payload) {
        this.handleMessage(payload);
      }
    }
  }

  private serializeMessage(message: JsonRpcMessage): Buffer {
    const payload = JSON.stringify(message);
    if (this.protocol === 'jsonl') {
      return Buffer.from(`${payload}\n`, 'utf8');
    }
    return Buffer.from(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`, 'utf8');
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
      appendSessionLog(this.key, 'error', message.error.message ?? `MCP error ${message.error.code ?? ''}`);
      pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ''}`));
      return;
    }
    pending.resolve(message.result);
  }
}

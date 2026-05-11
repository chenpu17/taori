import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const MANAGED_BOCHA_COMMAND = '__taori_managed_bocha__';
export const MANAGED_MCP_KIND_ENV_KEY = 'TAORI_MANAGED_MCP_KIND';
export const MANAGED_BOCHA_KIND = 'bocha-search';
export const MANAGED_BOCHA_API_KEY_ENV = 'BOCHA_API_KEY';
export const MANAGED_BOCHA_AUTH_HEADER_ENV = 'BOCHA_AUTH_HEADER';
export const MANAGED_BOCHA_ENDPOINT = 'https://mcp.bochaai.com/sse';

function resolveMcpRemoteProxyPath(): string {
  return require.resolve('mcp-remote/dist/proxy.js');
}

export function isManagedBochaServer(config: {
  command: string;
  env: Record<string, string>;
}): boolean {
  return (
    config.command === MANAGED_BOCHA_COMMAND &&
    config.env[MANAGED_MCP_KIND_ENV_KEY] === MANAGED_BOCHA_KIND
  );
}

export function resolveManagedMcpServerConfig(config: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (!isManagedBochaServer(config)) {
    return {
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }

  const apiKey = config.env[MANAGED_BOCHA_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error('搏查搜索 MCP 缺少 API Key，请先在工具设置里更新配置。');
  }

  const env = { ...config.env };
  delete env[MANAGED_BOCHA_API_KEY_ENV];
  env[MANAGED_BOCHA_AUTH_HEADER_ENV] = `Bearer ${apiKey}`;

  return {
    command: process.execPath,
    args: [
      resolveMcpRemoteProxyPath(),
      MANAGED_BOCHA_ENDPOINT,
      '--transport',
      'sse-only',
      '--header',
      `Authorization:\${${MANAGED_BOCHA_AUTH_HEADER_ENV}}`,
      '--silent',
    ],
    env,
  };
}

import { describe, expect, it } from 'vitest';
import {
  MANAGED_BOCHA_API_KEY_ENV,
  MANAGED_BOCHA_AUTH_HEADER_ENV,
  MANAGED_BOCHA_COMMAND,
  MANAGED_BOCHA_ENDPOINT,
  MANAGED_BOCHA_KIND,
  MANAGED_MCP_KIND_ENV_KEY,
  isManagedBochaServer,
  resolveManagedMcpServerConfig,
} from '../src/mcp/managed.js';

describe('managed MCP bridge', () => {
  it('recognizes Bocha managed server rows', () => {
    expect(
      isManagedBochaServer({
        command: MANAGED_BOCHA_COMMAND,
        env: {
          [MANAGED_MCP_KIND_ENV_KEY]: MANAGED_BOCHA_KIND,
        },
      }),
    ).toBe(true);
  });

  it('resolves the managed Bocha config into a local proxy command', () => {
    const resolved = resolveManagedMcpServerConfig({
      command: MANAGED_BOCHA_COMMAND,
      args: [],
      env: {
        [MANAGED_MCP_KIND_ENV_KEY]: MANAGED_BOCHA_KIND,
        [MANAGED_BOCHA_API_KEY_ENV]: 'sk-bocha-demo',
      },
    });

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual(
      expect.arrayContaining([
        MANAGED_BOCHA_ENDPOINT,
        '--transport',
        'sse-only',
        '--header',
        `Authorization:\${${MANAGED_BOCHA_AUTH_HEADER_ENV}}`,
      ]),
    );
    expect(resolved.env[MANAGED_BOCHA_AUTH_HEADER_ENV]).toBe('Bearer sk-bocha-demo');
    expect(resolved.env[MANAGED_BOCHA_API_KEY_ENV]).toBeUndefined();
  });
});

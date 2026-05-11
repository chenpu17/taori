import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupStaleDaemonState,
  formatHttpUrl,
  normalizeLocalConnectUrl,
  parseCliArgs,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from '../src/standalone-cli.js';

describe('standalone CLI helpers', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const file of tempFiles.splice(0)) {
      fs.rmSync(file, { force: true });
    }
  });

  it('parses foreground host/port/db flags', () => {
    expect(parseCliArgs(['--host', '0.0.0.0', '--port', '18901', '--db-path', './tmp.db', '--password', 'secret'])).toEqual({
      kind: 'serve',
      options: {
        host: '0.0.0.0',
        port: 18901,
        dbPath: path.resolve('./tmp.db'),
        accessPassword: 'secret',
      },
    });
    expect(parseCliArgs(['serve', '--host', '127.0.0.1', '--port', '17890'])).toEqual({
      kind: 'serve',
      options: {
        host: '127.0.0.1',
        port: 17890,
      },
    });
  });

  it('parses daemon lifecycle commands', () => {
    expect(parseCliArgs(['daemon', 'start', '--host', '0.0.0.0', '--log-file', './daemon.log', '--password', 'secret'])).toEqual({
      kind: 'daemon-start',
      options: {
        host: '0.0.0.0',
        logFile: path.resolve('./daemon.log'),
        accessPassword: 'secret',
      },
    });
    expect(parseCliArgs(['daemon', 'status'])).toEqual({ kind: 'daemon-status' });
    expect(parseCliArgs(['daemon', 'stop'])).toEqual({ kind: 'daemon-stop' });
    expect(parseCliArgs(['daemon', 'help'])).toEqual({ kind: 'daemon-help' });
  });

  it('parses help and version commands', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['version'])).toEqual({ kind: 'version' });
  });

  it('rejects malformed host values', () => {
    expect(() => parseCliArgs(['--host', 'http://0.0.0.0'])).toThrow('Host must not include a URL scheme');
    expect(() => parseCliArgs(['--host', '0.0.0.0/path'])).toThrow('Host must not include a path');
  });

  it('writes and reads daemon state', () => {
    const stateFile = path.join(os.tmpdir(), `taori-daemon-state-${Date.now()}.json`);
    tempFiles.push(stateFile);
    writeDaemonState(stateFile, {
      pid: process.pid,
      startedAt: Date.now(),
      host: '0.0.0.0',
      port: 17890,
      bindUrl: 'http://0.0.0.0:17890',
      localUrl: 'http://127.0.0.1:17890',
      bearer: 'dev_test',
      dbPath: '/tmp/taori.db',
      logFile: '/tmp/taori.log',
      loginUrl: 'http://0.0.0.0:17890/',
    });
    expect(readDaemonState(stateFile)).toMatchObject({
      pid: process.pid,
      host: '0.0.0.0',
      bindUrl: 'http://0.0.0.0:17890',
      localUrl: 'http://127.0.0.1:17890',
      loginUrl: 'http://0.0.0.0:17890/',
    });
  });

  it('drops stale daemon state when pid is gone', () => {
    const stateFile = path.join(os.tmpdir(), `taori-daemon-stale-${Date.now()}.json`);
    tempFiles.push(stateFile);
    writeDaemonState(stateFile, {
      pid: 999_999,
      startedAt: Date.now(),
      host: '127.0.0.1',
      port: 17890,
      bindUrl: 'http://127.0.0.1:17890',
      localUrl: 'http://127.0.0.1:17890',
      bearer: 'dev_test',
      dbPath: '/tmp/taori.db',
      logFile: '/tmp/taori.log',
    });
    expect(cleanupStaleDaemonState(stateFile)).toBeNull();
    expect(readDaemonState(stateFile)).toBeNull();
  });

  it('normalizes bind URLs for wildcard hosts', () => {
    expect(formatHttpUrl('0.0.0.0', 17890)).toBe('http://0.0.0.0:17890');
    expect(normalizeLocalConnectUrl('0.0.0.0', 17890)).toBe('http://127.0.0.1:17890');
    expect(normalizeLocalConnectUrl('::', 17890)).toBe('http://[::1]:17890');
  });

  it('removes daemon state files idempotently', () => {
    const stateFile = path.join(os.tmpdir(), `taori-daemon-remove-${Date.now()}.json`);
    tempFiles.push(stateFile);
    fs.writeFileSync(stateFile, '{}\n');
    removeDaemonState(stateFile);
    expect(fs.existsSync(stateFile)).toBe(false);
    removeDaemonState(stateFile);
  });
});

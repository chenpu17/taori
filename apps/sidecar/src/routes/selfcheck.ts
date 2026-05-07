/**
 * B3 — GET /v1/selfcheck
 *
 * Used by the in-app help-center "Run self-check" button. Reports local
 * coarse diagnostics so a user (or support) can see at a glance whether
 * Taori's local plumbing is healthy:
 *
 *   - sidecar       : the process is running and version exposed
 *   - database      : we can write + read + delete a probe memory key
 *   - default_model : at least one chat model is enabled (no upstream call)
 *
 * Keychain probing is opt-in via ?include_keychain=1 because macOS may show a
 * system authorization prompt whenever a dev binary reads or writes Keychain.
 */
import type { FastifyInstance } from 'fastify';
import type { BuildServerArgs } from '../server.js';
import { MemoriesRepo, ModelsRepo } from '../db/repos/index.js';

export interface SelfCheckItem {
  id: 'sidecar' | 'keystore' | 'database' | 'default_model';
  ok: boolean;
  detail: string;
  level: 'ok' | 'warn' | 'error';
}

export function registerSelfCheckRoute(
  app: FastifyInstance,
  args: BuildServerArgs,
): void {
  app.get<{
    Querystring: { include_keychain?: string };
  }>('/v1/selfcheck', async (req) => {
    const checks: SelfCheckItem[] = [];
    const includeKeychain = req.query.include_keychain === '1';

    // 1. Sidecar liveness — trivially true if we're handling this request.
    checks.push({
      id: 'sidecar',
      ok: true,
      level: 'ok',
      detail: `version ${args.config.version}, uptime ${Math.floor(
        (Date.now() - args.startedAt) / 1000,
      )}s`,
    });

    // 2. Keystore round-trip (probe key, removed at end). This is intentionally
    // opt-in so the default self-check does not trigger macOS Keychain prompts.
    if (includeKeychain) {
      const probeKey = `__selfcheck_${Date.now()}_${Math.random()}`;
      try {
        await args.keystore.write(probeKey, 'taori-probe');
        const v = await args.keystore.read(probeKey);
        await args.keystore.delete(probeKey);
        if (v === 'taori-probe') {
          checks.push({
            id: 'keystore',
            ok: true,
            level: 'ok',
            detail: '密钥读写正常',
          });
        } else {
          checks.push({
            id: 'keystore',
            ok: false,
            level: 'error',
            detail: `读取值不一致: ${String(v)}`,
          });
        }
      } catch (e) {
        checks.push({
          id: 'keystore',
          ok: false,
          level: 'error',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      checks.push({
        id: 'keystore',
        ok: true,
        level: 'warn',
        detail: '已跳过系统钥匙串深度检查，避免弹出系统授权提示',
      });
    }

    // 3. Database round-trip via memories table (a low-impact place to write).
    try {
      const mem = new MemoriesRepo(args.db);
      const k = `__selfcheck_${Date.now()}`;
      mem.set('global', null, k, 'ok');
      const got = mem.get('global', null, k);
      mem.delete('global', null, k);
      if (got === 'ok') {
        checks.push({
          id: 'database',
          ok: true,
          level: 'ok',
          detail: '数据库读写正常',
        });
      } else {
        checks.push({
          id: 'database',
          ok: false,
          level: 'error',
          detail: `读取值不一致: ${String(got)}`,
        });
      }
    } catch (e) {
      checks.push({
        id: 'database',
        ok: false,
        level: 'error',
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    // 4. Default model present (we don't actually probe upstream here).
    try {
      const models = new ModelsRepo(args.db);
      const all = models.list().filter((m) => m.capability === 'chat' && m.enabled);
      if (all.length === 0) {
        checks.push({
          id: 'default_model',
          ok: false,
          level: 'error',
          detail: '尚未配置任何对话模型',
        });
      } else {
        const def = all.find((m) => m.is_default_for === 'chat');
        if (def) {
          checks.push({
            id: 'default_model',
            ok: true,
            level: 'ok',
            detail: `默认对话模型: ${def.display_name}`,
          });
        } else {
          checks.push({
            id: 'default_model',
            ok: true,
            level: 'warn',
            detail: `已配置 ${all.length} 个对话模型，但未设置默认`,
          });
        }
      }
    } catch (e) {
      checks.push({
        id: 'default_model',
        ok: false,
        level: 'error',
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const overall = checks.every((c) => c.ok)
      ? checks.every((c) => c.level === 'ok')
        ? 'ok'
        : 'warn'
      : 'error';
    return { ok: overall !== 'error', overall, checks };
  });
}

/**
 * React hooks that turn Sidecar endpoints into live state for the UI.
 *
 * Each hook polls on a short interval, returns `{ data, error, loading }`,
 * and is safe to render before any data arrives — components show mock /
 * placeholder content until real data lands.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getCostBreakdown,
  getHealth,
  getMessages,
  getProviderKeyStatus,
  getRealtimeCost,
  listConversations,
  listModels,
  listProviders,
  type Conversation,
  type ConversationMessagesResponse,
  type CostBreakdownResponse,
  type HealthSnapshot,
  type ProviderKeyStatus,
  type RealtimeCost,
} from './api';
import { isSidecarConfigured } from './sidecar';
import type { Model, Provider } from '@taori/shared';

export interface LiveResult<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refetch?: () => void;
}

function useLive<T>(fn: () => Promise<T>, intervalMs: number, enabled = true): LiveResult<T> {
  const [state, setState] = useState<LiveResult<T>>({ data: null, error: null, loading: enabled });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<number | null>(null);

  const run = useRef(async () => {
    try {
      const data = await fnRef.current();
      setState({ data, error: null, loading: false, refetch: undefined });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e));
      setState((s) => ({ data: s.data, error: err, loading: false, refetch: undefined }));
    }
  });

  const doRefetch = useRef(() => { run.current(); });

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false, refetch: doRefetch.current });
      return;
    }
    let cancelled = false;
    const doRun = async () => { if (!cancelled) run.current(); };
    doRun();
    timerRef.current = window.setInterval(doRun, intervalMs);
    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [intervalMs, enabled]);

  // Attach refetch to every state update
  useEffect(() => {
    setState((s) => ({ ...s, refetch: doRefetch.current }));
  }, [state.data, state.error]);

  return state;
}

// ── Aggregate health: derives Footer status pill ─────────────
export type FooterStatus = 'ok' | 'warn' | 'err' | 'off';

export interface FooterHealth {
  status: FooterStatus;
  statusText: string;
  health: HealthSnapshot | null;
  providers: Provider[];
  keyStatuses: ProviderKeyStatus[] | null;
}

export function useFooterHealth(intervalMs = 15000): LiveResult<FooterHealth> {
  return useLive(
    async () => {
      const [health, providers, keyStatusResult] = await Promise.all([
        getHealth().catch(() => null),
        listProviders().catch(() => [] as Provider[]),
        getProviderKeyStatus()
          .then((statuses) => ({ statuses, unknown: false }))
          .catch((err: unknown) => {
            if (
              err instanceof ApiError
              && err.details?.requires_keychain_confirmation === true
            ) {
              return { statuses: null, unknown: true };
            }
            return { statuses: [] as ProviderKeyStatus[], unknown: false };
          }),
      ]);
      const keyStatuses = keyStatusResult.statuses;

      let status: FooterStatus;
      let statusText: string;

      if (!health || !health.ok) {
        status = 'err';
        statusText = '离线';
      } else if (providers.length === 0) {
        status = 'off';
        statusText = '未配置';
      } else {
        const enabled = providers.filter((p) => p.enabled);
        if (enabled.length === 0) {
          status = 'off';
          statusText = '未配置';
        } else if (keyStatusResult.unknown || keyStatuses === null) {
          status = 'ok';
          statusText = '在线';
        } else {
          const missing = enabled.filter((p) => {
            const k = keyStatuses.find((s) => s.provider_id === p.id);
            return !k || !k.key_available;
          });
          if (missing.length === enabled.length) {
            status = 'off';
            statusText = '未配置';
          } else if (missing.length > 0) {
            status = 'warn';
            statusText = '部分降级';
          } else {
            status = 'ok';
            statusText = '在线';
          }
        }
      }

      return { status, statusText, health, providers, keyStatuses };
    },
    intervalMs,
    isSidecarConfigured(),
  );
}

// ── Realtime cost ────────────────────────────────────────────
export function useRealtimeCost(intervalMs = 5000, conversationId?: string | null): LiveResult<RealtimeCost> {
  return useLive(() => getRealtimeCost(conversationId ?? undefined), intervalMs, isSidecarConfigured());
}

// ── Today breakdown — only fetch when popup is open ──────────
export function useTodayBreakdown(open: boolean): LiveResult<CostBreakdownResponse> {
  return useLive(
    () => getCostBreakdown({ scope: 'today', groupBy: 'model' }),
    15000,
    open && isSidecarConfigured(),
  );
}

// ── Conversations list ───────────────────────────────────────
export function useConversations(intervalMs = 10000): LiveResult<Conversation[]> {
  return useLive(() => listConversations(), intervalMs, isSidecarConfigured());
}

// ── Single conversation messages — fetch once when id changes ─
export function useMessages(conversationId: string | null): LiveResult<ConversationMessagesResponse> {
  return useLive(
    () => {
      if (!conversationId) throw new Error('no id');
      return getMessages(conversationId);
    },
    15_000,
    !!conversationId && isSidecarConfigured(),
  );
}

// ── Models list — fetch once on mount, refresh every 60s ─────
export function useModels(): LiveResult<Model[]> {
  return useLive(() => listModels(), 60000, isSidecarConfigured());
}

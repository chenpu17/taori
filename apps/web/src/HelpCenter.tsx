/**
 * B3 — Help Center modal.
 *
 * Provides a one-stop place for new users to:
 *   1. Read a one-line summary of Taori's three pillars
 *      (failure-fallback / cost-transparency / multi-model roundtable)
 *   2. Browse a short FAQ
 *   3. Run a self-check that hits GET /v1/selfcheck and surfaces
 *      sidecar / keystore / DB / default-model status with green/yellow/red.
 *
 * No server-side state changes are made by this dialog (selfcheck is GET).
 */
import {
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from './api.js';

type SelfCheckLevel = 'ok' | 'warn' | 'error';
interface SelfCheckItem {
  id: 'sidecar' | 'keystore' | 'database' | 'default_model';
  ok: boolean;
  level: SelfCheckLevel;
  detail: string;
}
interface SelfCheckResponse {
  ok: boolean;
  overall: SelfCheckLevel;
  checks: SelfCheckItem[];
}

const ITEM_LABEL: Record<SelfCheckItem['id'], string> = {
  sidecar: 'Sidecar 进程',
  keystore: '密钥存储',
  database: '本地数据库',
  default_model: '默认对话模型',
};

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Taori 是什么？',
    a:
      '一个本地优先的多模型桌面 AI 助手：你自己提供 API Key（BYOK），所有对话与设置只保存在本机，任何上行调用都会显示来源模型与本次成本。',
  },
  {
    q: '我的 Key 安全吗？',
    a:
      'Key 存放在系统钥匙串（macOS Keychain / Windows Credential Manager），Sidecar 在调用前才向钥匙串读取，进程不写盘。',
  },
  {
    q: '成本是怎么算的？',
    a:
      '基于模型中心配置的 USD 单价，按你最近一次请求的 token / 调用数实时累加。底部状态栏与「成本看板」可逐条审计。',
  },
  {
    q: '什么是圆桌？',
    a:
      '让多个不同模型就同一话题先独立给出观点，再互相反驳并由总结模型整合输出结论的协作模式。适合重要决策。',
  },
  {
    q: '失败兜底怎么工作？',
    a:
      '主模型失败时，按你设置的备选顺序自动重试同能力的其他模型；连续失败的模型会被短期降权（自动恢复）。',
  },
];

export function HelpCenter({
  onClose,
}: {
  onClose: () => void;
}): ReactElement {
  const [check, setCheck] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    data?: SelfCheckResponse;
    error?: string;
  }>({ state: 'idle' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function runSelfCheck(): Promise<void> {
    setCheck({ state: 'running' });
    try {
      const data = await api.selfCheck();
      setCheck({ state: 'done', data });
    } catch (e) {
      setCheck({
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const overallSummary = useMemo(() => {
    if (check.state !== 'done' || !check.data) return null;
    const o = check.data.overall;
    if (o === 'ok') return { label: '一切正常', cls: 'ok' };
    if (o === 'warn') return { label: '可继续使用，但有提醒', cls: 'warn' };
    return { label: '存在问题，请处理', cls: 'error' };
  }, [check]);

  return (
    <div
      className="modal-backdrop"
      data-testid="help-center-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card help-center"
        data-testid="help-center"
      >
        <header className="help-center__head">
          <h3>使用帮助 / Help Center</h3>
          <button
            type="button"
            className="settings-btn"
            data-testid="help-center-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            ✕
          </button>
        </header>

        <section className="help-center__pillars" data-testid="help-pillars">
          <h4>这是什么产品？三条主线</h4>
          <ul>
            <li>
              <strong>🛟 失败兜底</strong> · 主模型失败时自动尝试备用模型，
              连续失败的模型短期降权。
            </li>
            <li>
              <strong>💰 成本透明</strong> · 每次调用前显示预估区间，
              结束后写入逐条成本记录，可随时审计。
            </li>
            <li>
              <strong>👥 多模型圆桌</strong> · 让不同模型就同一话题各抒己见，
              互相反驳后总结结论。
            </li>
          </ul>
        </section>

        <section className="help-center__faq" data-testid="help-faq">
          <h4>常见问题</h4>
          <div>
            {FAQ.map((item, i) => (
              <details key={i} className="help-faq-item">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="help-center__selfcheck" data-testid="help-selfcheck">
          <div className="help-selfcheck__head">
            <h4>状态自检</h4>
            <button
              type="button"
              data-testid="help-selfcheck-run"
              onClick={runSelfCheck}
              disabled={check.state === 'running'}
            >
              {check.state === 'running' ? '正在检查…' : '运行自检'}
            </button>
          </div>
          {check.state === 'idle' ? (
            <p className="hint">
              点击"运行自检"将检查 Sidecar 进程、密钥存储、本地数据库与默认模型。
            </p>
          ) : null}
          {check.state === 'error' ? (
            <p
              className="err"
              data-testid="help-selfcheck-error"
            >
              自检失败：{check.error}
            </p>
          ) : null}
          {check.state === 'done' && check.data ? (
            <>
              {overallSummary ? (
                <div
                  className={`help-selfcheck-overall help-level-${overallSummary.cls}`}
                  data-testid="help-selfcheck-overall"
                  data-level={overallSummary.cls}
                >
                  {overallSummary.label}
                </div>
              ) : null}
              <ul
                className="help-selfcheck-list"
                data-testid="help-selfcheck-list"
              >
                {check.data.checks.map((c) => (
                  <li
                    key={c.id}
                    className={`help-selfcheck-item help-level-${c.level}`}
                    data-testid={`help-selfcheck-${c.id}`}
                    data-level={c.level}
                  >
                    <span className="help-selfcheck-icon" aria-hidden>
                      {c.level === 'ok'
                        ? '✅'
                        : c.level === 'warn'
                          ? '⚠️'
                          : '❌'}
                    </span>
                    <span className="help-selfcheck-name">
                      {ITEM_LABEL[c.id]}
                    </span>
                    <span className="help-selfcheck-detail hint">
                      {c.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

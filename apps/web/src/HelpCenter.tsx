/**
 * B3 — Help Center modal.
 *
 * Provides a one-stop place for new users to:
 *   1. Read a one-line summary of Taori's three pillars
 *      (failure-fallback / cost-transparency / multi-model roundtable)
 *   2. Browse a short FAQ
 *   3. Run a self-check that hits GET /v1/selfcheck and surfaces
 *      sidecar / DB / default-model status with green/yellow/red. Keychain
 *      probing is explicit because macOS may show a system authorization prompt.
 *
 * The default self-check does not touch Keychain; the optional deep check
 * writes and deletes a temporary probe secret.
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
type RealProviderDiagnostics = Awaited<ReturnType<typeof api.realProviderDiagnostics>>;

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
      '正式桌面模式优先使用系统钥匙串（macOS Keychain / Windows Credential Manager）；浏览器开发 / 验证模式按当前 keystore 配置运行。Help Center 自检会告诉你当前状态，深度检查才会显式探测 Keychain。',
  },
  {
    q: '成本是怎么算的？',
    a:
      '基于模型中心配置的 USD 单价，按你最近一次请求的 token / 调用数实时累加。底部状态栏与「成本看板」可逐条审计。',
  },
  {
    q: 'Prompt 模板和 Persona 有什么区别？',
    a:
      '模板是插入到输入框里的可编辑文本骨架；Persona 是会话级 system prompt，用来约束助手的语气、判断和做事方式，不会显示在消息时间线里。内置的「OpenClaw 行动派助手」就属于 Persona。',
  },
  {
    q: '为什么 Persona 会显示“待绑定”？',
    a:
      '你是在新会话还没创建前先选了 Persona。Taori 会先把这次选择作为待发送草稿保留；发出第一条消息后，它会绑定到该会话并显示为“本会话”。刷新当前页面不会丢失这次待绑定选择。',
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
  const [realDiag, setRealDiag] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    data?: RealProviderDiagnostics;
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

  async function runSelfCheck(includeKeychain = false): Promise<void> {
    setCheck({ state: 'running' });
    try {
      const data = await api.selfCheck({ includeKeychain });
      setCheck({ state: 'done', data });
    } catch (e) {
      setCheck({
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function loadRealDiagnostics(): Promise<void> {
    setRealDiag({ state: 'running' });
    try {
      const data = await api.realProviderDiagnostics();
      setRealDiag({ state: 'done', data });
    } catch (e) {
      setRealDiag({
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
            <div>
              <div className="help-center__eyebrow">Taori Guide</div>
              <h3>使用帮助 / Help Center</h3>
            </div>
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
          <div className="help-center__section-title">
            <span className="help-center__section-icon" aria-hidden="true">✦</span>
            <h4>这是什么产品？三条主线</h4>
          </div>
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
          <div className="help-center__section-title">
            <span className="help-center__section-icon" aria-hidden="true">?</span>
            <h4>常见问题</h4>
          </div>
          <div>
            {FAQ.map((item, i) => (
              <details key={i} className="help-faq-item">
                <summary data-testid={`help-faq-summary-${i}`}>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="help-center__selfcheck" data-testid="help-selfcheck">
          <div className="help-selfcheck__head">
            <div className="help-center__section-title">
              <span className="help-center__section-icon" aria-hidden="true">✓</span>
              <h4>状态自检</h4>
            </div>
            <button
              type="button"
              className="help-center__action"
              data-testid="help-selfcheck-run"
              onClick={() => runSelfCheck(false)}
              disabled={check.state === 'running'}
            >
              {check.state === 'running' ? '正在检查…' : '运行自检'}
            </button>
            <button
              type="button"
              className="help-center__action help-center__action--secondary"
              data-testid="help-selfcheck-run-keychain"
              onClick={() => runSelfCheck(true)}
              disabled={check.state === 'running'}
              title="会读写一次临时 Keychain 探针，macOS 可能弹出系统授权提示"
            >
              检查钥匙串
            </button>
          </div>
          {check.state === 'idle' ? (
            <p className="hint">
              “运行自检”不会读取系统钥匙串；需要确认 Keychain 时再点“检查钥匙串”。
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

        <section className="help-center__realdiag" data-testid="help-realdiag">
          <div className="help-selfcheck__head">
            <div className="help-center__section-title">
              <span className="help-center__section-icon" aria-hidden="true">◎</span>
              <h4>真实模型能力诊断</h4>
            </div>
            <button
              type="button"
              className="help-center__action"
              data-testid="help-realdiag-load"
              onClick={() => void loadRealDiagnostics()}
              disabled={realDiag.state === 'running'}
              title="只读取最近一次 pnpm verify:real 的本地产物，不发起真实模型调用"
            >
              {realDiag.state === 'running' ? '正在读取…' : '读取最近真实验证'}
            </button>
          </div>
          {realDiag.state === 'idle' ? (
            <p className="hint">
              这里不会发起真实模型调用；只读取最近一次 `pnpm verify:real` 保存的本地诊断产物。
            </p>
          ) : null}
          {realDiag.state === 'error' ? (
            <p className="err" data-testid="help-realdiag-error">
              读取失败：{realDiag.error}
            </p>
          ) : null}
          {realDiag.state === 'done' && realDiag.data ? (
            <RealProviderDiagnosticsView data={realDiag.data} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function RealProviderDiagnosticsView({
  data,
}: {
  data: RealProviderDiagnostics;
}): ReactElement {
  if (!data.available) {
    return (
      <p className="hint" data-testid="help-realdiag-empty">
        {data.message ?? '尚未找到真实模型验证产物。'}
      </p>
    );
  }
  const summary = data.summary;
  const selected = data.selected ?? {};
  const requiredSteps = data.required_steps ?? [];
  const risks = data.risks ?? [];
  return (
    <div className="help-realdiag-card" data-testid="help-realdiag-result">
      <div className="help-realdiag-head">
        <strong>{data.run_id ?? '最近真实验证'}</strong>
        <span>{data.collected_at ? new Date(data.collected_at).toLocaleString() : '时间未知'}</span>
      </div>
      {summary ? (
        <div className="help-realdiag-metrics">
          <span>
            <small>步骤</small>
            <strong>{summary.passed_steps}/{summary.passed_steps + summary.failed_steps}</strong>
          </span>
          <span>
            <small>风险</small>
            <strong>{summary.risk_count}</strong>
          </span>
          <span>
            <small>Runs</small>
            <strong>{summary.run_count ?? '—'}</strong>
          </span>
          <span>
            <small>成本记录</small>
            <strong>{summary.cost_call_count ?? '—'}</strong>
          </span>
        </div>
      ) : null}
      <div className="help-realdiag-models">
        {Object.entries(selected).slice(0, 4).map(([key, model]) => (
          <span key={key} data-testid="help-realdiag-model">
            <small>{key}</small>
            <strong>{model.label ?? model.id ?? '未知模型'}</strong>
          </span>
        ))}
      </div>
      <div className="help-realdiag-steps" data-testid="help-realdiag-steps">
        {requiredSteps.map((step) => (
          <span key={step.name} className={step.ok ? 'is-ok' : 'is-risk'}>
            {step.ok ? '通过' : '风险'} · {realStepLabel(step.name)}
          </span>
        ))}
      </div>
      {risks.length > 0 ? (
        <ul className="help-realdiag-risks" data-testid="help-realdiag-risks">
          {risks.map((risk, index) => (
            <li key={`${risk.code}-${index}`}>
              <strong>{risk.code}</strong>
              <span>{risk.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint" data-testid="help-realdiag-no-risks">
          未记录结构化风险。
        </p>
      )}
      {data.artifact_dir ? (
        <p className="hint" data-testid="help-realdiag-artifact">
          产物目录：{data.artifact_dir}
        </p>
      ) : null}
    </div>
  );
}

function realStepLabel(name: string): string {
  const labels: Record<string, string> = {
    image_generate_tool_from_chat: '图像生成',
    generated_image_to_vision_understanding: '视觉理解',
    web_fetch_tool_from_chat: '网页抓取',
    web_search_tool_from_chat: '网页搜索',
    mcp_tool_from_ordinary_chat: 'MCP 工具',
    real_context_window_and_compact_context_recover: '上下文恢复',
    real_skip_tool_recovery: '跳过工具恢复',
    real_roundtable_timeline: '圆桌 Timeline',
    backup_import_then_real_chat: '备份导入续聊',
    cost_dashboard_source_backlink_visible: '成本追踪',
  };
  return labels[name] ?? name;
}

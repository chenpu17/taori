/**
 * Settings modal — slim form post-M2.5.
 *
 * After M2.5 the heavy "Model Config Center" (capability-grouped lists,
 * per-row reorder/test/delete, fallback ordering) was promoted to its own
 * top-level page (`ModelCenter.tsx`). Settings now only carries the
 * cross-cutting toggles that don't fit the per-model surface:
 *
 *   • Auto-fallback toggle (M2.1)
 *   • "Re-open onboarding" entry point
 *   • Danger zone (wipe SQLite + Keychain)
 *
 * Provider list / model matrix / connection test all live in Model Center.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { BackupConflictStrategy, Persona, PromptTemplate } from '@taori/shared';

const MAX_BACKUP_IMPORT_BYTES = 25 * 1024 * 1024;

interface SettingsProps {
  onClose: () => void;
  onChanged: () => void;
  onReopenOnboarding: () => void;
}

export function Settings({
  onClose,
  onChanged,
  onReopenOnboarding,
}: SettingsProps): JSX.Element {
  // Escape closes the modal — standard a11y expectation (WCAG 2.1.1).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="settings-overlay"
      data-testid="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal" role="dialog" aria-label="设置">
        <header className="settings-header">
          <h2>设置</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <AutoFallbackSection />
        <MonthlyBudgetSection />
        <PromptTemplatesSection />
        <PersonasSection />

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Provider 与模型</h3>
          </div>
          <p className="hint">
            模型与 Provider 的管理已迁移至独立的 <strong>模型中心</strong>（顶部 🧬 图标）。
            如需重新走一遍完整 Onboarding，可点击下方按钮。
          </p>
          <button
            type="button"
            onClick={onReopenOnboarding}
            data-testid="settings-add-provider"
          >
            重新打开 Onboarding
          </button>
        </section>

        <DangerZone
          onCleared={() => {
            onChanged();
            window.location.reload();
          }}
        />
      </div>
    </div>
  );
}

function notifyPromptAssetsChanged(): void {
  window.dispatchEvent(new Event('taori:prompt-assets-changed'));
}

function notifyBudgetSettingsChanged(): void {
  window.dispatchEvent(new Event('taori:budget-settings-changed'));
}

function MonthlyBudgetSection(): JSX.Element {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getMemoryEffective('monthly_budget_usd');
        if (!cancelled) setValue(res.data.value ?? '');
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (nextValue: string): Promise<void> => {
    const trimmed = nextValue.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMsg('请输入大于 0 的 USD 金额，或清空以关闭预算。');
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      if (trimmed) {
        await api.putMemory('global', 'monthly_budget_usd', trimmed);
      } else {
        await api.deleteMemory('global', 'monthly_budget_usd');
      }
      await api.deleteMemory('global', 'monthly_budget_alert_state');
      setValue(trimmed);
      setMsg(trimmed ? '月度软预算已保存。阈值提醒将从本月重新计算。' : '已关闭月度软预算。');
      notifyBudgetSettingsChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-monthly-budget">
      <div className="settings-section-head">
        <h3>月度预算</h3>
      </div>
      <p className="hint">
        配置一个月度软预算（USD）。达到 50% / 80% / 100% 时会在底部状态栏提示，并在超过 100% 后继续发送前要求确认。
      </p>
      <div className="settings-inline-form">
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如 20"
          disabled={loading || saving}
          data-testid="monthly-budget-input"
        />
        <button
          type="button"
          onClick={() => void save(value)}
          disabled={loading || saving}
          data-testid="monthly-budget-save"
        >
          {saving ? '保存中…' : '保存预算'}
        </button>
        <button
          type="button"
          onClick={() => void save('')}
          disabled={loading || saving || value.trim().length === 0}
          data-testid="monthly-budget-clear"
        >
          清除
        </button>
      </div>
      {msg && <p className="hint" data-testid="monthly-budget-message">{msg}</p>}
    </section>
  );
}

function PromptTemplatesSection(): JSX.Element {
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');

  const resetForm = (): void => {
    setEditingId(null);
    setName('');
    setDescription('');
    setContent('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPromptTemplates();
      setItems(res.prompt_templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updatePromptTemplate(editingId, {
          name: name.trim(),
          description: description.trim() || null,
          content: content.trim(),
        });
      } else {
        await api.createPromptTemplate({
          name: name.trim(),
          description: description.trim() || null,
          content: content.trim(),
        });
      }
      resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('确认删除这个 Prompt 模板？')) return;
    try {
      await api.deletePromptTemplate(id);
      if (editingId === id) resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="settings-section" data-testid="settings-prompt-templates">
      <div className="settings-section-head">
        <h3>Prompt 模板</h3>
      </div>
      <p className="hint">支持 <code>{'{{变量}}'}</code> 占位。套用到聊天输入框前会逐个填空。</p>
      <div className="settings-library-grid">
        <div className="settings-library-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="模板名称"
            data-testid="template-name-input"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            data-testid="template-description-input"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例如：请从 {{行业}} 的角度分析 {{问题}}。"
            rows={6}
            data-testid="template-content-input"
          />
          <div className="settings-inline-actions">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={saving || !name.trim() || !content.trim()}
              data-testid="template-save"
            >
              {saving ? '保存中…' : editingId ? '更新模板' : '新增模板'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saving}
                data-testid="template-cancel"
              >
                取消编辑
              </button>
            )}
          </div>
        </div>
        <div className="settings-library-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="hint">还没有模板。先建一个常用开场或分析框架。</p>
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="settings-library-card"
                data-testid="template-card"
              >
                <div className="settings-library-card-head">
                  <strong>{item.name}</strong>
                  <span className="settings-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setName(item.name);
                        setDescription(item.description ?? '');
                        setContent(item.content);
                      }}
                      data-testid="template-edit"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(item.id)}
                      data-testid="template-delete"
                    >
                      删除
                    </button>
                  </span>
                </div>
                {item.description && <p className="hint">{item.description}</p>}
                <pre className="settings-library-preview">{item.content}</pre>
              </article>
            ))
          )}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
    </section>
  );
}

function PersonasSection(): JSX.Element {
  const [items, setItems] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');

  const resetForm = (): void => {
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPersonas();
      setItems(res.personas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updatePersona(editingId, {
          name: name.trim(),
          description: description.trim() || null,
          prompt: prompt.trim(),
        });
      } else {
        await api.createPersona({
          name: name.trim(),
          description: description.trim() || null,
          prompt: prompt.trim(),
        });
      }
      resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('确认删除这个 Persona？已绑定到会话的选择会自动失效。')) return;
    try {
      await api.deletePersona(id);
      if (editingId === id) resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="settings-section" data-testid="settings-personas">
      <div className="settings-section-head">
        <h3>Persona 预设</h3>
      </div>
      <p className="hint">会话级 Persona 会以 system prompt 注入，不会显示在消息时间线里。</p>
      <div className="settings-library-grid">
        <div className="settings-library-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Persona 名称"
            data-testid="persona-name-input"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            data-testid="persona-description-input"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：你是一位严格的架构评审，优先指出边界、风险与回滚路径。"
            rows={6}
            data-testid="persona-prompt-input"
          />
          <div className="settings-inline-actions">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={saving || !name.trim() || !prompt.trim()}
              data-testid="persona-save"
            >
              {saving ? '保存中…' : editingId ? '更新 Persona' : '新增 Persona'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saving}
                data-testid="persona-cancel"
              >
                取消编辑
              </button>
            )}
          </div>
        </div>
        <div className="settings-library-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="hint">还没有 Persona。先建一个常用角色口径。</p>
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="settings-library-card"
                data-testid="persona-card"
              >
                <div className="settings-library-card-head">
                  <strong>{item.name}</strong>
                  <span className="settings-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setName(item.name);
                        setDescription(item.description ?? '');
                        setPrompt(item.prompt);
                      }}
                      data-testid="persona-edit"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(item.id)}
                      data-testid="persona-delete"
                    >
                      删除
                    </button>
                  </span>
                </div>
                {item.description && <p className="hint">{item.description}</p>}
                <pre className="settings-library-preview">{item.prompt}</pre>
              </article>
            ))
          )}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
    </section>
  );
}

/**
 * Danger zone (M1 §6.2): wipes SQLite + Keychain. We require two confirms:
 * a checkbox to unlock the button (so a stray click can't fire it) and a
 * native window.confirm() with the explicit "无法恢复" wording. The endpoint
 * itself is destructive but idempotent — running it twice on an empty store
 * is a no-op.
 */
function DangerZone({ onCleared }: { onCleared: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busyClear, setBusyClear] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [importStrategy, setImportStrategy] = useState<BackupConflictStrategy>('overwrite');
  const [msg, setMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onClear(): Promise<void> {
    if (!armed || busyClear || busyExport || busyImport) return;
    if (!window.confirm('确定要清空所有数据吗？\n这会删除：所有会话、所有消息、所有模型与 Provider、所有 Keychain 中保存的 API Key。\n此操作无法恢复。')) return;
    setBusyClear(true);
    setMsg(null);
    try {
      const res = await api.clearAllData();
      const failures = res.data.keystore_failures.length;
      setMsg(
        failures > 0
          ? `已清空。Keychain 有 ${failures} 项删除失败，可手动到「钥匙串访问」清理。`
          : `已清空。Keychain 同步删除 ${res.data.keystore_entries_removed} 项。`,
      );
      onCleared();
    } catch (e) {
      setMsg(`清空失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyClear(false);
      setArmed(false);
    }
  }

  async function onExport(): Promise<void> {
    if (busyClear || busyExport || busyImport) return;
    setBusyExport(true);
    setMsg(null);
    try {
      const res = await api.exportBackup();
      const filename = `taori_backup_${new Date(res.backup.exported_at).toISOString().replace(/[:.]/g, '-')}.json`;
      const blob = new Blob([JSON.stringify(res.backup, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg(`备份已导出：${filename}。注意：API Key 不包含在备份中。`);
    } catch (e) {
      setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyExport(false);
    }
  }

  async function onImportFile(file: File | null): Promise<void> {
    if (!file || busyClear || busyExport || busyImport) return;
    if (file.size > MAX_BACKUP_IMPORT_BYTES) {
      setMsg(`导入失败：备份文件超过 25MB，请拆分附件或使用更小的备份。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setBusyImport(true);
    setMsg('正在读取并校验备份文件…');
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      setMsg('正在导入备份…');
      const res = await api.importBackup(importStrategy, backup);
      const importedCounts = Object.values(res.data.imported) as number[];
      const renamedCounts = Object.values(res.data.renamed) as number[];
      const totalImported = importedCounts.reduce((sum, value) => sum + value, 0);
      const totalRenamed = renamedCounts.reduce((sum, value) => sum + value, 0);
      const warningText =
        res.data.warnings.length > 0
          ? ` 警告 ${res.data.warnings.length} 条（例如：${res.data.warnings[0]}）。`
          : '';
      setMsg(
        `导入完成：新增/更新 ${totalImported} 项，重命名 ${totalRenamed} 项。${warningText}`,
      );
      onCleared();
    } catch (e) {
      setMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyImport(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <section className="settings-section settings-danger" data-testid="settings-danger-zone">
      <div className="settings-section-head">
        <h3>危险区 / Danger zone</h3>
      </div>
      <p className="hint">
        备份 / 恢复 / 清空全部数据都在这里。备份导出为单个 JSON；导入后会恢复会话、圆桌、模型配置、记忆、模板与 Persona。
        API Key 出于安全原因不会进入备份，恢复后需手动重新填写。
      </p>
      <div className="settings-inline-form">
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-export-backup"
        >
          {busyExport ? '导出中…' : '导出全部数据'}
        </button>
        <select
          value={importStrategy}
          onChange={(e) => setImportStrategy(e.target.value as BackupConflictStrategy)}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-import-strategy"
        >
          <option value="overwrite">导入策略：覆盖</option>
          <option value="skip">导入策略：跳过冲突</option>
          <option value="rename">导入策略：重命名冲突</option>
        </select>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-import-backup"
        >
          {busyImport ? '导入中…' : '导入备份 JSON'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)}
          data-testid="settings-import-file"
        />
      </div>
      <p className="hint">
        “覆盖”会更新同 ID / 同 memory 键的数据；“跳过冲突”保留现有数据；“重命名冲突”会为可重命名的数据生成新 ID。
      </p>
      <label className="danger-arm">
        <input
          type="checkbox"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
          data-testid="settings-danger-arm"
        />
        我已知晓，确认要清空所有数据。
      </label>
      <button
        type="button"
        className="danger-btn"
        disabled={!armed || busyClear || busyExport || busyImport}
        onClick={() => void onClear()}
        data-testid="settings-clear-all"
      >
        {busyClear ? '清理中…' : '清空所有数据'}
      </button>
      {msg && <p className="hint" data-testid="settings-danger-msg">{msg}</p>}
    </section>
  );
}

// =====================================================================
// M2.1 — Auto-fallback toggle
// =====================================================================
//
// Persists the global `auto_fallback_enabled` flag via /v1/memories.
// The flag is read by the chat route per request and emitted in the
// `failure_decision` annotation; the renderer's auto-fallback effect
// in ChatPanel consumes it to fire a single-hop retry.
//
// We optimistically reflect the toggled value before the round-trip
// completes so users don't see a click-then-wait UX; on failure we
// revert and surface the error.
function AutoFallbackSection(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getMemoryEffective('auto_fallback_enabled');
        if (cancelled) return;
        setEnabled(r.data.value === 'true');
      } catch (e) {
        if (!cancelled) setEnabled(false);
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (): Promise<void> => {
    if (enabled == null || busy) return;
    const next = !enabled;
    setBusy(true);
    setErr(null);
    setEnabled(next);
    try {
      await api.putMemory('global', 'auto_fallback_enabled', String(next));
    } catch (e) {
      setEnabled(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-auto-fallback">
      <h3>失败处理</h3>
      <label className="auto-fallback-row">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled == null || busy}
          onChange={() => void onToggle()}
          data-testid="auto-fallback-toggle"
        />
        <span className="auto-fallback-label">
          失败时自动切换到下一个备用模型重试（单次）
        </span>
      </label>
      <p className="hint">
        当上游返回额度/速率/网络类错误时，会按 fallback 顺序自动切换到下一个可用模型重试一次；
        内容策略错误（content_filter）始终不自动重试。
      </p>
      {err && <p className="err" data-testid="auto-fallback-err">{err}</p>}
    </section>
  );
}

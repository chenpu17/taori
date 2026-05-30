import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import {
  deleteMemory,
  deleteStructuredMemory,
  listStructuredMemories,
  putMemory,
  setStructuredMemoryEnabled,
  type StructuredMemory,
} from '../api';

interface MemoryPanelProps {
  panelId?: string;
  activeConversationId: string | null;
}

interface KvDraftRow {
  scope: 'global' | 'session';
  key: string;
  value: string;
}

export function MemoryPanel({ panelId, activeConversationId }: MemoryPanelProps): JSX.Element {
  const toast = useToast();
  const dialog = useDialog();
  const [structured, setStructured] = useState<StructuredMemory[]>([]);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<KvDraftRow>({ scope: 'global', key: '', value: '' });

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const rows = await listStructuredMemories(includeDisabled);
      setStructured(rows);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDisabled]);

  async function saveKv(): Promise<void> {
    if (!draft.key.trim() || !draft.value.trim()) {
      toast.warn('需要填写 Key 与 Value');
      return;
    }
    if (draft.scope === 'session' && !activeConversationId) {
      toast.warn('Session 作用域需要先打开一个会话');
      return;
    }
    try {
      await putMemory({
        scope: draft.scope,
        scope_id: draft.scope === 'session' ? activeConversationId : null,
        key: draft.key.trim(),
        value: draft.value,
      });
      toast.success(`已写入 ${draft.scope} / ${draft.key}`);
      setDraft({ ...draft, key: '', value: '' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeKv(): Promise<void> {
    if (!draft.key.trim()) {
      toast.warn('请填写要删除的 Key');
      return;
    }
    const confirmed = await dialog.confirm({
      title: `删除 ${draft.scope} / ${draft.key}？`,
      tone: 'danger',
      okLabel: '删除',
    });
    if (!confirmed) return;
    try {
      await deleteMemory(
        draft.scope,
        draft.key.trim(),
        draft.scope === 'session' ? activeConversationId ?? undefined : undefined,
      );
      toast.success('已删除。');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggle(item: StructuredMemory): Promise<void> {
    try {
      await setStructuredMemoryEnabled(item.id, !item.enabled);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function softDelete(item: StructuredMemory): Promise<void> {
    const confirmed = await dialog.confirm({
      title: `归档结构化记忆「${item.key}」？`,
      description: '记忆会被软删除，可以通过开启「包含已禁用 / 归档」找回。',
      tone: 'danger',
      okLabel: '归档',
    });
    if (!confirmed) return;
    try {
      await deleteStructuredMemory(item.id);
      toast.success('已归档。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section
      className="feature-panel"
      data-testid="memory-panel"
      id={panelId}
      role="tabpanel"
    >
      <div className="feature-header">
        <div>
          <h2>记忆</h2>
          <p>
            两层：左侧是 KV 偏好（Renderer / Sidecar 共用），右侧是助手抽取的结构化记忆。生效顺序：message {'>'} session {'>'} global。
          </p>
        </div>
        <div className="inline-toolbar" style={{ marginBottom: 0 }}>
          <button type="button" className="btn-quiet" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      <div className="memory-grid">
        <div className="feature-card">
          <h3>KV 偏好</h3>
          <p className="muted" style={{ marginBottom: 12 }}>
            写入后立即生效；用于 Renderer 偏好、临时开关、长期个人设定。
          </p>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 0 }}>
            <select
              value={draft.scope}
              onChange={(event) => setDraft({ ...draft, scope: event.target.value as 'global' | 'session' })}
              data-testid="memory-scope"
            >
              <option value="global">global</option>
              <option value="session" disabled={!activeConversationId}>
                session{activeConversationId ? '' : '（需要打开会话）'}
              </option>
            </select>
            <input
              placeholder="key（如 ui.composer.compact）"
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              data-testid="memory-key"
            />
          </div>
          <textarea
            className="feature-textarea small"
            placeholder="value（字符串；JSON 自己 stringify）"
            value={draft.value}
            onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            data-testid="memory-value"
          />
          <div className="inline-toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
            <button type="button" className="btn-primary" onClick={() => void saveKv()} data-testid="memory-save">
              保存
            </button>
            <button type="button" className="btn-quiet" onClick={() => void removeKv()} data-testid="memory-delete">
              删除
            </button>
          </div>
        </div>

        <div className="feature-card">
          <div className="feature-row">
            <h3 style={{ margin: 0 }}>结构化记忆</h3>
            <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={includeDisabled}
                onChange={(event) => setIncludeDisabled(event.target.checked)}
              />
              包含已禁用
            </label>
          </div>
          {structured.length === 0 ? (
            <p className="muted">还没有结构化记忆。</p>
          ) : (
            <div className="memory-list">
              {structured.map((item) => (
                <div
                  className={`memory-row ${item.enabled ? '' : 'disabled'}`}
                  key={item.id}
                  data-testid={`structured-memory-${item.id}`}
                >
                  <div className="memory-row-head">
                    <span className="tag">{item.scope}</span>
                    <strong>{item.key}</strong>
                    <span className="muted">{item.kind}</span>
                  </div>
                  <p>{item.value}</p>
                  <div className="inline-toolbar" style={{ margin: 0 }}>
                    <button type="button" className="btn-quiet" onClick={() => void toggle(item)}>
                      {item.enabled ? '禁用' : '启用'}
                    </button>
                    <button type="button" className="btn-quiet" onClick={() => void softDelete(item)}>
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

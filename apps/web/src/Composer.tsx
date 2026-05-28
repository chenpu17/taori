import { useRef, useState, type MouseEvent } from 'react';
import { Icon, MODELS, type ModelId } from './primitives';
import { MODES, type ModeId } from './scenarios';
import type { PendingAttachment } from './attachments';

interface ComposerProps {
  mode: ModeId | null;
  onClearMode: () => void;
  onSetMode: (m: ModeId) => void;
  model: ModelId;
  modelDisplay?: { color: string; label: string };
  attach: PendingAttachment[];
  onRemoveAttach: (i: number) => void;
  onAttach?: (files: File[]) => void;
  value: string;
  onChange: (v: string) => void;
  onPlus: (e: MouseEvent) => void;
  plusOpen: boolean;
  onModelClick: (e: MouseEvent) => void;
  modelOpen: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend?: () => void;
  onStop?: () => void;
  streaming?: boolean;
}

export function Composer({
  mode,
  onClearMode,
  onSetMode,
  model,
  modelDisplay,
  attach,
  onRemoveAttach,
  onAttach,
  value,
  onChange,
  onPlus,
  plusOpen,
  onModelClick,
  modelOpen,
  disabled = false,
  placeholder,
  onSend,
  onStop,
  streaming = false,
}: ComposerProps) {
  const [slashMenu, setSlashMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ph = placeholder ?? (mode ? `让 Taori ${MODES[mode].name}……` : '说点什么……  按 / 调用模式');
  const canSend = value.trim().length > 0 || attach.length > 0;
  const sendDisabled = disabled || !canSend;

  return (
    <div
      className="composer-shell"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        onAttach?.(Array.from(e.dataTransfer.files));
      }}
    >
      <input ref={fileRef} type="file" style={{ display: 'none' }} multiple onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        onAttach?.(files);
        e.target.value = '';
      }} />
      {attach.length > 0 && (
        <div className="composer-attach-row">
          {attach.map((a, i) => (
            <span key={i} className="attach-chip">
              <Icon name="doc" size={11} style={{ color: 'var(--text-muted)' }} />
              {a.name}
              <span className="x" onClick={() => onRemoveAttach(i)}>
                <Icon name="x" size={11} />
              </span>
            </span>
          ))}
        </div>
      )}
      {mode && (
        <div style={{ display: 'flex' }}>
          <span className="composer-modechip">
            <Icon name={MODES[mode].icon} size={11} />
            {MODES[mode].name}：
            <span className="x" onClick={onClearMode}>
              <Icon name="x" size={10} />
            </span>
          </span>
        </div>
      )}

      <div className="composer" style={{ position: 'relative' }}>
        <button type="button" className={'composer-plus' + (plusOpen ? ' active' : '')} onClick={onPlus}>
          <Icon name="plus" size={16} />
        </button>
        <textarea
          className="composer-input"
          rows={1}
          placeholder={ph}
          value={value}
          onChange={(e) => {
            const val = e.target.value;
            onChange(val);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            setSlashMenu(val === '/');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && slashMenu) { setSlashMenu(false); e.preventDefault(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (slashMenu) setSlashMenu(false);
              onSend?.();
            }
          }}
          disabled={disabled}
        />
        <button type="button" className="composer-model" onClick={onModelClick} data-open={modelOpen}>
          <span className="dot" style={{ background: modelDisplay?.color ?? MODELS[model].color }} />
          {modelDisplay?.label ?? MODELS[model].short}
          <Icon name="chevron-down" size={11} />
        </button>
        <button
          type="button"
          className={'composer-send' + (streaming ? ' streaming' : (sendDisabled ? ' disabled' : ''))}
          onClick={streaming ? (onStop ?? undefined) : onSend}
          disabled={!streaming && sendDisabled}
          title={streaming ? '停止生成' : '发送'}
        >
          <Icon name={streaming ? 'x' : 'arrow-up'} size={16} />
        </button>

        {slashMenu && (
          <div className="mode-menu popup" style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4 }}>
            {Object.entries(MODES).map(([key, m]) => (
              <div key={key} className="mode-menu-item" onClick={() => {
                if (key === 'file') {
                  fileRef.current?.click();
                } else {
                  onSetMode(key as ModeId);
                }
                onChange('');
                setSlashMenu(false);
              }}>
                <span className="ico"><Icon name={m.icon} size={13} /></span>
                <span className="col">
                  <span className="name">{m.name}</span>
                  <span className="desc">{m.desc}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer-meta">
        <span>↵ 发送 · ⇧↵ 换行 · / 模式 · ⌘K 命令</span>
        <span>{value ? `${value.length}/4000` : ''}</span>
      </div>
    </div>
  );
}

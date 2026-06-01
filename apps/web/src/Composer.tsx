import type { ChangeEvent } from 'react';
import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import type { ChatAttachment } from './api';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  streaming: boolean;
  disabled: boolean;
  modelLabel: string;
  onModelClick: () => void;
  attachments?: ChatAttachment[];
  onAttach?: (files: FileList) => void;
  onRemoveAttachment?: (index: number) => void;
  placeholder?: string;
  autoFocus?: boolean;
  large?: boolean;
}

export function Composer(props: ComposerProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const suppressNextEnterTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressNextEnterTimerRef.current !== null) {
        window.clearTimeout(suppressNextEnterTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(200, node.scrollHeight)}px`;
  }, [props.value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    const isImeEnter =
      event.key === 'Enter' &&
      (composingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229 ||
        suppressNextEnterRef.current);

    if (isImeEnter) {
      event.preventDefault();
      if (suppressNextEnterRef.current) suppressNextEnterRef.current = false;
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!props.streaming && !props.disabled && props.value.trim().length > 0) {
        props.onSubmit();
      }
    }
  };

  const handleAttach = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files && props.onAttach) {
      props.onAttach(event.currentTarget.files);
    }
    event.currentTarget.value = '';
  };

  const attachments = props.attachments ?? [];
  const sendDisabled = props.disabled || (props.value.trim().length === 0 && attachments.length === 0);

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((attachment, index) => (
            <span className="attach-chip" key={`${attachment.name ?? attachment.mime}-${index}`}>
              <Icon name={attachment.kind === 'image' ? 'image' : 'doc'} size={13} />
              <span>{attachment.name ?? attachment.mime}</span>
              <button
                type="button"
                onClick={() => props.onRemoveAttachment?.(index)}
                title="移除附件"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        autoFocus={props.autoFocus}
        rows={props.large ? 2 : 1}
        placeholder={props.placeholder ?? '问点什么…'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
          suppressNextEnterRef.current = false;
          if (suppressNextEnterTimerRef.current !== null) {
            window.clearTimeout(suppressNextEnterTimerRef.current);
            suppressNextEnterTimerRef.current = null;
          }
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          suppressNextEnterRef.current = true;
          if (suppressNextEnterTimerRef.current !== null) {
            window.clearTimeout(suppressNextEnterTimerRef.current);
          }
          suppressNextEnterTimerRef.current = window.setTimeout(() => {
            suppressNextEnterRef.current = false;
            suppressNextEnterTimerRef.current = null;
          }, 120);
        }}
        style={props.large ? { minHeight: 56 } : undefined}
        data-testid="composer-textarea"
      />
      <div className="composer-row">
        <label className={`tool-btn ${props.onAttach ? '' : 'disabled'}`} title="附加文件">
          <Icon name="paperclip" size={15} />
          <input
            type="file"
            multiple
            accept="image/*,.txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
            onChange={handleAttach}
            disabled={!props.onAttach}
            data-testid="composer-file-input"
          />
        </label>
        <label className={`tool-btn ${props.onAttach ? '' : 'disabled'}`} title="上传图片">
          <Icon name="image" size={15} />
          <input
            type="file"
            multiple
            accept="image/*"
            onChange={handleAttach}
            disabled={!props.onAttach}
            data-testid="composer-image-input"
          />
        </label>
        <button
          type="button"
          className="tool-btn"
          onClick={props.onModelClick}
          title="切换模型"
          data-testid="composer-model"
        >
          <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 500 }}>
            {props.modelLabel}
          </span>
          <Icon name="chevronDown" size={12} />
        </button>
        {props.streaming && props.onStop ? (
          <button
            type="button"
            className="send-btn streaming"
            onClick={props.onStop}
            title="停止生成"
            data-testid="composer-stop"
          >
            <Icon name="stop" size={11} />
          </button>
        ) : (
          <button
            type="button"
            className={`send-btn ${sendDisabled ? 'idle' : ''}`}
            onClick={() => {
              if (!sendDisabled) props.onSubmit();
            }}
            disabled={sendDisabled}
            title="发送"
            data-testid="composer-send"
          >
            <Icon name="arrowUp" size={15} stroke={2} />
          </button>
        )}
      </div>
    </div>
  );
}

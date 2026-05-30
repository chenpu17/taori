import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

type DialogTone = 'default' | 'danger';

interface PromptOptions {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  okLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
}

interface ConfirmOptions {
  title: string;
  description?: string;
  okLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
}

interface DialogApi {
  prompt: (opts: PromptOptions) => Promise<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: { title: string; description?: string }) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

interface PromptState extends PromptOptions {
  kind: 'prompt';
  resolve: (value: string | null) => void;
}

interface ConfirmState extends ConfirmOptions {
  kind: 'confirm';
  resolve: (value: boolean) => void;
}

interface AlertState {
  kind: 'alert';
  title: string;
  description?: string;
  resolve: () => void;
}

type DialogState = PromptState | ConfirmState | AlertState;

export function DialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<DialogState | null>(null);

  const api = useMemo<DialogApi>(
    () => ({
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          setState({ kind: 'prompt', resolve, ...opts });
        }),
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          setState({ kind: 'confirm', resolve, ...opts });
        }),
      alert: (opts) =>
        new Promise<void>((resolve) => {
          setState({ kind: 'alert', resolve, ...opts });
        }),
    }),
    [],
  );

  const close = useCallback((): void => {
    setState(null);
  }, []);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {state && <DialogShell state={state} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogShell({ state, onClose }: { state: DialogState; onClose: () => void }): JSX.Element {
  const [value, setValue] = useState<string>(
    state.kind === 'prompt' ? state.defaultValue ?? '' : '',
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      if (inputRef.current && 'select' in inputRef.current) inputRef.current.select?.();
    }, 30);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function cancel(): void {
    if (state.kind === 'prompt') state.resolve(null);
    else if (state.kind === 'confirm') state.resolve(false);
    else state.resolve();
    onClose();
  }

  function commit(): void {
    if (state.kind === 'prompt') {
      const trimmed = value.trim();
      if (state.validate) {
        const message = state.validate(trimmed);
        if (message) {
          setError(message);
          return;
        }
      }
      state.resolve(trimmed.length === 0 ? null : trimmed);
    } else if (state.kind === 'confirm') {
      state.resolve(true);
    } else {
      state.resolve();
    }
    onClose();
  }

  const tone: DialogTone =
    state.kind === 'confirm' ? state.tone ?? 'default' : 'default';

  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div
        className="modal app-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="app-dialog"
      >
        <div className="modal-head">
          <div className="title">{state.title}</div>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={cancel} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">
          {state.kind !== 'alert' && 'description' in state && state.description && (
            <p className="dialog-desc">{state.description}</p>
          )}
          {state.kind === 'alert' && state.description && (
            <p className="dialog-desc">{state.description}</p>
          )}
          {state.kind === 'prompt' && (
            <>
              {state.multiline ? (
                <textarea
                  ref={(node) => {
                    inputRef.current = node;
                  }}
                  value={value}
                  placeholder={state.placeholder}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (error) setError(null);
                  }}
                  rows={5}
                  className="dialog-input"
                  data-testid="app-dialog-input"
                />
              ) : (
                <input
                  ref={(node) => {
                    inputRef.current = node;
                  }}
                  value={value}
                  placeholder={state.placeholder}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commit();
                    }
                  }}
                  className="dialog-input"
                  data-testid="app-dialog-input"
                />
              )}
              {error && <p className="dialog-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          {state.kind !== 'alert' && (
            <button type="button" className="btn-quiet" onClick={cancel} data-testid="app-dialog-cancel">
              {('cancelLabel' in state && state.cancelLabel) || '取消'}
            </button>
          )}
          <button
            type="button"
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={commit}
            data-testid="app-dialog-ok"
          >
            {state.kind === 'alert'
              ? '知道了'
              : (('okLabel' in state && state.okLabel) || '确认')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}

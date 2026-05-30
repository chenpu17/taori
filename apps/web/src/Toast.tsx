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

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  ttl: number;
  bornAt: number;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => string;
  dismiss: (id: string) => void;
  info: (message: string) => string;
  success: (message: string) => string;
  warn: (message: string) => string;
  error: (message: string) => string;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_TTL: Record<ToastTone, number> = {
  info: 3500,
  success: 3000,
  warn: 5000,
  error: 6000,
};

const ICON: Record<ToastTone, Parameters<typeof Icon>[0]['name']> = {
  info: 'sparkle',
  success: 'check',
  warn: 'flame',
  error: 'close',
};

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);

  const dismiss = useCallback((id: string): void => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info'): string => {
      const id = `t_${Date.now()}_${seqRef.current++}`;
      const item: ToastItem = {
        id,
        message,
        tone,
        ttl: DEFAULT_TTL[tone],
        bornAt: Date.now(),
      };
      setItems((current) => [...current, item].slice(-5));
      return id;
    },
    [],
  );

  // Auto-dismiss
  useEffect(() => {
    if (items.length === 0) return;
    const timers = items.map((item) =>
      window.setTimeout(() => dismiss(item.id), item.ttl),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [items, dismiss]);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      info: (message) => show(message, 'info'),
      success: (message) => show(message, 'success'),
      warn: (message) => show(message, 'warn'),
      error: (message) => show(message, 'error'),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`toast toast-${item.tone}`}
            onClick={() => dismiss(item.id)}
            data-testid="toast-item"
          >
            <span className={`toast-icon toast-icon-${item.tone}`}>
              <Icon name={ICON[item.tone]} size={12} stroke={2.2} />
            </span>
            <span className="toast-body">{item.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

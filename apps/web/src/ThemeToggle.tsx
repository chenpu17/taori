/**
 * Theme switcher (light / system / dark).
 *
 * Persists the user's choice in localStorage under `taori.theme`.
 * The actual `data-theme` attribute is written to `<html>` so CSS selectors
 * can override the default light palette without a flash on reload —
 * `main.tsx` applies the persisted value before React mounts.
 *
 * "system" defers to `prefers-color-scheme`, which is also the default
 * for first-time users (matches the pre-existing behaviour).
 */

import { useEffect, useState, useCallback } from 'react';

export type ThemePreference = 'light' | 'system' | 'dark';

const STORAGE_KEY = 'taori.theme';
const DEFAULT_THEME: ThemePreference = 'system';

export function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
}

interface OptionDef {
  value: ThemePreference;
  label: string;
  icon: JSX.Element;
}

const OPTIONS: OptionDef[] = [
  {
    value: 'light',
    label: '浅色主题',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="5.2" y1="5.2" x2="6.9" y2="6.9" />
          <line x1="17.1" y1="17.1" x2="18.8" y2="18.8" />
          <line x1="5.2" y1="18.8" x2="6.9" y2="17.1" />
          <line x1="17.1" y1="6.9" x2="18.8" y2="5.2" />
        </g>
      </svg>
    ),
  },
  {
    value: 'system',
    label: '跟随系统',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <rect
          x="3"
          y="4.5"
          width="18"
          height="12"
          rx="1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <line x1="8.5" y1="20" x2="15.5" y2="20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <line x1="12" y1="16.5" x2="12" y2="20" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: '深色主题',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M20.5 14.2A8.2 8.2 0 1 1 9.8 3.5a6.6 6.6 0 0 0 10.7 10.7Z"
          fill="currentColor"
        />
      </svg>
    ),
  },
];

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<ThemePreference>(() => readStoredTheme());

  const setAndPersist = useCallback((next: ThemePreference): void => {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  // Sync if another tab/window changes the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY) return;
      const next =
        e.newValue === 'light' || e.newValue === 'dark' || e.newValue === 'system'
          ? e.newValue
          : DEFAULT_THEME;
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <div
      className="theme-toggle"
      role="radiogroup"
      aria-label="主题"
      data-testid="theme-toggle"
      data-theme-value={theme}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={theme === opt.value}
          aria-label={opt.label}
          title={opt.label}
          className={`theme-toggle__option ${theme === opt.value ? 'is-active' : ''}`}
          data-testid={`theme-toggle-${opt.value}`}
          onClick={() => setAndPersist(opt.value)}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

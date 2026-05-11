import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, readStoredTheme } from './ThemeToggle.js';
import './styles.css';
import './styles/markdown.css';

// Apply the persisted theme before React mounts so we don't flash the wrong
// palette on hard reload. The attribute drives the CSS variables in styles.css.
applyTheme(readStoredTheme());

if (typeof window !== 'undefined' && !window.__TAURI_INTERNALS__) {
  window.__TAORI_BROWSER_BOOTSTRAP__ = {
    url: window.location.origin,
    authMode: 'cookie',
  };
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

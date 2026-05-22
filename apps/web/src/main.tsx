import ReactDOM from 'react-dom/client';
import { App, ErrorBoundary } from './App';
import './styles/tokens.css';
import './styles/app.css';

// Standalone-browser cookie auth bootstrap (sidecar serves the SPA).
// Tauri runtime sets __TAURI_INTERNALS__ ahead of us; bearer-mode dev relies
// on VITE_SIDECAR_URL/BEARER from .env.local — both override this branch.
const env = (import.meta as ImportMeta & { env: Record<string, string> }).env;
if (typeof window !== 'undefined' && !window.__TAURI_INTERNALS__ && !env.VITE_SIDECAR_URL) {
  window.__TAORI_BROWSER_BOOTSTRAP__ = {
    url: window.location.origin,
    authMode: 'cookie',
  };
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

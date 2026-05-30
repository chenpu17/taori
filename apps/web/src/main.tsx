import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DialogProvider } from './Dialog';
import { ToastProvider } from './Toast';
import './styles/app.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root');
}

createRoot(root).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>,
);

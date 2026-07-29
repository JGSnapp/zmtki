import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './App';
import { ErrorBoundary, installGlobalErrorHandlers } from './components/ErrorBoundary';
import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';

installGlobalErrorHandlers();

const queryClient = new QueryClient();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

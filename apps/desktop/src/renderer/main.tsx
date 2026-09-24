import '@ferry/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createDemoFerryClient } from '@ferry/client';
import { FerryProvider } from './data/client';
import { AppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');

const client = createDemoFerryClient();
const mountApp = () => {
  createRoot(root).render(
    <StrictMode>
      <FerryProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <AppRouter />
        </QueryClientProvider>
      </FerryProvider>
    </StrictMode>,
  );
};
if (new URLSearchParams(location.search).get('demo') === 'long') {
  void import('./perf-demo').then(({ seedLongTranscript }) => {
    seedLongTranscript(client);
    mountApp();
  });
} else mountApp();

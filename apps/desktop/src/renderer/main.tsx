import '@ferry/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FerryProvider } from './data/client';
import { AppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');

void import('@ferry/client').then(async ({ createDemoFerryClient }) => {
  const client = createDemoFerryClient();
  if (new URLSearchParams(location.search).get('demo') === 'long') {
    const { seedLongTranscript } = await import('./perf-demo');
    seedLongTranscript(client);
  }
  createRoot(root).render(
    <StrictMode>
      <FerryProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <AppRouter />
        </QueryClientProvider>
      </FerryProvider>
    </StrictMode>,
  );
});

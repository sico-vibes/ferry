import '@ferry/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createDemoFerryClient, createHybridClient, createRpcFerryClient } from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import { FerryProvider } from './data/client';
import { AppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');

const speedParam = new URLSearchParams(location.search).get('speed');
const configuredSpeed = speedParam === null ? undefined : Number(speedParam);
const mock = createDemoFerryClient({
  ...(configuredSpeed !== undefined && Number.isFinite(configuredSpeed) && configuredSpeed >= 0
    ? { speed: configuredSpeed }
    : {}),
});
const bootstrapClient = async () => {
  if (!window.ferryHost) return mock;
  await window.ferryHost.connectCore();
  const rpc = createRpcFerryClient({
    send: (message) => window.ferryHost?.sendCore(message),
    subscribe: (handler) => window.ferryHost?.onCoreMessage(handler) ?? (() => undefined),
    reconnect: () =>
      window.ferryHost?.connectCore() ?? Promise.reject(new Error('Desktop host unavailable')),
    onClose: (handler) => window.ferryHost?.onEngineRestarting(handler) ?? (() => undefined),
    close: () => window.ferryHost?.closeCore(),
  });
  const hello = await rpc.hello;
  window.ferryEngineHello = hello;
  window.ferryRpcClient = rpc;
  const settings = await rpc.settings.get();
  const domains = [...new Set(settings.developer.realDomains)].filter((domain) =>
    hello.realDomains.includes(domain),
  );
  const hybrid = createHybridClient(mock, rpc, domains);
  window.ferryHybrid = hybrid;
  return hybrid;
};
const mountApp = (currentClient: FerryClient) => {
  createRoot(root).render(
    <StrictMode>
      <FerryProvider client={currentClient}>
        <QueryClientProvider client={queryClient}>
          <AppRouter />
        </QueryClientProvider>
      </FerryProvider>
    </StrictMode>,
  );
};
if (new URLSearchParams(location.search).get('demo') === 'long') {
  void import('./perf-demo').then(({ seedLongTranscript }) => {
    seedLongTranscript(mock);
    mountApp(mock);
  });
} else
  void bootstrapClient()
    .then((currentClient) => {
      mountApp(currentClient);
    })
    .catch((error: unknown) => {
      console.error('Core connection failed, continuing with mock client', error);
      mountApp(mock);
    });

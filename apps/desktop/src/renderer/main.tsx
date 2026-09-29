import '@ferry/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createDemoFerryClient,
  createHybridClient,
  createMessagePortTransport,
  createRpcFerryClient,
  createWebSocketRpcTransport,
} from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import { FERRY_DOMAINS } from '@ferry/shared';
import { FerryProvider } from './data/client';
import { AppRouter } from './router';
import { isExpectedCorePortOrigin } from '../shared/core-port-origin';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');
const appRoot = createRoot(root);

const speedParam = new URLSearchParams(location.search).get('speed');
const configuredSpeed = speedParam === null ? undefined : Number(speedParam);
const mock = createDemoFerryClient({
  ...(configuredSpeed !== undefined && Number.isFinite(configuredSpeed) && configuredSpeed >= 0
    ? { speed: configuredSpeed }
    : {}),
});
const connectCorePort = async (
  host: NonNullable<typeof window.ferryHost>,
): Promise<MessagePort> => {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Core MessagePort transfer timed out'));
    }, 12_000);
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window ||
        !isExpectedCorePortOrigin(location.protocol, event.origin, location.origin) ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== 'ferry:core-port' ||
        !('token' in event.data) ||
        event.data.token !== token
      )
        return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      const port = event.ports[0];
      if (!port) {
        reject(new Error('Core did not transfer a MessagePort'));
        return;
      }
      resolve(port);
    };
    window.addEventListener('message', onMessage);
  });
  await host.connectCore(token);
  return portPromise;
};
const bootstrapClient = async () => {
  let rpc: ReturnType<typeof createRpcFerryClient>;
  if (window.ferryHost) {
    const port = await connectCorePort(window.ferryHost);
    rpc = createRpcFerryClient(
      createMessagePortTransport(port, {
        reconnect: () => {
          const host = window.ferryHost;
          return host
            ? connectCorePort(host)
            : Promise.reject(new Error('Desktop host unavailable'));
        },
        onRestarting: (handler) =>
          window.ferryHost?.onEngineRestarting(handler) ?? (() => undefined),
      }),
    );
  } else {
    const e2eCoreUrl = new URLSearchParams(location.search).get('e2eCore');
    if (!e2eCoreUrl) return mock;
    window.ferryE2EMockClient = mock;
    rpc = createRpcFerryClient(createWebSocketRpcTransport(e2eCoreUrl));
  }
  const hello = await rpc.hello;
  window.ferryEngineHello = hello;
  const settings = await rpc.settings.get();
  const configuredDomains = settings.developer.realDomains;
  const domains = [
    ...new Set(configuredDomains.length ? configuredDomains : hello.realDomains),
  ].filter((domain) => hello.realDomains.includes(domain));
  const demoDomains = FERRY_DOMAINS.filter((domain) => !domains.includes(domain));
  if (window.ferryHost && demoDomains.length)
    console.warn(`Ferry is using mock data for domains: ${demoDomains.join(', ')}`);
  const hybrid = createHybridClient(mock, rpc, domains);
  window.ferryHybrid = hybrid;
  window.ferryRpcClient = rpc;
  return hybrid;
};
const mountApp = (currentClient: FerryClient) => {
  if (window.ferryHost && currentClient === mock)
    console.warn('Ferry is using the mock client because the core connection failed.');
  appRoot.render(
    <StrictMode>
      <FerryProvider client={currentClient}>
        <QueryClientProvider client={queryClient}>
          <AppRouter />
        </QueryClientProvider>
      </FerryProvider>
    </StrictMode>,
  );
};
const demoMode = new URLSearchParams(location.search).get('demo');
if (demoMode === 'long' || demoMode === 'exhausted') {
  void import('./perf-demo').then(({ seedExhaustedSession, seedLongTranscript }) => {
    if (demoMode === 'long') seedLongTranscript(mock);
    else seedExhaustedSession(mock);
    if (window.ferryHost) console.warn('Ferry is using the Demo client for the performance demo.');
    mountApp(mock);
  });
} else if (window.ferryHost) {
  mountApp(mock);
  void bootstrapClient()
    .then((currentClient) => {
      queryClient.clear();
      mountApp(currentClient);
    })
    .catch((error: unknown) => {
      console.error('Core connection failed, continuing with mock client', error);
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

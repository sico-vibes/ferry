import './theme-bootstrap';
import '@ferry/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createDemoFerryClient,
  createHybridClient,
  createRendererFerryClient,
  createMessagePortTransport,
  createRpcFerryClient,
  createWebSocketRpcTransport,
} from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import { FerryProvider } from './data/client';
import { AppRouter } from './router';
import { isExpectedCorePortOrigin } from '../shared/core-port-origin';
import './styles.css';
import './polish.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false } },
});
const refreshSessionQueries = () => {
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  void queryClient.invalidateQueries({ queryKey: ['session'] });
};
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');
const appRoot = createRoot(root);

const speedParam = new URLSearchParams(location.search).get('speed');
const configuredSpeed = speedParam === null ? undefined : Number(speedParam);
const previewParams = new URLSearchParams(location.search);
const webPreview =
  import.meta.env.DEV &&
  (previewParams.get('preview') === 'web' || ['5199', '5211'].includes(location.port));
const previewScenario = previewParams.get('scenario') ?? 'busy';
// `?latency=1500` slows every mock call in the web preview so loading states can be reviewed.
const previewLatency = webPreview ? Number(previewParams.get('latency') ?? Number.NaN) : Number.NaN;
const mock = createDemoFerryClient({
  ...(webPreview ? { storage: { load: () => undefined, save: () => undefined } } : {}),
  ...(Number.isFinite(previewLatency) && previewLatency > 0 ? { latencyMs: previewLatency } : {}),
  ...(configuredSpeed !== undefined && Number.isFinite(configuredSpeed) && configuredSpeed >= 0
    ? { speed: configuredSpeed }
    : {}),
});
let coreConnectionAttempt = 0;
let rpcClientSequence = 0;
const connectCorePort = async (
  host: NonNullable<typeof window.ferryHost>,
  clientId: string,
): Promise<import('@ferry/client').MessagePortConnection> => {
  const attempt = ++coreConnectionAttempt;
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const portPromise = new Promise<import('@ferry/client').MessagePortConnection>(
    (resolve, reject) => {
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
          event.data.type !== 'ferry:core-port'
        )
          return;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        const port = event.ports[0];
        if (!port) {
          reject(new Error('Core did not transfer a MessagePort'));
          return;
        }
        const portId =
          'portId' in event.data && typeof event.data.portId === 'string'
            ? event.data.portId
            : `renderer-${String(attempt)}`;
        if (host.e2eDiagnosticsEnabled)
          console.info(
            `FERRY_RENDERER_PORT_RECEIVED ${JSON.stringify({ clientId, attempt, portId, origin: event.origin })}`,
          );
        resolve({ port, portId });
      };
      window.addEventListener('message', onMessage);
    },
  );
  if (host.e2eDiagnosticsEnabled)
    console.info(`FERRY_RENDERER_CONNECT_START ${JSON.stringify({ clientId, attempt })}`);
  await host.connectCore(token);
  return portPromise;
};
const bootstrapClient = async () => {
  let rpc: ReturnType<typeof createRpcFerryClient>;
  if (window.ferryHost) {
    const host = window.ferryHost;
    host.onEngineConnected(refreshSessionQueries);
    const rpcClientId = `desktop-rpc-${String(++rpcClientSequence)}`;
    const port = await connectCorePort(host, rpcClientId);
    rpc = createRpcFerryClient(
      createMessagePortTransport(port, {
        reconnect: () => {
          const host = window.ferryHost;
          if (!host) return Promise.reject(new Error('Desktop host unavailable'));
          // Attaching the port is what starts the replacement utility process.
          return connectCorePort(host, rpcClientId);
        },
        onRestarting: (handler) =>
          window.ferryHost?.onEngineRestarting(handler) ?? (() => undefined),
        onReconnected: () => {
          void queryClient.invalidateQueries();
        },
        ...(window.ferryHost.e2eDiagnosticsEnabled
          ? {
              onDiagnostic: (diagnostic) => {
                console.info(
                  `FERRY_RPC ${JSON.stringify({ clientId: rpcClientId, ...diagnostic })}`,
                );
              },
            }
          : {}),
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
  window.ferryRpcClient = rpc;
  if (window.ferryHost) return createRendererFerryClient(mock, rpc, true, hello.realDomains);
  const settings = await rpc.settings.get();
  const domains = [
    ...new Set(
      settings.developer.realDomains.length ? settings.developer.realDomains : hello.realDomains,
    ),
  ].filter((domain) => hello.realDomains.includes(domain));
  const client = createRendererFerryClient(mock, rpc, false, domains);
  window.ferryHybrid = createHybridClient(mock, rpc, domains);
  return client;
};
const mountApp = (currentClient: FerryClient) => {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('perf-render'))
    window.ferryPerfClient = currentClient;
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
const showEngineConnectionError = (error: unknown) => {
  console.error('Core connection failed; the desktop app will not use mock data', error);
  appRoot.render(
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <section className="max-w-lg space-y-3">
        <h1 className="text-xl font-semibold">Ferry core could not start</h1>
        <p className="text-muted-foreground">
          Restart the Ferry app. Your workspace data is safe, and Ferry will reconnect to its local
          engine when it starts successfully.
        </p>
      </section>
    </main>,
  );
};
const demoMode = new URLSearchParams(location.search).get('demo');
if (
  !window.ferryHost &&
  (demoMode === 'long' || demoMode === 'exhausted' || demoMode === 'explore-perf')
) {
  void import('./perf-demo').then(
    ({ seedExhaustedSession, seedLongTranscript, seedExploreModels }) => {
      if (demoMode === 'long') seedLongTranscript(mock);
      else if (demoMode === 'exhausted') seedExhaustedSession(mock);
      else seedExploreModels(mock);
      if (window.ferryHost)
        console.warn('Ferry is using the Demo client for the performance demo.');
      mountApp(mock);
    },
  );
} else if (webPreview) {
  void import('./web-preview').then(async ({ seedWebPreview }) => {
    await seedWebPreview(mock, previewScenario);
    mountApp(mock);
  });
} else if (window.ferryHost) {
  void bootstrapClient()
    .then((currentClient) => {
      queryClient.clear();
      mountApp(currentClient);
    })
    .catch(showEngineConnectionError);
} else if (location.protocol === 'file:') {
  showEngineConnectionError(new Error('The desktop preload bridge is unavailable'));
} else
  void bootstrapClient()
    .then((currentClient) => {
      mountApp(currentClient);
    })
    .catch((error: unknown) => {
      console.error('Core connection failed, continuing with mock client', error);
      mountApp(mock);
    });

import type { MessagePortMain } from 'electron';
import { join } from 'node:path';
import { createCoreHost, runNativeSelfTest } from '@ferry/core';

let activePort: MessagePortMain | undefined;
let inputHandler: ((message: unknown) => void) | undefined;
let host: Awaited<ReturnType<typeof createCoreHost>> | undefined;
const pendingMessages: unknown[] = [];
const parentPort = process.parentPort;
parentPort.on('message', (event) => {
  const port = event.ports[0];
  if (!port) return;
  activePort?.close();
  activePort = port;
  port.on('message', (messageEvent) => {
    if (inputHandler) inputHandler(messageEvent.data);
    else pendingMessages.push(messageEvent.data);
  });
  port.start();
  const ready = host
    ? Promise.resolve(host)
    : createCoreHost({
        dataDir: process.env.FERRY_CORE_DATA_DIR ?? join(process.cwd(), 'engine'),
        selfTest: runNativeSelfTest,
        websocketEnabled: process.env.FERRY_E2E_WEBSOCKET === '1',
        transport: {
          send(message) {
            activePort?.postMessage(message);
          },
          subscribe(handler) {
            inputHandler = handler;
            while (pendingMessages.length) {
              const message = pendingMessages.shift();
              if (message !== undefined) inputHandler(message);
            }
            return () => {
              inputHandler = undefined;
            };
          },
        },
      }).then((created) => {
        host = created;
        return created;
      });
  void ready
    .then((runningHost) => {
      runningHost.options.services?.logger.info(
        { dataDir: runningHost.dataDir },
        'Ferry core started',
      );
      port.postMessage({
        jsonrpc: '2.0',
        method: 'system.coreReady',
        params: { pid: process.pid },
      });
      parentPort.postMessage({
        type: 'ferry:core-ready',
        pid: process.pid,
        selfTest: runNativeSelfTest(),
        realDomains: runningHost.realDomains,
        dataDir: runningHost.dataDir,
        websocketUrl: runningHost.websocket?.url,
      });
    })
    .catch((error: unknown) => {
      console.error('FERRY_CORE_ERROR', error);
      port.postMessage({
        jsonrpc: '2.0',
        method: 'system.coreError',
        params: { message: error instanceof Error ? error.message : String(error) },
      });
      process.exit(1);
    });
});

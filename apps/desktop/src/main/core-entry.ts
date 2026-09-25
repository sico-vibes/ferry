import type { MessagePortMain } from 'electron';
import { join } from 'node:path';
import { CoreHost, runNativeSelfTest } from '@ferry/core';

let activePort: MessagePortMain | undefined;
let inputHandler: ((message: unknown) => void) | undefined;
let started = false;
const pendingMessages: unknown[] = [];
const host = new CoreHost({
  dataDir: process.env.FERRY_CORE_DATA_DIR ?? join(process.cwd(), 'engine'),
  selfTest: runNativeSelfTest,
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
});
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
  const ready = started
    ? Promise.resolve()
    : host.start().then(() => {
        started = true;
      });
  void ready
    .then(() => {
      port.postMessage({
        jsonrpc: '2.0',
        method: 'system.coreReady',
        params: { pid: process.pid },
      });
      parentPort.postMessage({
        type: 'ferry:core-ready',
        pid: process.pid,
        selfTest: runNativeSelfTest(),
      });
    })
    .catch((error: unknown) => {
      port.postMessage({
        jsonrpc: '2.0',
        method: 'system.coreError',
        params: { message: error instanceof Error ? error.message : String(error) },
      });
      process.exit(1);
    });
});

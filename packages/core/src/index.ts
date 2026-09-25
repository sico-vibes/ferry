export const PACKAGE = '@ferry/core';
export {
  CoreHost,
  CoreLockError,
  createMemoryTransportPair,
  createStdioTransport,
  mapError,
  readLockInfo,
  serveStdio,
} from './host.js';
export type { CoreOptions, CoreTransport, RpcHandler } from './host.js';
export { runNativeSelfTest } from './native-self-test.js';
export { startCoreWebSocketServer } from './websocket.js';
export type { CoreWebSocketHandle } from './websocket.js';

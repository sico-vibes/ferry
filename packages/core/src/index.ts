export const PACKAGE = '@ferry/core';
export {
  CoreHost,
  CoreLockError,
  createMemoryTransportPair,
  createStdioTransport,
  createCoreHost,
  mapError,
  readLockInfo,
  rpcDomainError,
  serveStdio,
} from './host.js';
export type { CoreOptions, CoreTransport, RpcHandler } from './host.js';
export { runNativeSelfTest } from './native-self-test.js';
export { createServices } from './services.js';
export { createGatewayController } from './gateway.js';
export type { FerryClock, FerryServices, ServiceOptions } from './services.js';
export { domainRegistrars } from './domains/index.js';
export { startCoreWebSocketServer } from './websocket.js';
export type { CoreWebSocketHandle } from './websocket.js';
export {
  connectLocalControl,
  getLocalControlStatus,
  hasLocalControlEndpoint,
} from './local-control.js';
export type { LocalControlStatus } from './local-control.js';
export {
  isCoreWindowActive,
  onCoreWindowActiveChange,
  setCoreWindowActive,
} from './runtime-activity.js';

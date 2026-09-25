export {};
declare global {
  interface Window {
    ferryHost?: {
      platform: string;
      versions: { app: string; electron: string };
      realDomainsFromEnvironment(): string[];
      openFolder(): Promise<string | null>;
      updateTheme(theme: 'dark' | 'light'): void;
      connectCore(): Promise<void>;
      sendCore(message: unknown): void;
      onCoreMessage(handler: (message: unknown) => void): () => void;
      closeCore(): void;
      getEngineStatus(): Promise<{ status: 'connected' | 'restarting'; pid: number | null }>;
      onEngineRestarting(handler: () => void): () => void;
      onEngineConnected(handler: () => void): () => void;
    };
    ferryPerfFrameTimes?: number[];
    ferryHybrid?: import('@ferry/client').HybridFerryClient;
    ferryEngineHello?: import('@ferry/shared').HelloResult;
    ferryRpcClient?: import('@ferry/client').RpcFerryClient;
  }
}

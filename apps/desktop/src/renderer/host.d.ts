export {};
declare global {
  interface Window {
    ferryHost?: {
      platform: string;
      versions: { app: string; electron: string };
      channel: string;
      commit: string;
      e2eDiagnosticsEnabled?: boolean;
      realDomainsFromEnvironment(): string[];
      openFolder(): Promise<string | null>;
      getUpdateState(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      checkForUpdates(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      setAutoDownload(enabled: boolean): Promise<import('../main/update-state.js').UpdateSnapshot>;
      installUpdate(): Promise<void>;
      downloadUpdate(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      onUpdateState(
        handler: (state: import('../main/update-state.js').UpdateSnapshot) => void,
      ): () => void;
      onOpenWorkspace(handler: (path: string) => void): () => void;
      updateTheme(theme: 'dark' | 'light'): void;
      connectCore(token: string): Promise<void>;
      getEngineStatus(): Promise<{ status: 'connected' | 'restarting'; pid?: number | null }>;
      onEngineRestarting(handler: () => void): () => void;
      onEngineConnected(handler: () => void): () => void;
    };
    ferryPerfFrameTimes?: number[];
    ferryPerfMessageCount?: number;
    ferryPerfReady?: boolean;
    ferryPerfModelCount?: number;
    ferryHybrid?: import('@ferry/client').HybridFerryClient;
    ferryEngineHello?: import('@ferry/shared').HelloResult;
    ferryRpcClient?: import('@ferry/client').RpcFerryClient;
    ferryE2EMockClient?: import('@ferry/client').FerryClient;
  }
}

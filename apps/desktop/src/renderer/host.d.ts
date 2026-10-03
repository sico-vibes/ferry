export {};
declare global {
  interface Window {
    ferryHost?: {
      platform: string;
      displayName: string;
      versions: { app: string; electron: string };
      getAppInfo(): Promise<{ version: string; dataDir: string }>;
      channel: string;
      commit: string;
      e2eDiagnosticsEnabled?: boolean;
      realDomainsFromEnvironment(): string[];
      openFolder(): Promise<string | null>;
      openHelp(): Promise<void>;
      revealDataFolder(path: string): Promise<void>;
      readKeybindings(): Promise<{ path: string; content: string; error: string | null }>;
      writeKeybindings(
        content: string,
      ): Promise<{ path: string; content: string; error: string | null }>;
      onKeybindingsChanged(
        handler: (value: { path: string; content: string; error: string | null }) => void,
      ): () => void;
      getUpdateState(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      checkForUpdates(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      setAutoDownload(enabled: boolean): Promise<import('../main/update-state.js').UpdateSnapshot>;
      installUpdate(): Promise<void>;
      downloadUpdate(): Promise<import('../main/update-state.js').UpdateSnapshot>;
      onUpdateState(
        handler: (state: import('../main/update-state.js').UpdateSnapshot) => void,
      ): () => void;
      onOpenWorkspace(handler: (path: string) => void): () => void;
      isWindowBackgrounded(): boolean;
      onWindowBackground(handler: (backgrounded: boolean) => void): () => void;
      getProcessMetrics(): Promise<
        { role: string; pid: number; rssBytes: number; cpuPercent: number }[]
      >;
      updateTheme(theme: 'dark' | 'light'): void;
      connectCore(token: string): Promise<void>;
      getEngineStatus(): Promise<{ status: 'connected' | 'restarting'; pid?: number | null }>;
      onEngineRestarting(handler: () => void): () => void;
      onEngineConnected(handler: () => void): () => void;
    };
    ferryPerfFrameTimes?: number[];
    ferryPerfMessageCount?: number;
    ferryPerfReady?: boolean;
    ferryPerfRenderCounts?: Record<string, number>;
    ferryPerfClient?: import('@ferry/client').FerryClient;
    ferryPerfNavigate?: (path: string) => Promise<unknown>;
    ferryPerfModelCount?: number;
    ferryHybrid?: import('@ferry/client').HybridFerryClient;
    ferryEngineHello?: import('@ferry/shared').HelloResult;
    ferryRpcClient?: import('@ferry/client').RpcFerryClient;
    ferryE2EMockClient?: import('@ferry/client').FerryClient;
  }
}

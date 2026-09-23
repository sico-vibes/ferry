export {};
declare global {
  interface Window {
    ferryHost?: {
      platform: string;
      versions: { app: string; electron: string };
      openFolder(): Promise<string | null>;
    };
  }
}
